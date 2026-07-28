#[cfg(windows)]
pub(crate) mod job;
pub(crate) mod path_probe;
pub mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use uuid::Uuid;

pub use session::PtyEvent;
use session::Session;

use crate::modules::pty_daemon::client::PtyClient;
use crate::modules::pty_daemon::protocol::SessionInfo;

/// Two-mode PTY backend. The daemon mode (default) routes every operation
/// through the sidecar process so sessions outlive the GUI window. The
/// in-process mode is the legacy path retained as a fallback when the
/// daemon refuses to spawn (rare; we log loudly when it happens).
///
/// The decision is made once at startup in `PtyState::new`. We do not
/// switch mid-flight - mixing live sessions across modes would let the
/// numeric id `1` map to two different shells depending on backend, which
/// is the kind of confusion no error message can untangle.
/// Holds the daemon client behind a swap-on-death indirection. The daemon is
/// a separate process that can die (crash, idle-shutdown, an OOM, or the
/// pre-fix pty-race abort) while the GUI keeps running. The GUI opens ONE
/// persistent connection at startup, so before this holder a single daemon
/// death set the client's `alive=false` forever and every subsequent pty op
/// (every new tab, every retry) returned "daemon connection dropped" until the
/// whole app was restarted - the recurring crash the user hit when spam-opening
/// tabs or running the remote-access agent as a 2nd daemon client.
///
/// `get_live` swaps in a freshly reconnected client (respawning the daemon if
/// it is gone) the next time the backend needs one, so a daemon death becomes a
/// one-op hiccup that self-heals instead of a restart-required wedge.
struct DaemonClientHolder {
    inner: RwLock<Arc<PtyClient>>,
    /// Serializes reconnects. Held across the slow `connect_or_spawn` INSTEAD of
    /// `inner`'s write lock, so a concurrent `current()` read on the UI thread
    /// never blocks behind a ~5s daemon respawn - `inner.write()` is taken only
    /// for the microsecond Arc swap at the end.
    reconnecting: Mutex<()>,
}

impl DaemonClientHolder {
    fn new(client: PtyClient) -> Self {
        Self {
            inner: RwLock::new(Arc::new(client)),
            reconnecting: Mutex::new(()),
        }
    }

    /// The current client without reconnecting. Used by write/resize/close,
    /// where reconnecting is pointless: those target an EXISTING session id,
    /// which a freshly respawned daemon would not know. They just surface the
    /// dropped-connection error (logged + swallowed by the caller). Only ever
    /// contends with the microsecond Arc swap in `get_live`, so it never stalls
    /// the sync (UI-thread) command path.
    fn current(&self) -> Arc<PtyClient> {
        self.inner.read().unwrap().clone()
    }

    /// A live client, reconnecting (and respawning the daemon if it died) when
    /// the current connection is dead. The `reconnecting` mutex + re-check means
    /// many callers that all observe a dead client reconnect exactly once - the
    /// rest reuse the fresh connection.
    ///
    /// BLOCKS on the reconnect path (`connect_or_spawn` polls a respawned daemon
    /// for up to ~5s), so it must run on the blocking pool, never the async
    /// executor or the WebView2 UI thread. Every caller invokes it from inside
    /// `spawn_blocking`.
    fn get_live(&self) -> Arc<PtyClient> {
        {
            let c = self.inner.read().unwrap();
            if c.is_alive() {
                return c.clone();
            }
        }
        // Serialize the reconnect on a dedicated mutex, NOT `inner`'s write lock,
        // so `current()` readers stay non-blocking through the slow respawn.
        let _guard = self.reconnecting.lock().unwrap();
        // Re-check: a caller that held `reconnecting` before us may already have
        // swapped in a live client.
        {
            let c = self.inner.read().unwrap();
            if c.is_alive() {
                return c.clone();
            }
        }
        match PtyClient::connect_or_spawn() {
            Ok(fresh) => {
                let fresh = Arc::new(fresh);
                // Brief write lock: just the pointer swap.
                *self.inner.write().unwrap() = fresh.clone();
                log::info!("pty daemon connection was dead; reconnected to a fresh daemon");
                fresh
            }
            Err(e) => {
                // Reconnect failed - hand back the dead client so the caller
                // still returns a clear "daemon connection dropped" rather than
                // silently succeeding. The next op retries the reconnect.
                log::error!("pty daemon reconnect failed: {e}");
                self.inner.read().unwrap().clone()
            }
        }
    }
}

