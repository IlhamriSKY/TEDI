// Daemon server — runs inside `TEDIApp --pty-daemon`. Owns every PTY
// across GUI window-close events so sessions survive into the next
// launch. See `mod.rs` for the lifecycle goals.
//
// Concurrency model:
//   • One tokio multi-thread runtime, blocking forever in `run_forever`.
//   • Listener task accepts connections, spawns one `handle_client` task
//     per connection.
//   • Each client gets:
//       - reader task: parses `ClientMsg` off the socket, dispatches
//         synchronously (most ops are cheap), pushes responses into the
//         writer's mpsc.
//       - writer task: owns the socket write-half, loops on the mpsc,
//         writes one `DaemonMsg` per recv.
//   • Each PTY spawns the existing sync reader/flusher/waiter threads
//     (lifted from `pty::session::spawn_with_sink`). The sink — see
//     `ServerSink` — appends bytes to a per-session scrollback ring and
//     pushes `Data` events into every subscribed client's mpsc.
//
// Why mpsc instead of locking the socket directly: the writer side of an
// async stream is `!Sync`, and we have N producers per client (one per
// session that client is subscribed to) plus the reader task's own
// responses. A single writer task funnels them all serially without any
// shared `&mut SendHalf`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::modules::lockext::LockExt;

use super::protocol::{ClientMsg, DaemonMsg, SessionInfo, PROTOCOL_VERSION};

/// Scrollback ring capacity per session. 1 MiB is roughly 12k lines of
/// 80-col output, enough that an attaching client sees meaningful context
/// without holding gigabytes when an `npm install` blasts the buffer.
const SCROLLBACK_CAP: usize = 1024 * 1024;

/// Slack the scrollback is allowed to overrun `SCROLLBACK_CAP` by before it's
/// trimmed back down. `VecDeque::drain` shifts every surviving byte, so
/// trimming on each chunk while sitting at the cap turns every ~16 KiB read
/// into a ~1 MiB memmove under sustained output (build / install log floods).
/// Letting a slack burst accumulate first amortizes that to roughly one
/// memmove per `SCROLLBACK_SLACK` bytes. The buffer stays bounded at
/// `SCROLLBACK_CAP + SCROLLBACK_SLACK`.
const SCROLLBACK_SLACK: usize = 256 * 1024;

/// Mpsc capacity per client writer. Burst protection - if the writer
/// task falls behind (e.g. socket congested), back-pressure surfaces at
/// `try_send` and the daemon drops a `Data` event rather than buffering
/// unbounded memory. The PTY itself owns the canonical bytes; the
/// scrollback is already separate.
const WRITER_QUEUE: usize = 1024;

/// Default idle-timeout: shut down after a full day with no client
/// connections. Overridable via `TEDI_PTYD_IDLE_SECS` env var for testing.
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 24 * 60 * 60;

/// Cap for CLIENT->daemon frames. The only large frame in the protocol
/// is the daemon->client `AttachOk` scrollback (~1.25 MiB); every inbound
/// frame (Hello/Open/Write/Resize/Close/...) is small. Refusing to preallocate
/// up to 16 MiB per inbound frame bounds a peer that sends a huge length
/// prefix purely to pin memory.
const MAX_CLIENT_FRAME_SIZE: usize = 4 * 1024 * 1024;

/// Hard cap on concurrently live PTY sessions. Each is a real shell process
/// plus reader/flusher/waiter threads and a scrollback ring, so an unbounded
/// `Open` loop could otherwise exhaust process/thread/FD/memory limits.
const MAX_SESSIONS: usize = 256;

/// Hard cap on concurrent client connections. On a single-user machine the
/// only legitimate client is the GUI; the cap stops a local peer from spawning
/// unbounded handler tasks each holding a read buffer.
const MAX_CLIENTS: u64 = 64;

