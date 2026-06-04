// Daemon client — lives inside the GUI process. Maintains one persistent
// connection to the sidecar daemon (spawning it if necessary), translates
// the GUI's sync per-session API into IPC requests, and routes push
// events (`Data` / `Exit`) onto the Tauri `Channel<PtyEvent>` the
// frontend installed via `pty_open`.
//
// Concurrency:
//   • ONE shared `Arc<Stream>` for the socket. The sync `interprocess`
//     stream impls `Read`/`Write` on `&Stream` (interior mutability over
//     the OS handle), so the reader thread and the writer can each hold
//     `&Stream` concurrently — no Mutex on the stream itself.
//   • `write_lock` serializes the producer side so frames are not
//     interleaved across concurrent Tauri command handlers.
//   • `pending` holds one `SyncSender<DaemonMsg>` per in-flight request,
//     keyed by `ReqId`. The reader thread fulfills them on response.
//   • `sessions` routes push events to per-session `Channel<PtyEvent>`.
//
// Lifecycle:
//   • `connect_or_spawn()`: try connect → if fail, spawn detached daemon
//     → retry connect with exponential backoff (5 s budget).
//   • If the reader hits an error the connection is considered dead; we
//     mark `alive=false` and let subsequent requests error out. The GUI
//     can fall back to in-process spawn (see `pty/mod.rs` settings flag).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use uuid::Uuid;

use super::protocol::{ClientMsg, DaemonMsg, ReqId, SessionInfo, PROTOCOL_VERSION};
use super::transport;
use crate::modules::pty::session::PtyEvent;

/// Time to wait for a response after sending a request. Matches the upper
/// bound a Tauri IPC caller is willing to spend blocked - longer than this
/// and the user sees a frozen UI.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Total time `connect_or_spawn` is willing to wait for a newly-spawned
/// daemon to bind its socket.
const SPAWN_WAIT_TOTAL: Duration = Duration::from_secs(5);

/// Upper bound on the initial Hello/Welcome handshake. A daemon that accepts
/// the socket but never replies must not hang the calling Tauri command; on
/// timeout the caller falls back to the in-process backend.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct PtyClient {
    state: Arc<ClientState>,
}

struct ClientState {
    stream: Arc<interprocess::local_socket::Stream>,
    pending: Mutex<HashMap<ReqId, SyncSender<DaemonMsg>>>,
    /// Per-session Tauri channel. The GUI's `pty_open` / `pty_attach`
    /// register here so push events can fan out per-xterm.
    sessions: RwLock<HashMap<Uuid, Channel<PtyEvent>>>,
    next_req_id: AtomicU64,
    /// Serializes producer writes so length-prefix + body land atomically.
    write_lock: Mutex<()>,
    alive: AtomicBool,
}

impl PtyClient {
    /// Connect to a running daemon. If none is running, spawn one detached
    /// and retry until either it answers or the spawn-wait budget runs
    /// out. Returns `Err` only if both connect + spawn-then-connect fail
    /// — in that case the GUI should fall back to its in-process PTY
    /// path (the settings-gated branch in `pty/mod.rs`).
    pub fn connect_or_spawn() -> Result<Self, String> {
        if let Ok(stream) = transport::connect_to_daemon() {
            return Self::from_stream(stream);
        }
        // No daemon listening — spawn one and poll.
        super::spawn::spawn_daemon_detached().map_err(|e| format!("spawn daemon: {e}"))?;
        let start = Instant::now();
        let mut delay_ms: u64 = 50;
        while start.elapsed() < SPAWN_WAIT_TOTAL {
            thread::sleep(Duration::from_millis(delay_ms));
            if let Ok(stream) = transport::connect_to_daemon() {
                return Self::from_stream(stream);
            }
            // Exponential backoff capped at 500 ms.
            delay_ms = (delay_ms.saturating_mul(2)).min(500);
        }
        Err(format!(
            "daemon did not respond within {}s",
            SPAWN_WAIT_TOTAL.as_secs()
        ))
    }

