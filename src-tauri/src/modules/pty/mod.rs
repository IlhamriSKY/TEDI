#[cfg(windows)]
pub(crate) mod job;
pub(crate) mod path_probe;
pub mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
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
enum PtyBackend {
    Daemon {
        client: Arc<PtyClient>,
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
                        client: Arc::new(client),
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

    /// True when the backend is the persistent daemon. The frontend uses
    /// this to decide whether to persist `ptyId` for restore.
    pub fn is_daemon(&self) -> bool {
        matches!(self.backend, PtyBackend::Daemon { .. })
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

#[tauri::command]
pub fn pty_open(
    state: tauri::State<PtyState>,
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
    match &state.backend {
        PtyBackend::Daemon { client, sessions } => {
            let uuid = client.open(cols, rows, cwd, on_event).map_err(|e| {
                log::error!(
                    "pty_open daemon failed after {}ms: {e}",
                    t0.elapsed().as_millis()
                );
                e
            })?;
            let id = state.next_id.fetch_add(1, Ordering::Relaxed);
            sessions.write().unwrap().insert(id, uuid);
            log::info!(
                "pty opened id={id} uuid={uuid} cols={cols} rows={rows} setup={}ms",
                t0.elapsed().as_millis()
            );
            Ok(PtyOpenResult {
                id,
                session_id: uuid.to_string(),
                alive: true,
            })
        }
        PtyBackend::InProcess(map) => {
            let (session, _) = session::spawn(cols, rows, cwd, on_event).map_err(|e| {
                log::error!("pty_open failed after {}ms: {e}", t0.elapsed().as_millis());
                e
            })?;
            let id = state.next_id.fetch_add(1, Ordering::Relaxed);
            map.write().unwrap().insert(id, session);
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
}

/// Re-attach to an existing daemon session by UUID. Replays the daemon's
/// scrollback buffer to the supplied channel before live events resume.
/// Returns an error when the backend is in-process (no sessions to attach
/// to) or when the daemon does not know the requested UUID (e.g. lost to
/// a daemon crash since the workspace was saved).
#[tauri::command]
pub fn pty_attach(
    state: tauri::State<PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<PtyOpenResult, String> {
    let PtyBackend::Daemon { client, sessions } = &state.backend else {
        return Err("pty_attach requires daemon backend".into());
    };
    let uuid: Uuid = session_id
        .parse()
        .map_err(|e| format!("invalid session_id: {e}"))?;
    let alive = client.attach(uuid, cols, rows, on_event)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    sessions.write().unwrap().insert(id, uuid);
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
            client.resize(uuid, cols, rows).map_err(|e| {
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
                if let Err(e) = client.close(u) {
                    log::debug!("pty_close: daemon close id={id} uuid={u} returned {e}");
                }
                log::info!("pty closed id={id} uuid={u}");
            }
            Ok(())
        }
        PtyBackend::InProcess(map) => {
            let session = map.write().unwrap().remove(&id);
            if let Some(s) = session {
                if let Err(e) = s.killer.lock().unwrap().kill() {
                    log::debug!("pty_close: kill id={id} returned {e}");
                }
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
pub fn pty_list_sessions(state: tauri::State<PtyState>) -> Result<Vec<SessionInfo>, String> {
    match &state.backend {
        PtyBackend::Daemon { client, .. } => client.list(),
        PtyBackend::InProcess(_) => Ok(Vec::new()),
    }
}

/// Kill every daemon-owned session. Backs the "Reset all sessions"
/// settings button. No-op in in-process mode (caller can just close tabs).
#[tauri::command]
pub fn pty_kill_all(state: tauri::State<PtyState>) -> Result<(), String> {
    if let PtyBackend::Daemon { client, sessions } = &state.backend {
        client.kill_all()?;
        sessions.write().unwrap().clear();
    }
    Ok(())
}