/// Max EXITED sessions retained for scrollback replay before the oldest are
/// reaped on the next `Open`. Bounds memory from sessions the GUI never
/// explicitly closes (force-quit / crash, non-persisted OSC-spawned tabs).
const MAX_RETAINED_DEAD_SESSIONS: usize = 16;

// ── shared state ────────────────────────────────────────────────────────

pub struct DaemonState {
    sessions: RwLock<HashMap<Uuid, Arc<DaemonSession>>>,
    client_count: AtomicU64,
    last_disconnect: Mutex<Option<std::time::Instant>>,
    shutdown_requested: AtomicBool,
}

impl DaemonState {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            client_count: AtomicU64::new(0),
            // Seed with boot time (not None) so the idle watcher's
            // `if let Some(t) = last` path measures idle-from-boot when a
            // daemon is spawned but never connected to. `remove_client`
            // keeps refreshing it on the last disconnect.
            last_disconnect: Mutex::new(Some(std::time::Instant::now())),
            shutdown_requested: AtomicBool::new(false),
        }
    }

    /// Reserve a client slot and return the post-increment count. Callers
    /// enforce `MAX_CLIENTS` against this returned value and back the count
    /// out via `client_count.fetch_sub` if they overshot the cap.
    fn add_client(&self) -> u64 {
        self.client_count.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn remove_client(&self) {
        // last_disconnect is consulted by the idle watcher; only stamp it
        // when the LAST client leaves so the timer measures true idle.
        if self.client_count.fetch_sub(1, Ordering::Release) == 1 {
            *self.last_disconnect.lock().unwrap() = Some(std::time::Instant::now());
        }
    }
}

pub struct DaemonSession {
    id: Uuid,
    /// Lazily filled by `open_session` AFTER the shell has been built and
    /// downgraded to `Weak` for the sink. The sink never touches `pty`
    /// (it only writes to scrollback + subscribers), so this OnceLock
    /// breaks the chicken-and-egg cycle without unsafe placeholders.
    pty: OnceLock<Arc<crate::modules::pty::session::Session>>,
    info: Mutex<SessionInfo>,
    scrollback: Mutex<VecDeque<u8>>,
    /// Subscribed clients receive `Data`/`Exit` push events.
    subscribers: Mutex<Vec<(Uuid, mpsc::Sender<DaemonMsg>)>>,
    alive: AtomicBool,
}

impl DaemonSession {
    /// The live shell handle, or `Err` if `open_session` has not finished
    /// filling it yet. Returning an error instead of `.expect()`-panicking is
    /// load-bearing: the daemon is built `panic = "abort"`, so a panic here
    /// aborts the WHOLE daemon and drops EVERY client's connection (surfacing
    /// as "daemon connection dropped" in the GUI). A second client (the
    /// remote-access agent) hits exactly that window: its 2s poll `List`s a
    /// session the moment `open_session` inserts it into the map (below) and
    /// `Attach`es before the ~tens-of-ms ConPTY spawn fills this OnceLock. The
    /// caller now returns a transient error and the agent retries on its next
    /// tick (by which point the pty is filled).
    fn pty(&self) -> Result<&Arc<crate::modules::pty::session::Session>, String> {
        self.pty
            .get()
            .ok_or_else(|| "session still initializing".to_string())
    }
}

struct ServerSink {
    /// Weak so a session that's been `Close`d can drop without keeping
    /// the sink alive past its useful lifetime.
    session: Weak<DaemonSession>,
}