    fn from_stream(stream: interprocess::local_socket::Stream) -> Result<Self, String> {
        // Handshake BEFORE spawning the reader thread, on a short-lived
        // helper thread bounded by `HANDSHAKE_TIMEOUT`. Doing the round-trip
        // before the reader exists means a rejected version (an older daemon
        // still running during an upgrade) drops `stream` - closing the
        // socket - with no reader thread left stranded blocked in
        // `read_exact` forever (which would leak an OS thread + socket FD and
        // pin the daemon's client_count so it never idle-shuts-down). The
        // helper thread bounds the wait so a daemon that accepts the socket
        // but never replies cannot hang the calling Tauri command; on timeout
        // we return Err and the caller falls back to the in-process backend.
        //
        // `&Stream` impls both `Read` and `Write` (interior mutability over
        // the OS handle), so the helper drives the round-trip on the raw
        // stream and hands it back on success.
        let (hs_tx, hs_rx) =
            std::sync::mpsc::channel::<Result<interprocess::local_socket::Stream, String>>();
        thread::Builder::new()
            .name("tedi-ptyd-handshake".into())
            .spawn(move || {
                let res = (|| {
                    transport::write_msg(
                        &mut (&stream),
                        &ClientMsg::Hello {
                            req_id: 0,
                            version: PROTOCOL_VERSION,
                        },
                    )
                    .map_err(|e| format!("daemon write: {e}"))?;
                    match transport::read_msg::<_, DaemonMsg>(&mut (&stream))
                        .map_err(|e| format!("daemon read: {e}"))?
                    {
                        DaemonMsg::Welcome { .. } => Ok(stream),
                        DaemonMsg::Err { message, .. } => Err(format!("hello rejected: {message}")),
                        other => Err(format!("unexpected handshake response: {other:?}")),
                    }
                })();
                let _ = hs_tx.send(res);
            })
            .map_err(|e| format!("spawn handshake thread: {e}"))?;
        let stream = match hs_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("daemon handshake timed out".to_string()),
        };

        let state = Arc::new(ClientState {
            stream: Arc::new(stream),
            pending: Mutex::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            next_req_id: AtomicU64::new(1),
            write_lock: Mutex::new(()),
            alive: AtomicBool::new(true),
        });
        // Reader thread fulfills pending requests + routes push events.
        // Spawned only after a successful Welcome so a failed handshake can
        // never leave a thread blocked on the socket.
        let reader_state = state.clone();
        thread::Builder::new()
            .name("tedi-ptyd-client-reader".into())
            .spawn(move || reader_loop(reader_state))
            .map_err(|e| format!("spawn client reader: {e}"))?;
        Ok(Self { state })
    }

    fn next_req_id(&self) -> ReqId {
        self.state.next_req_id.fetch_add(1, Ordering::Relaxed)
    }

    fn send_request(&self, req_id: ReqId, msg: &ClientMsg) -> Result<DaemonMsg, String> {
        if !self.state.alive.load(Ordering::Acquire) {
            return Err("daemon connection dropped".into());
        }
        let (tx, rx) = sync_channel::<DaemonMsg>(1);
        self.state.pending.lock().unwrap().insert(req_id, tx);
        // Write under lock so frame prefix + body are atomic.
        let write_result = {
            let _guard = self.state.write_lock.lock().unwrap();
            transport::write_msg(&mut (&*self.state.stream), msg)
        };
        if let Err(e) = write_result {
            self.state.pending.lock().unwrap().remove(&req_id);
            return Err(format!("daemon write: {e}"));
        }
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(resp) => {
                // Reader removes pending entry on response delivery; this
                // is a defensive cleanup for the (impossible) double-send.
                self.state.pending.lock().unwrap().remove(&req_id);
                Ok(resp)
            }
            Err(_) => {
                self.state.pending.lock().unwrap().remove(&req_id);
                Err("daemon request timed out".into())
            }
        }
    }

    pub fn open(
        &self,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        channel: Channel<PtyEvent>,
    ) -> Result<Uuid, String> {
        let req_id = self.next_req_id();
        let msg = ClientMsg::Open {
            req_id,
            cols,
            rows,
            cwd,
        };
        match self.send_request(req_id, &msg)? {
            DaemonMsg::OpenOk { session_id, .. } => {
                // Register the channel BEFORE returning so the very first
                // `Data` event the daemon emits has a place to land.
                self.state
                    .sessions
                    .write()
                    .unwrap()
                    .insert(session_id, channel);
                Ok(session_id)
            }
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected open response: {other:?}")),
        }
    }

    pub fn attach(
        &self,
        session_id: Uuid,
        cols: u16,
        rows: u16,
        channel: Channel<PtyEvent>,
    ) -> Result<bool, String> {
        let req_id = self.next_req_id();
        let msg = ClientMsg::Attach {
            req_id,
            session_id,
            cols,
            rows,
        };
        match self.send_request(req_id, &msg)? {
            DaemonMsg::AttachOk {
                scrollback_b64,
                alive,
                ..
            } => {
                // Register channel BEFORE pushing scrollback so any data
                // event arriving while we replay also lands on this channel.
                self.state
                    .sessions
                    .write()
                    .unwrap()
                    .insert(session_id, channel.clone());
                if !scrollback_b64.is_empty() {
                    let _ = channel.send(PtyEvent::Data {
                        data: scrollback_b64,
                    });
                }
                Ok(alive)
            }
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected attach response: {other:?}")),
        }
    }

    pub fn detach(&self, session_id: Uuid) -> Result<(), String> {
        // Local routing entry removed first so events arriving in-flight
        // are quietly dropped instead of waking a dead xterm.
        self.state.sessions.write().unwrap().remove(&session_id);
        let req_id = self.next_req_id();
        match self.send_request(req_id, &ClientMsg::Detach { req_id, session_id })? {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected detach response: {other:?}")),
        }
    }

    pub fn write(&self, session_id: Uuid, data_b64: String) -> Result<(), String> {
        let req_id = self.next_req_id();
        match self.send_request(
            req_id,
            &ClientMsg::Write {
                req_id,
                session_id,
                data_b64,
            },
        )? {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected write response: {other:?}")),
        }
    }

    pub fn resize(&self, session_id: Uuid, cols: u16, rows: u16) -> Result<(), String> {
        let req_id = self.next_req_id();
        match self.send_request(
            req_id,
            &ClientMsg::Resize {
                req_id,
                session_id,
                cols,
                rows,
            },
        )? {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected resize response: {other:?}")),
        }
    }

    pub fn close(&self, session_id: Uuid) -> Result<(), String> {
        self.state.sessions.write().unwrap().remove(&session_id);
        let req_id = self.next_req_id();
        match self.send_request(req_id, &ClientMsg::Close { req_id, session_id })? {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected close response: {other:?}")),
        }
    }

    pub fn list(&self) -> Result<Vec<SessionInfo>, String> {
        let req_id = self.next_req_id();
        match self.send_request(req_id, &ClientMsg::List { req_id })? {
            DaemonMsg::Sessions { items, .. } => Ok(items),
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected list response: {other:?}")),
        }
    }

    pub fn kill_all(&self) -> Result<(), String> {
        let req_id = self.next_req_id();
        match self.send_request(req_id, &ClientMsg::KillAll { req_id })? {
            DaemonMsg::Ok { .. } => {
                // Clear local routing — daemon will not send Exit events
                // for sessions it just killed (it has already removed them).
                self.state.sessions.write().unwrap().clear();
                Ok(())
            }
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected killAll response: {other:?}")),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.state.alive.load(Ordering::Acquire)
    }
}

