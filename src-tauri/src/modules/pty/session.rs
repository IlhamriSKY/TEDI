use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use super::shell_init;

/// Sink the PTY reader/flusher/waiter threads push into. Decouples session
/// lifecycle from the Tauri `Channel` so the sidecar daemon (see
/// `pty_daemon`) can reuse the same spawn logic with a different sink
/// (scrollback ring + multi-client fanout instead of a single channel).
///
/// `data` takes raw bytes - the sink decides whether to base64-encode for
/// wire transport (`Channel` impl) or store raw (daemon scrollback). Returns
/// false when the sink is closed, signalling the flusher to stop.
pub trait PtyEventSink: Send + Sync + 'static {
    fn data(&self, bytes: &[u8]) -> bool;
    fn exit(&self, code: i32);
}

impl PtyEventSink for Channel<PtyEvent> {
    fn data(&self, bytes: &[u8]) -> bool {
        Channel::send(
            self,
            PtyEvent::Data {
                data: B64.encode(bytes),
            },
        )
        .is_ok()
    }
    fn exit(&self, code: i32) {
        let _ = Channel::send(self, PtyEvent::Exit { code });
    }
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-unflushed bytes. On overflow we discard the entire
// pending buffer and emit an SGR-reset plus notice; dropping a partial
// prefix would slice a CSI sequence in half and corrupt xterm's screen
// state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim when backlog is dropped.
const OVERFLOW_NOTICE: &[u8] = b"\x1bc\x1b[2m[tedi: dropped output due to backpressure]\x1b[0m\r\n";

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: i32 },
}

pub struct Session {
    // Field drop order matters. Rust drops fields top-to-bottom:
    //   1. `_job`: on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE and terminates the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread.
    //   2. `killer`: best-effort kill (redundant on Windows once the Job
    //      closed, required on Unix where there is no Job).
    //   3. `writer`: closes the input side of the master pipe.
    //   4. `master`: ClosePseudoConsole on Windows. The child is dead by now.
    #[cfg(windows)]
    _job: Option<super::job::PtyJob>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (frontend
        // disconnected, window crashed, dev HMR), the reader/flusher threads
        // would stay alive forever holding the child. Kill the child here so
        // the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
// Serializes ConPTY lifecycle: openpty/spawn_command AND ClosePseudoConsole
// (which runs when the master is dropped). Overlapping ConPTY create + close
// corrupts the freshly-created console so its shell never pumps output - the
// pane stays blank. Symptom we hit: workspace restore disposes the default
// tab's PTY at the same instant the restored tabs spawn theirs; 1 pane
// works, the rest stay silent. Reader threads keep reading from already-live
// PTYs while this lock is held (it only gates lifecycle, not IO).
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// Drop an `Arc<Session>` while holding `SPAWN_LOCK` so ClosePseudoConsole
/// can't race a sibling spawn. Call this from the detached drop thread in
/// `mod::pty_close` instead of a bare `drop(s)`. Visible to `pty_daemon`
/// so the daemon's `close_session` can use the same SPAWN_LOCK protection.
pub fn drop_session(session: Arc<Session>) {
    let _guard = SPAWN_LOCK.lock().unwrap();
    drop(session);
}

pub fn spawn(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<(Arc<Session>, PtySize), String> {
    spawn_with_sink(cols, rows, cwd, Arc::new(on_event))
}

/// Generic-sink variant. The Channel-based `spawn` is a thin wrapper for
/// existing in-process callers; the daemon supplies its own
/// `Arc<dyn PtyEventSink>` that buffers scrollback and fans out to
/// subscribed clients. All thread orchestration is shared - the only
/// difference is where bytes land at the end of the flush.
pub fn spawn_with_sink(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    sink: Arc<dyn PtyEventSink>,
) -> Result<(Arc<Session>, PtySize), String> {
    let _spawn_guard = SPAWN_LOCK.lock().unwrap();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd = shell_init::build_command(cwd)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match super::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        killer: Mutex::new(killer),
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
    });

    let pending: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
    let done = Arc::new(AtomicBool::new(false));
    let spawn_at = Instant::now();

    let pending_r = pending.clone();
    let reader_thread = thread::Builder::new()
        .name("tedi-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut dropped_bytes: u64 = 0;
            let mut logged_first = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !logged_first {
                            logged_first = true;
                            log::info!("pty first byte after {}ms", spawn_at.elapsed().as_millis());
                        }
                        let mut g = pending_r.lock().unwrap();
                        if g.len() + n > MAX_PENDING {
                            // Discard the whole backlog rather than slicing
                            // through escape sequences. Emit a hard reset so
                            // xterm does not carry stale SGR/cursor state.
                            dropped_bytes += g.len() as u64;
                            g.clear();
                            g.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.extend_from_slice(&buf[..n]);
                    }
                    Err(e) => {
                        // Normal on child exit: the slave fd is closed and
                        // read(2) returns EIO on some platforms. Logged at
                        // debug to avoid noise in the common case.
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .map_err(|e| format!("spawn pty reader thread: {e}"))?;

    let sink_flush = sink.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    thread::Builder::new()
        .name("tedi-pty-flusher".into())
        .spawn(move || loop {
            thread::sleep(FLUSH_INTERVAL);
            let chunk = {
                let mut g = pending_f.lock().unwrap();
                if g.is_empty() {
                    if done_f.load(Ordering::Acquire) {
                        break;
                    }
                    continue;
                }
                std::mem::take(&mut *g)
            };
            // Sink decides encoding: Channel sink base64-encodes for the
            // Tauri JSON IPC, daemon sink stores raw + fans out to clients.
            if !sink_flush.data(&chunk) {
                log::debug!("pty flusher exiting, sink closed");
                break;
            }
        })
        .map_err(|e| {
            // Kill the child so the reader's blocking read() unblocks and
            // the (now lone) reader thread exits when we return Err.
            let _ = session.killer.lock().map(|mut k| k.kill());
            format!("spawn pty flusher thread: {e}")
        })?;

    let sink_exit = sink;
    let pending_e = pending;
    // Clone instead of move so the outer `done` stays accessible to the
    // map_err cleanup path below if waiter spawn fails.
    let done_e = done.clone();
    thread::Builder::new()
        .name("tedi-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Wait for the reader to hit EOF before snapshotting `pending`,
            // so the last line of output cannot race the Exit event.
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            let tail = std::mem::take(&mut *pending_e.lock().unwrap());
            if !tail.is_empty() {
                sink_exit.data(&tail);
            }
            done_e.store(true, Ordering::Release);
            sink_exit.exit(code);
        })
        .map_err(|e| {
            // Wake the flusher's empty-pending branch so it exits its loop,
            // and kill the child to unblock the reader.
            done.store(true, Ordering::Release);
            let _ = session.killer.lock().map(|mut k| k.kill());
            format!("spawn pty waiter thread: {e}")
        })?;

    Ok((session, size))
}