impl crate::modules::pty::session::PtyEventSink for ServerSink {
    fn data(&self, bytes: &[u8]) -> bool {
        let Some(s) = self.session.upgrade() else {
            return false;
        };
        // Scrollback ring — drop from the front to keep the tail (recent
        // output is what an attacher needs to see).
        {
            let mut sb = s.scrollback.lock_or_recover();
            sb.extend(bytes.iter().copied());
            // Trim only once we've overrun the cap by SCROLLBACK_SLACK, then
            // trim all the way back to the cap. Amortizes the O(n) drain - see
            // SCROLLBACK_SLACK.
            if sb.len() > SCROLLBACK_CAP + SCROLLBACK_SLACK {
                let overflow = sb.len() - SCROLLBACK_CAP;
                sb.drain(..overflow);
            }
        }
        // Fan out to subscribers. Encode once; `Send` clones the String.
        let subs = s.subscribers.lock_or_recover();
        if !subs.is_empty() {
            let data_b64 = B64.encode(bytes);
            for (_cid, tx) in subs.iter() {
                // `try_send` drops the event when the queue is saturated.
                // Scrollback still has it; a re-attach replays.
                let _ = tx.try_send(DaemonMsg::Data {
                    session_id: s.id,
                    data_b64: data_b64.clone(),
                });
            }
        }
        true
    }

    fn exit(&self, code: i32) {
        let Some(s) = self.session.upgrade() else {
            return;
        };
        s.alive.store(false, Ordering::Release);
        if let Ok(mut info) = s.info.lock() {
            info.alive = false;
        }
        let subs = s.subscribers.lock_or_recover();
        for (_cid, tx) in subs.iter() {
            let _ = tx.try_send(DaemonMsg::Exit {
                session_id: s.id,
                code,
            });
        }
    }
}

// ── logging ─────────────────────────────────────────────────────────────

/// Minimal stderr logger - the daemon has no Tauri context so it can't use
/// `tauri-plugin-log`. The spawning GUI redirects daemon stderr to a log
/// file (see `paths::daemon_log_path` + `spawn::spawn_daemon_from`), so
/// `eprintln!` lands persistently. We install this as `log::Log` so the
/// existing `log::info!` / `log::error!` macros across the codebase route
/// through it unchanged. Quietly no-ops if a logger is already installed
/// (which it should never be in daemon mode, but defensive).
struct StderrLogger {
    level: log::LevelFilter,
}

impl log::Log for StderrLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= self.level
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        // Wall-clock seconds since UNIX epoch is enough for forensics; we
        // avoid pulling in chrono just for prettier timestamps.
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        eprintln!("[{secs} {} {}] {}", r.level(), r.target(), r.args());
    }
    fn flush(&self) {}
}

fn init_logging() {
    let level = std::env::var("TEDI_PTYD_LOG")
        .ok()
        .and_then(|v| v.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);
    let logger = StderrLogger { level };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(level);
    }
}

// ── public entry ────────────────────────────────────────────────────────

/// Block forever running the daemon. Called from
/// `handle_pty_daemon_command_and_exit` once it confirms argv requested
/// daemon mode.
pub fn run_forever() -> ! {
    init_logging();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("tedi-ptyd")
        .build()
        .expect("build tokio runtime for tedi-ptyd");
    let result = rt.block_on(async { server_main().await });
    match result {
        Ok(()) => {
            log::info!("tedi-ptyd shutting down");
            std::process::exit(0)
        }
        Err(e) => {
            log::error!("tedi-ptyd fatal: {e}");
            std::process::exit(1)
        }
    }
}