fn reader_loop(state: Arc<ClientState>) {
    loop {
        let frame = match read_frame_ref(&state.stream) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("client reader exit: {e}");
                break;
            }
        };
        let msg: DaemonMsg = match serde_json::from_slice(&frame) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("daemon sent malformed msg: {e}");
                continue;
            }
        };
        match &msg {
            DaemonMsg::Data {
                session_id,
                data_b64,
            } => {
                if let Some(chan) = state.sessions.read().unwrap().get(session_id) {
                    let _ = chan.send(PtyEvent::Data {
                        data: data_b64.clone(),
                    });
                }
            }
            DaemonMsg::Exit { session_id, code } => {
                let chan = state.sessions.write().unwrap().remove(session_id);
                if let Some(c) = chan {
                    let _ = c.send(PtyEvent::Exit { code: *code });
                }
            }
            _ => {
                let req_id = response_req_id(&msg);
                if let Some(rid) = req_id {
                    if let Some(tx) = state.pending.lock().unwrap().remove(&rid) {
                        let _ = tx.send(msg);
                    }
                }
            }
        }
    }
    state.alive.store(false, Ordering::Release);
    // Drain pending so blocked callers wake with timeout sooner.
    state.pending.lock().unwrap().clear();
}

/// Manual frame read against `&Stream` (which impls `Read`).
fn read_frame_ref(stream: &interprocess::local_socket::Stream) -> std::io::Result<Vec<u8>> {
    let mut s = stream;
    let mut prefix = [0u8; 4];
    s.read_exact(&mut prefix)?;
    let len = u32::from_be_bytes(prefix) as usize;
    if len > transport::MAX_FRAME_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut buf = vec![0u8; len];
    s.read_exact(&mut buf)?;
    Ok(buf)
}

fn response_req_id(msg: &DaemonMsg) -> Option<ReqId> {
    match msg {
        DaemonMsg::Welcome { req_id, .. }
        | DaemonMsg::OpenOk { req_id, .. }
        | DaemonMsg::AttachOk { req_id, .. }
        | DaemonMsg::Ok { req_id }
        | DaemonMsg::Err { req_id, .. }
        | DaemonMsg::Sessions { req_id, .. } => Some(*req_id),
        DaemonMsg::Data { .. } | DaemonMsg::Exit { .. } => None,
    }
}

// Suppress unused-import lint for the platform-specific Write trait when
// the daemon spawn arm is not active (placeholder for future use). The
// trait is actually used via `transport::write_msg`.
#[allow(dead_code)]
fn _ensure_write_trait_in_scope() {
    let _: fn(&mut &interprocess::local_socket::Stream, &[u8]) -> std::io::Result<()> =
        |s, b| Write::write_all(s, b);
}
