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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
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

/// Per-session cap on push events buffered before the session's channel is
/// registered (its `OpenOk`/`AttachOk` reply is still being processed). A
/// shell's startup burst is a few KiB; 256 KiB is generous headroom. Past
/// it we drop — the daemon scrollback still holds the bytes for a reattach.
const EARLY_DATA_CAP_BYTES: usize = 256 * 1024;

/// Cap on the number of distinct un-registered sessions buffered at once.
/// Bounds memory if an `open()` round-trip never returns its `OpenOk` (so
/// its session id is never learned and never drained) while the daemon
/// keeps streaming `Data` for it.
const MAX_EARLY_SESSIONS: usize = 32;

/// Routes daemon push events (`Data`/`Exit`) to the per-session Tauri
/// `Channel`. `channels` holds the registered routes; `early` buffers events
/// that arrive for a session whose channel is not registered yet (its
/// `OpenOk`/`AttachOk` reply is still in flight in `open()` / `attach()`).
///
/// Both maps live under ONE mutex so the reader thread's lookup-or-buffer and
/// `open()`/`attach()`'s register-and-replay are mutually exclusive. If they
/// could interleave, a `Data` frame carrying the shell's first
/// (prompt-bearing) bytes would be looked up, found missing, and silently
/// dropped — leaving a permanently blank new tab/pane. Holding the lock across
/// the replay also guarantees in-order delivery: a live frame the reader is
/// about to route waits until the buffered tail has been replayed.
#[derive(Default)]
struct Routing {
    channels: HashMap<Uuid, Channel<PtyEvent>>,
    /// Buffered pre-registration events per session, in arrival order.
    early: HashMap<Uuid, Vec<PtyEvent>>,
}

fn early_event_bytes(ev: &PtyEvent) -> usize {
    match ev {
        PtyEvent::Data { data } => data.len(),
        PtyEvent::Exit { .. } => 0,
    }
}

/// Buffer a push event for a not-yet-registered session, bounded per session
/// by `EARLY_DATA_CAP_BYTES` and overall by `MAX_EARLY_SESSIONS`.
fn buffer_early(routing: &mut Routing, session_id: Uuid, ev: PtyEvent) {
    if !routing.early.contains_key(&session_id) && routing.early.len() >= MAX_EARLY_SESSIONS {
        return;
    }
    let buf = routing.early.entry(session_id).or_default();
    let used: usize = buf.iter().map(early_event_bytes).sum();
    if used < EARLY_DATA_CAP_BYTES {
        buf.push(ev);
    }
}

pub struct PtyClient {
    state: Arc<ClientState>,
}

struct ClientState {
    stream: Arc<interprocess::local_socket::Stream>,
    pending: Mutex<HashMap<ReqId, SyncSender<DaemonMsg>>>,
    /// Push-event routing + pre-registration buffer. See `Routing` — the
    /// single mutex closes the register-vs-route race that otherwise drops a
    /// new shell's first prompt bytes (the blank new-tab/pane bug).
    routing: Mutex<Routing>,
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
            routing: Mutex::new(Routing::default()),
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

    /// Register `channel` as the route for `session_id` and, still holding the
    /// routing lock, replay every event buffered before registration in
    /// arrival order. Holding the lock across the replay closes BOTH the
    /// Data-before-reply wire race and the reader-vs-register insert race: a
    /// live `Data` frame the reader is about to route blocks on the lock until
    /// the buffered tail has been delivered, so the frontend never sees the
    /// shell's bytes out of order or with the first (prompt) chunk missing.
    fn register_and_replay(&self, session_id: Uuid, channel: &Channel<PtyEvent>) {
        let mut routing = self.state.routing.lock().unwrap();
        let drained = routing.early.remove(&session_id).unwrap_or_default();
        routing.channels.insert(session_id, channel.clone());
        for ev in drained {
            let _ = channel.send(ev);
        }
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
                // Register the channel AND replay any `Data` the daemon already
                // pushed before this reply was processed, so the shell's first
                // (prompt-bearing) bytes are never lost to the registration
                // race. See `register_and_replay`.
                self.register_and_replay(session_id, &channel);
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
                // Replay scrollback (history) FIRST, while the channel is still
                // unregistered so the reader keeps buffering any live frames
                // into `early` (no interleave, no loss). Then register and
                // replay that buffered live tail in order via
                // `register_and_replay`. Scrollback (up to ~1.25 MiB) is sent
                // outside the routing lock; only the small live tail is
                // replayed under it.
                if !scrollback_b64.is_empty() {
                    let _ = channel.send(PtyEvent::Data {
                        data: scrollback_b64,
                    });
                }
                self.register_and_replay(session_id, &channel);
                Ok(alive)
            }
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected attach response: {other:?}")),
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
        {
            let mut routing = self.state.routing.lock().unwrap();
            routing.channels.remove(&session_id);
            routing.early.remove(&session_id);
        }
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
                let mut routing = self.state.routing.lock().unwrap();
                routing.channels.clear();
                routing.early.clear();
                Ok(())
            }
            DaemonMsg::Err { message, .. } => Err(message),
            other => Err(format!("unexpected killAll response: {other:?}")),
        }
    }
}

fn reader_loop(state: Arc<ClientState>) {
    loop {
        let mut s = &*state.stream;
        let frame = match transport::read_frame(&mut s) {
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
                // Clone the channel out and send AFTER releasing the lock so a
                // slow webview post can't stall routing for other sessions. If
                // the session isn't registered yet (its OpenOk/AttachOk is
                // still being processed), buffer the event so
                // `register_and_replay` delivers it in order — never drop it
                // (dropping the first frame loses a new shell's prompt → blank
                // pane).
                let chan = {
                    let mut routing = state.routing.lock().unwrap();
                    match routing.channels.get(session_id) {
                        Some(chan) => Some(chan.clone()),
                        None => {
                            buffer_early(
                                &mut routing,
                                *session_id,
                                PtyEvent::Data {
                                    data: data_b64.clone(),
                                },
                            );
                            None
                        }
                    }
                };
                if let Some(chan) = chan {
                    let _ = chan.send(PtyEvent::Data {
                        data: data_b64.clone(),
                    });
                }
            }
            DaemonMsg::Exit { session_id, code } => {
                let chan = {
                    let mut routing = state.routing.lock().unwrap();
                    match routing.channels.remove(session_id) {
                        Some(chan) => {
                            // Registered session exited: drop its route (and any
                            // stray early buffer) and deliver the Exit.
                            routing.early.remove(session_id);
                            Some(chan)
                        }
                        None => {
                            // Exit raced ahead of the open/attach reply: buffer
                            // it so the eventual register_and_replay still
                            // surfaces the exit after the session's output.
                            buffer_early(&mut routing, *session_id, PtyEvent::Exit { code: *code });
                            None
                        }
                    }
                };
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
    // Connection is dead; no more events will arrive. Free any buffered
    // pre-registration events so they can't leak past the connection.
    state.routing.lock().unwrap().early.clear();
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