async fn server_main() -> std::io::Result<()> {
    let listener = bind_async()?;
    let state = Arc::new(DaemonState::new());

    let idle_timeout_secs = std::env::var("TEDI_PTYD_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS);
    {
        let s = state.clone();
        tokio::spawn(idle_watcher(s, Duration::from_secs(idle_timeout_secs)));
    }

    log::info!("tedi-ptyd ready (idle_timeout={idle_timeout_secs}s)");
    accept_loop(listener, state).await
}

async fn accept_loop(
    listener: interprocess::local_socket::tokio::Listener,
    state: Arc<DaemonState>,
) -> std::io::Result<()> {
    use interprocess::local_socket::traits::tokio::Listener as _;
    loop {
        if state.shutdown_requested.load(Ordering::Acquire) {
            // Idle-shutdown race guard: the idle watcher's wake connection
            // (see `idle_watcher`) transiently bumps client_count, so let it
            // drain, then re-verify nothing live exists. If a real client
            // connected in the window between the watcher's last check and
            // here, clear the flag and keep serving instead of killing it.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let clients = state.client_count.load(Ordering::Acquire);
            let live_sessions = state
                .sessions
                .read()
                .unwrap()
                .values()
                .any(|s| s.alive.load(Ordering::Acquire));
            if clients == 0 && !live_sessions {
                return Ok(());
            }
            log::info!(
                "tedi-ptyd shutdown raced a live connection (clients={clients}, \
                 live_sessions={live_sessions}); resuming"
            );
            state.shutdown_requested.store(false, Ordering::Release);
        }
        match listener.accept().await {
            Ok(stream) => {
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(state, stream).await {
                        log::debug!("client handler exited: {e}");
                    }
                });
            }
            Err(e) => {
                log::warn!("daemon accept error: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn idle_watcher(state: Arc<DaemonState>, timeout: Duration) {
    let tick = Duration::from_secs(60);
    loop {
        tokio::time::sleep(tick).await;
        if state.client_count.load(Ordering::Acquire) > 0 {
            continue;
        }
        let last = *state.last_disconnect.lock().unwrap();
        if let Some(t) = last {
            if t.elapsed() >= timeout {
                log::info!(
                    "tedi-ptyd idle for {}s, requesting shutdown",
                    t.elapsed().as_secs()
                );
                state.shutdown_requested.store(true, Ordering::Release);
                // Wake accept() by connecting once - the accept loop checks
                // the flag on every iteration.
                let _ = super::transport::connect_to_daemon();
                // Don't return: `accept_loop` may clear the flag if a client
                // raced the shutdown (see its idle-shutdown race guard). Keep
                // looping so the daemon can idle-shut-down again after that
                // resumed client eventually disconnects. If the flag stays
                // set the daemon is exiting and this task is torn down anyway.
                continue;
            }
        }
    }
}

fn bind_async() -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::ListenerOptions;

    #[cfg(unix)]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        let path = super::paths::socket_path();
        // Probe stale socket: a successful connect means a peer is alive
        // and we refuse to double-bind. Failure means we can remove the
        // file and take over.
        if super::transport::connect_to_daemon().is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "daemon already running",
            ));
        }
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let name = path.as_path().to_fs_name::<GenericFilePath>()?;
        let listener = ListenerOptions::new().name(name).create_tokio()?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        let name_str = super::paths::socket_name();
        let name = name_str.as_str().to_ns_name::<GenericNamespaced>()?;
        ListenerOptions::new().name(name).create_tokio()
    }
}

// ── per-client handling ─────────────────────────────────────────────────