enum PtyBackend {
    Daemon {
        client: Arc<DaemonClientHolder>,
        /// Local numeric id ↔ remote UUID. Numeric ids stay stable for the
        /// life of the GUI process; the UUID is what the daemon and disk
        /// (workspace serialization) use.
        sessions: RwLock<HashMap<u32, Uuid>>,
    },
    InProcess(RwLock<HashMap<u32, Arc<Session>>>),
}

pub struct PtyState {
    backend: PtyBackend,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl PtyState {
    /// Try to bring the daemon up. On failure, fall back to in-process
    /// (logging an error so the operator can tell sessions won't persist).
    /// Never returns Err: a broken daemon is a degraded mode, not a fatal
    /// startup error.
    pub fn new() -> Self {
        match PtyClient::connect_or_spawn() {
            Ok(client) => {
                log::info!("pty backend: daemon");
                Self {
                    backend: PtyBackend::Daemon {
                        client: Arc::new(DaemonClientHolder::new(client)),
                        sessions: RwLock::new(HashMap::new()),
                    },
                    next_id: AtomicU32::new(1),
                }
            }
            Err(e) => {
                log::error!("pty daemon unavailable, falling back to in-process: {e}");
                Self {
                    backend: PtyBackend::InProcess(RwLock::new(HashMap::new())),
                    next_id: AtomicU32::new(1),
                }
            }
        }
    }
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new()
    }
}

/// Returned by `pty_open` and `pty_attach`. Frontend uses `id` for
/// subsequent write/resize/close calls (legacy numeric handle), and
/// `sessionId` for persistence across GUI restarts (daemon mode only -
/// empty string when running in-process).
///
/// `alive` is always true for a fresh `pty_open`. For `pty_attach` it
/// reflects whether the daemon's underlying shell is still running: the
/// daemon keeps a session around after its shell exits (so a detached GUI
/// can still read the final scrollback), and a reattach to such a session
/// would only replay frozen output into a pane that can't accept input.
/// The frontend uses this to respawn a fresh shell instead of presenting a
/// dead pane on workspace restore.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenResult {
    pub id: u32,
    pub session_id: String,
    pub alive: bool,
}