async fn handle_client(
    state: Arc<DaemonState>,
    stream: interprocess::local_socket::tokio::Stream,
) -> std::io::Result<()> {
    use interprocess::local_socket::traits::tokio::Stream as _;
    let client_id = Uuid::new_v4();
    // Connection cap: refuse past MAX_CLIENTS so a local peer can't spawn
    // unbounded handler tasks each holding an inbound read buffer. Increment
    // first, then validate the post-increment count, so two concurrent
    // accepts can't both observe a stale under-cap value and both pass
    // (TOCTOU). If we overshot, back the count out before rejecting.
    let new_count = state.add_client();
    if new_count > MAX_CLIENTS {
        state.client_count.fetch_sub(1, Ordering::Release);
        log::warn!("daemon at connection cap ({MAX_CLIENTS}); refusing client {client_id}");
        return Ok(());
    }
    log::info!("client connected id={client_id}");

    let (mut recv, mut send) = stream.split();
    let (tx, mut rx) = mpsc::channel::<DaemonMsg>(WRITER_QUEUE);

    // Writer task: only owner of `send`. All writes funnel through `tx`.
    // `mut` so the teardown below can `&mut writer_task` it into a bounded
    // `tokio::time::timeout` (a JoinHandle is a Future) without leaking the
    // client_count slot when the writer wedges on a stalled socket write.
    let mut writer_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let body = match serde_json::to_vec(&msg) {
                Ok(b) => b,
                Err(e) => {
                    log::error!("serialize daemon msg: {e}");
                    continue;
                }
            };
            let len = (body.len() as u32).to_be_bytes();
            if send.write_all(&len).await.is_err() {
                break;
            }
            if send.write_all(&body).await.is_err() {
                break;
            }
        }
    });

    // Reader loop: parse incoming messages, dispatch on the daemon state.
    let dispatch_state = state.clone();
    let dispatch_tx = tx.clone();
    let read_loop = async move {
        let mut handshaked = false;
        loop {
            let mut prefix = [0u8; 4];
            if recv.read_exact(&mut prefix).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(prefix) as usize;
            if len > MAX_CLIENT_FRAME_SIZE {
                log::warn!("client frame too large: {len} (cap {MAX_CLIENT_FRAME_SIZE})");
                break;
            }
            let mut body = vec![0u8; len];
            if recv.read_exact(&mut body).await.is_err() {
                break;
            }
            let msg: ClientMsg = match serde_json::from_slice(&body) {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("client sent malformed msg: {e}");
                    continue;
                }
            };
            // Mandatory handshake gate: serve nothing until a valid Hello has
            // been received. Without this the version `Hello` is purely
            // advisory and any peer that opened the socket could immediately
            // Open/Attach/Write/KillAll. The GUI always sends Hello first.
            let is_hello = matches!(msg, ClientMsg::Hello { .. });
            if !handshaked && !is_hello {
                log::warn!("client {client_id} sent a command before Hello; closing");
                break;
            }
            if is_hello {
                handshaked = true;
            }
            dispatch(&dispatch_state, &dispatch_tx, client_id, msg).await;
        }
    };
    read_loop.await;

    // Reader done — unsubscribe this client from every session it was on.
    unsubscribe_client(&state, client_id);
    drop(tx);
    // Wait for the writer task to drain, but bound it: if the writer is
    // wedged on a stalled socket write the await would never return and
    // `remove_client` would never run, leaking the client_count slot
    // forever. On timeout, abort the writer and proceed so client_count is
    // always decremented exactly once on disconnect.
    if tokio::time::timeout(Duration::from_secs(5), &mut writer_task)
        .await
        .is_err()
    {
        log::warn!("client {client_id} writer task did not drain in time; aborting");
        writer_task.abort();
    }
    state.remove_client();
    log::info!("client disconnected id={client_id}");
    Ok(())
}

async fn dispatch(
    state: &Arc<DaemonState>,
    tx: &mpsc::Sender<DaemonMsg>,
    client_id: Uuid,
    msg: ClientMsg,
) {
    match msg {
        ClientMsg::Hello { req_id, version } => {
            if version != PROTOCOL_VERSION {
                let _ = tx
                    .send(DaemonMsg::Err {
                        req_id,
                        message: format!(
                            "protocol version mismatch: client={version}, daemon={PROTOCOL_VERSION}"
                        ),
                    })
                    .await;
            } else {
                let _ = tx
                    .send(DaemonMsg::Welcome {
                        req_id,
                        version: PROTOCOL_VERSION,
                        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                    })
                    .await;
            }
        }
        ClientMsg::Open {
            req_id,
            cols,
            rows,
            cwd,
        } => {
            // Move to the blocking pool so the sync SPAWN_LOCK + ConPTY
            // openpty/spawn_command (slow on Windows, can run for hundreds
            // of ms) don't pin a tokio worker. Two concurrent Opens would
            // otherwise stall both workers in a default multi-thread runtime.
            let state_clone = state.clone();
            let client_tx = tx.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                open_session(&state_clone, client_tx, client_id, cols, rows, cwd)
            })
            .await;
            match outcome {
                Ok(Ok(id)) => {
                    let _ = tx
                        .send(DaemonMsg::OpenOk {
                            req_id,
                            session_id: id,
                        })
                        .await;
                }
                Ok(Err(e)) => {
                    let _ = tx.send(DaemonMsg::Err { req_id, message: e }).await;
                }
                Err(join_err) => {
                    let _ = tx
                        .send(DaemonMsg::Err {
                            req_id,
                            message: format!("open_session task join failed: {join_err}"),
                        })
                        .await;
                }
            }
        }
        ClientMsg::Attach {
            req_id,
            session_id,
            cols,
            rows,
        } => match attach_session(state, tx.clone(), client_id, session_id, cols, rows) {
            Ok((scrollback_b64, alive)) => {
                let _ = tx
                    .send(DaemonMsg::AttachOk {
                        req_id,
                        session_id,
                        scrollback_b64,
                        alive,
                    })
                    .await;
            }
            Err(e) => {
                let _ = tx.send(DaemonMsg::Err { req_id, message: e }).await;
            }
        },
        ClientMsg::Write {
            req_id,
            session_id,
            data_b64,
        } => match write_session(state, session_id, &data_b64) {
            Ok(()) => {
                let _ = tx.send(DaemonMsg::Ok { req_id }).await;
            }
            Err(e) => {
                let _ = tx.send(DaemonMsg::Err { req_id, message: e }).await;
            }
        },
        ClientMsg::Resize {
            req_id,
            session_id,
            cols,
            rows,
        } => match resize_session(state, session_id, cols, rows) {
            Ok(()) => {
                let _ = tx.send(DaemonMsg::Ok { req_id }).await;
            }
            Err(e) => {
                let _ = tx.send(DaemonMsg::Err { req_id, message: e }).await;
            }
        },
        ClientMsg::Close { req_id, session_id } => {
            close_session(state, session_id);
            let _ = tx.send(DaemonMsg::Ok { req_id }).await;
        }
        ClientMsg::List { req_id } => {
            let items: Vec<SessionInfo> = state
                .sessions
                .read()
                .unwrap()
                .values()
                .map(|s| s.info.lock().unwrap().clone())
                .collect();
            let _ = tx.send(DaemonMsg::Sessions { req_id, items }).await;
        }
        ClientMsg::KillAll { req_id } => {
            let ids: Vec<Uuid> = state.sessions.read().unwrap().keys().copied().collect();
            for id in ids {
                close_session(state, id);
            }
            let _ = tx.send(DaemonMsg::Ok { req_id }).await;
        }
    }
}

// ── session operations ──────────────────────────────────────────────────

/// Drop EXITED sessions beyond `MAX_RETAINED_DEAD_SESSIONS`, oldest first.
/// Routed through `close_session` so the (already-dead) PTY's teardown runs on
/// the same detached SPAWN_LOCK-guarded drop path. Called on `Open` so a
/// daemon that survives many GUI restarts can't accumulate orphaned exited
/// sessions (each holding a ~1.25 MiB scrollback ring) without bound.
fn reap_dead_sessions(state: &Arc<DaemonState>) {
    let mut dead: Vec<(u64, Uuid)> = {
        let sessions = state.sessions.read().unwrap();
        sessions
            .iter()
            .filter(|(_, s)| !s.alive.load(Ordering::Acquire))
            .map(|(id, s)| {
                let ts = s.info.lock().map(|i| i.created_at_ms).unwrap_or(0);
                (ts, *id)
            })
            .collect()
    };
    if dead.len() <= MAX_RETAINED_DEAD_SESSIONS {
        return;
    }
    dead.sort_unstable_by_key(|(ts, _)| *ts);
    let drop_count = dead.len() - MAX_RETAINED_DEAD_SESSIONS;
    for (_, id) in dead.into_iter().take(drop_count) {
        close_session(state, id);
    }
}