/// Open a fresh PTY. Async + `spawn_blocking` (not a plain sync command)
/// because the backend spawn blocks: the daemon round-trip waits for the
/// sidecar to create a ConPTY and start pwsh, and the in-process path does
/// that inline. A sync
/// Tauri command runs on the WebView2 UI thread on Windows, so a spawn that
/// takes seconds would freeze the UI AND serialize every other pending
/// `pty_open` behind it on that one thread - which is exactly how several
/// tabs opening at once (or a workspace restore) pile up past the frontend's
/// 15s spawn timeout and surface "shell did not start within 15s". Offloading
/// to the blocking pool lets opens run concurrently and keeps the UI thread
/// pumping. Mirrors `pty_list_sessions`.
#[tauri::command]
pub async fn pty_open(
    state: tauri::State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<PtyOpenResult, String> {
    let t0 = std::time::Instant::now();
    log::info!(
        "pty_open invoke cols={cols} rows={rows} cwd={}",
        cwd.as_deref().unwrap_or("-")
    );
    // Clone the daemon client (or note in-process) so the `&state.backend`
    // borrow is released before the `.await` - a borrow into `state` may not
    // be held across the suspend point.
    let client = match &state.backend {
        PtyBackend::Daemon { client, .. } => Some(client.clone()),
        PtyBackend::InProcess(_) => None,
    };
    if let Some(client) = client {
        let uuid = tauri::async_runtime::spawn_blocking(move || {
            // get_live reconnects (respawning the daemon) if it died since the
            // last op, so opening a new tab self-heals a dropped connection
            // instead of erroring until the app restarts.
            client.get_live().open(cols, rows, cwd, on_event)
        })
        .await
        .map_err(|e| format!("pty_open join error: {e}"))?
        .map_err(|e| {
            log::error!(
                "pty_open daemon failed after {}ms: {e}",
                t0.elapsed().as_millis()
            );
            e
        })?;
        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        if let PtyBackend::Daemon { sessions, .. } = &state.backend {
            sessions.write().unwrap().insert(id, uuid);
        }
        log::info!(
            "pty opened id={id} uuid={uuid} cols={cols} rows={rows} setup={}ms",
            t0.elapsed().as_millis()
        );
        Ok(PtyOpenResult {
            id,
            session_id: uuid.to_string(),
            alive: true,
        })
    } else {
        let (session, _) =
            tauri::async_runtime::spawn_blocking(move || session::spawn(cols, rows, cwd, on_event))
                .await
                .map_err(|e| format!("pty_open join error: {e}"))?
                .map_err(|e| {
                    log::error!("pty_open failed after {}ms: {e}", t0.elapsed().as_millis());
                    e
                })?;
        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        if let PtyBackend::InProcess(map) = &state.backend {
            map.write().unwrap().insert(id, session);
        }
        log::info!(
            "pty opened id={id} cols={cols} rows={rows} setup={}ms (in-process)",
            t0.elapsed().as_millis()
        );
        // Empty sessionId signals to the frontend that this session
        // is non-persistable (will respawn fresh on next launch).
        Ok(PtyOpenResult {
            id,
            session_id: String::new(),
            alive: true,
        })
    }
}

/// Re-attach to an existing daemon session by UUID. Replays the daemon's
/// scrollback buffer to the supplied channel before live events resume.
/// Returns an error when the backend is in-process (no sessions to attach
/// to) or when the daemon does not know the requested UUID (e.g. lost to
/// a daemon crash since the workspace was saved).
/// Async + `spawn_blocking` for the same reason as `pty_open`: the daemon
/// attach round-trip (replaying up to ~1.25 MiB of scrollback) must not block
/// the WebView2 UI thread, or a multi-tab workspace restore serializes every
/// reattach on that one thread and trips the frontend's 15s spawn timeout.
#[tauri::command]
pub async fn pty_attach(
    state: tauri::State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<PtyOpenResult, String> {
    // Clone the client so the `&state.backend` borrow ends before the `.await`.
    let client = match &state.backend {
        PtyBackend::Daemon { client, .. } => client.clone(),
        PtyBackend::InProcess(_) => return Err("pty_attach requires daemon backend".into()),
    };
    let uuid: Uuid = session_id
        .parse()
        .map_err(|e| format!("invalid session_id: {e}"))?;
    let alive = tauri::async_runtime::spawn_blocking(move || {
        client.get_live().attach(uuid, cols, rows, on_event)
    })
    .await
    .map_err(|e| format!("pty_attach join error: {e}"))??;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    if let PtyBackend::Daemon { sessions, .. } = &state.backend {
        sessions.write().unwrap().insert(id, uuid);
    }
    log::info!("pty attached id={id} uuid={uuid} alive={alive}");
    Ok(PtyOpenResult {
        id,
        session_id: uuid.to_string(),
        alive,
    })
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    match &state.backend {
        PtyBackend::Daemon { client, sessions } => {
            let uuid = sessions.read().unwrap().get(&id).copied().ok_or_else(|| {
                log::warn!("pty_write: unknown id={id}");
                "no session".to_string()
            })?;
            client
                .current()
                .write(uuid, B64.encode(data.as_bytes()))
                .map_err(|e| {
                    log::debug!("pty_write id={id} failed: {e}");
                    e
                })
        }
        PtyBackend::InProcess(map) => {
            let session = map.read().unwrap().get(&id).cloned().ok_or_else(|| {
                log::warn!("pty_write: unknown id={id}");
                "no session".to_string()
            })?;
            // Bind to a local so the MutexGuard temporary drops before
            // `session` - see rustc note on tail-expr drop order.
            let result = session
                .writer
                .lock()
                .unwrap()
                .write_all(data.as_bytes())
                .map_err(|e| {
                    // EPIPE is expected if the child already exited.
                    log::debug!("pty_write id={id} failed: {e}");
                    e.to_string()
                });
            result
        }
    }
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    match &state.backend {
        PtyBackend::Daemon { client, sessions } => {
            let uuid = sessions.read().unwrap().get(&id).copied().ok_or_else(|| {
                log::warn!("pty_resize: unknown id={id}");
                "no session".to_string()
            })?;
            client.current().resize(uuid, cols, rows).map_err(|e| {
                log::warn!("pty_resize id={id} failed: {e}");
                e
            })
        }
        PtyBackend::InProcess(map) => {
            let session = map.read().unwrap().get(&id).cloned().ok_or_else(|| {
                log::warn!("pty_resize: unknown id={id}");
                "no session".to_string()
            })?;
            let master = session.master.lock().unwrap();
            let result = master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| {
                    log::warn!("pty_resize id={id} failed: {e}");
                    e.to_string()
                });
            drop(master);
            result
        }
    }
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    match &state.backend {
        PtyBackend::Daemon { client, sessions } => {
            let uuid = sessions.write().unwrap().remove(&id);
            if let Some(u) = uuid {
                if let Err(e) = client.current().close(u) {
                    log::debug!("pty_close: daemon close id={id} uuid={u} returned {e}");
                }
                log::info!("pty closed id={id} uuid={u}");
            }
            Ok(())
        }
        PtyBackend::InProcess(map) => {
            let session = map.write().unwrap().remove(&id);
            if let Some(s) = session {
                // Kill the whole child tree synchronously, not just the shell
                // leader (portable-pty's Windows kill hits only the leader). See
                // `Session::kill_tree`.
                s.kill_tree();
                log::info!("pty closed id={id}");
                // Drop the Arc on a detached thread. On Windows
                // `MasterPty`'s Drop calls `ClosePseudoConsole`, which can
                // block until conhost finishes draining its output. Doing
                // it here would freeze the Tauri worker thread - and on
                // Windows that sometimes manifests as the closed pane
                // refusing to disappear from the React tree because
                // subsequent IPC stalls behind it.
                if let Err(spawn_err) = thread::Builder::new()
                    .name(format!("tedi-pty-drop-{id}"))
                    .spawn({
                        let s = s.clone();
                        move || {
                            let t0 = std::time::Instant::now();
                            // Goes through `drop_session` so
                            // ClosePseudoConsole holds `SPAWN_LOCK` and can't
                            // corrupt a sibling spawn's ConPTY. See blank-pane
                            // note in `session.rs` next to `SPAWN_LOCK`.
                            session::drop_session(s);
                            log::info!(
                                "pty session id={id} dropped in {}ms",
                                t0.elapsed().as_millis()
                            );
                        }
                    })
                {
                    // Thread/FD exhaustion: drop inline rather than panicking
                    // and tearing down the GUI. This may briefly block the
                    // Tauri worker on Windows' ClosePseudoConsole, but a
                    // brief stall beats a crash.
                    log::warn!(
                        "could not spawn pty-drop thread (running drop inline): {spawn_err}"
                    );
                    let t0 = std::time::Instant::now();
                    session::drop_session(s);
                    log::info!(
                        "pty session id={id} dropped inline in {}ms",
                        t0.elapsed().as_millis()
                    );
                }
            } else {
                log::debug!("pty_close: unknown id={id}");
            }
            Ok(())
        }
    }
}

/// Enumerate sessions currently owned by the daemon. Used by the GUI's
/// "Settings → Sessions" panel and by the workspace-restore code path to
/// confirm a saved `ptyId` is still alive before calling `pty_attach`.
#[tauri::command]
pub async fn pty_list_sessions(
    state: tauri::State<'_, PtyState>,
) -> Result<Vec<SessionInfo>, String> {
    // `client.list()` is a blocking daemon round-trip bounded by a 30s request
    // timeout. The remote-access adopt poll calls this every ~2s, and on Windows
    // a sync command runs on the WebView2 UI thread - a slow or hung daemon would
    // freeze the whole app for up to 30s. Clone the Arc'd client and run the
    // round-trip on the blocking pool so the UI thread keeps pumping.
    let client = match &state.backend {
        PtyBackend::Daemon { client, .. } => client.clone(),
        PtyBackend::InProcess(_) => return Ok(Vec::new()),
    };
    // get_live here means the remote-access adopt poll (~2s) auto-reconnects a
    // dead daemon in the background, so a dropped connection often heals before
    // the user even opens the next tab.
    tauri::async_runtime::spawn_blocking(move || client.get_live().list())
        .await
        .map_err(|e| format!("pty_list_sessions join error: {e}"))?
}

/// Kill every daemon-owned session. Backs the quit prompt's "Close all
/// terminals" choice. No-op in in-process mode (caller can just close tabs).
/// Async + `spawn_blocking` for the same reason as `pty_list_sessions`: the
/// kill is a blocking daemon round-trip and must not run on the UI thread.
/// Uses `current()` (not `get_live()`): if the daemon is already gone its
/// sessions died with it, so respawning one just to kill nothing would stall
/// the quit path for ~5s.
#[tauri::command]
pub async fn pty_kill_all(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let PtyBackend::Daemon { client, sessions } = &state.backend else {
        return Ok(());
    };
    let client = client.current();
    sessions.write().unwrap().clear();
    tauri::async_runtime::spawn_blocking(move || client.kill_all())
        .await
        .map_err(|e| format!("pty_kill_all join error: {e}"))?
}