fn open_session(
    state: &Arc<DaemonState>,
    client_tx: mpsc::Sender<DaemonMsg>,
    client_id: Uuid,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<Uuid, String> {
    // Reap old dead sessions, then enforce the live-session cap before
    // spawning another shell so an `Open` loop can't exhaust resources.
    reap_dead_sessions(state);
    let id = Uuid::new_v4();
    let info = SessionInfo {
        id,
        cwd: cwd.clone(),
        cols,
        rows,
        alive: true,
        created_at_ms: now_ms(),
    };
    let shell = Arc::new(DaemonSession {
        id,
        pty: OnceLock::new(),
        info: Mutex::new(info),
        scrollback: Mutex::new(VecDeque::with_capacity(8192)),
        subscribers: Mutex::new(vec![(client_id, client_tx)]),
        alive: AtomicBool::new(true),
    });
    // Reserve-then-insert: re-check the live-session cap and insert the
    // (pty-less) shell under the SAME write guard, so two concurrent Opens
    // can't both observe an under-cap len and both spawn (TOCTOU). The pty
    // OnceLock is filled below. This publishes the session into the map (and
    // thus into `List` output) before the pty exists, so a SECOND client (the
    // remote-access agent) CAN observe it and `Attach` inside the fill window.
    // `DaemonSession::pty()` returns Err (not a panic) for exactly that window;
    // the sink itself never touches `pty`.
    {
        let mut sessions = state.sessions.write().unwrap();
        if sessions.len() >= MAX_SESSIONS {
            return Err(format!("session limit reached ({MAX_SESSIONS})"));
        }
        sessions.insert(id, shell.clone());
    }
    let sink: Arc<dyn crate::modules::pty::session::PtyEventSink> = Arc::new(ServerSink {
        session: Arc::downgrade(&shell),
    });
    let pty = match crate::modules::pty::session::spawn_with_sink(cols, rows, cwd, sink) {
        Ok((pty, _size)) => pty,
        Err(e) => {
            // Back out the reservation so a failed spawn doesn't permanently
            // consume a session slot.
            state.sessions.write().unwrap().remove(&id);
            return Err(e);
        }
    };
    if shell.pty.set(pty).is_err() {
        state.sessions.write().unwrap().remove(&id);
        return Err("pty slot already filled (impossible)".to_string());
    }
    log::info!("daemon opened session id={id} cols={cols} rows={rows}");
    Ok(id)
}

/// Look up a live session by id, or `Err("unknown session ...")`. Shared by
/// every per-session dispatch handler.
fn get_session(state: &Arc<DaemonState>, session_id: Uuid) -> Result<Arc<DaemonSession>, String> {
    state
        .sessions
        .read()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("unknown session {session_id}"))
}

fn attach_session(
    state: &Arc<DaemonState>,
    client_tx: mpsc::Sender<DaemonMsg>,
    client_id: Uuid,
    session_id: Uuid,
    cols: u16,
    rows: u16,
) -> Result<(String, bool), String> {
    let shell = get_session(state, session_id)?;
    // Resize to the attaching client's viewport so its terminal renders correctly.
    let _ = shell
        .pty()?
        .master
        .lock()
        .unwrap()
        .resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    if let Ok(mut info) = shell.info.lock() {
        info.cols = cols;
        info.rows = rows;
    }
    let scrollback_b64 = {
        let sb = shell.scrollback.lock_or_recover();
        let bytes: Vec<u8> = sb.iter().copied().collect();
        B64.encode(&bytes)
    };
    let alive = shell.alive.load(Ordering::Acquire);
    // Subscribe — replace any prior subscription for this client to keep
    // the list one-per-session-per-client.
    let mut subs = shell.subscribers.lock_or_recover();
    subs.retain(|(cid, _)| *cid != client_id);
    subs.push((client_id, client_tx));
    Ok((scrollback_b64, alive))
}

fn write_session(state: &Arc<DaemonState>, session_id: Uuid, data_b64: &str) -> Result<(), String> {
    let shell = get_session(state, session_id)?;
    let bytes = B64
        .decode(data_b64)
        .map_err(|e| format!("invalid base64: {e}"))?;
    use std::io::Write;
    let pty = shell.pty()?.clone();
    let mut writer = pty.writer.lock().unwrap();
    writer.write_all(&bytes).map_err(|e| e.to_string())
}

fn resize_session(
    state: &Arc<DaemonState>,
    session_id: Uuid,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let shell = get_session(state, session_id)?;
    shell
        .pty()?
        .master
        .lock()
        .unwrap()
        .resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    if let Ok(mut info) = shell.info.lock() {
        info.cols = cols;
        info.rows = rows;
    }
    Ok(())
}

fn close_session(state: &Arc<DaemonState>, session_id: Uuid) {
    let removed = state.sessions.write().unwrap().remove(&session_id);
    let Some(shell) = removed else { return };
    // Kill the whole child tree synchronously (not just the shell leader), so a
    // `claude`/`node` running inside dies now rather than lingering until the
    // deferred `Session` drop closes the Job Object, or forever if the job was
    // never created. See `Session::kill_tree`. A session closed inside its
    // open_session spawn window has no pty yet, so there is nothing to kill here.
    // That window IS reachable (KillAll enumerates the map directly, so no prior
    // attach is needed), but the fresh shell is not orphaned: open_session's
    // local `shell` Arc drops at its return and runs `Session::drop`, which
    // reaps the child. (The GUI can still see a phantom OpenOk for that removed
    // id; pre-existing, low severity, and strictly better than the old abort.)
    if let Ok(pty) = shell.pty() {
        pty.kill_tree();
    }
    shell.alive.store(false, Ordering::Release);
    // Notify subscribers BEFORE handing the shell off to the drop thread,
    // since the drop chain can take seconds (ConPTY close on Windows blocks
    // until conhost drains output). Scope the lock so it releases before
    // the move into the spawn closure.
    {
        let subs = shell.subscribers.lock_or_recover();
        for (_cid, tx) in subs.iter() {
            let _ = tx.try_send(DaemonMsg::Exit {
                session_id,
                code: -1,
            });
        }
    }
    // Detach the Arc drop so the tokio dispatch worker doesn't stall on
    // ClosePseudoConsole. We clone the inner pty Arc and route the final
    // drop through `pty::session::drop_session`, which holds SPAWN_LOCK to
    // keep ConPTY close from racing a sibling spawn (the same blank-pane
    // hazard the in-process `pty_close` path handles).
    let _ = std::thread::Builder::new()
        .name(format!("tedi-ptyd-drop-{session_id}"))
        .spawn(move || {
            let pty_arc = shell.pty.get().cloned();
            drop(shell);
            if let Some(pty) = pty_arc {
                let t0 = std::time::Instant::now();
                crate::modules::pty::session::drop_session(pty);
                log::info!(
                    "daemon session id={session_id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            }
        });
}

fn unsubscribe_client(state: &Arc<DaemonState>, client_id: Uuid) {
    let sessions: Vec<Arc<DaemonSession>> =
        state.sessions.read().unwrap().values().cloned().collect();
    for s in sessions {
        let mut subs = s.subscribers.lock_or_recover();
        subs.retain(|(cid, _)| *cid != client_id);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: a session published into the map but whose ConPTY spawn has
    // not yet filled the pty OnceLock must return Err from pty(), never panic.
    // Under `panic = "abort"` a panic here aborts the whole daemon and drops
    // every client, the "daemon connection dropped" crash the remote-access
    // agent triggered by Attaching inside `open_session`'s spawn window.
    #[test]
    fn pty_before_fill_errors_instead_of_panicking() {
        let id = Uuid::new_v4();
        let s = DaemonSession {
            id,
            pty: OnceLock::new(),
            info: Mutex::new(SessionInfo {
                id,
                cwd: None,
                cols: 80,
                rows: 24,
                alive: true,
                created_at_ms: 0,
            }),
            scrollback: Mutex::new(VecDeque::new()),
            subscribers: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
        };
        assert!(
            s.pty().is_err(),
            "unfilled pty must be a recoverable Err, never a panic"
        );
    }
}
