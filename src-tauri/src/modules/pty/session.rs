use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::modules::lockext::LockExt;

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

/// Bytes the reader has taken off the PTY and the flusher has not shipped yet,
/// together with whether the session has ended.
///
/// `done` lives INSIDE the mutex, and that is load-bearing rather than tidy.
/// The flusher decides whether to park while holding this lock. A flag stored
/// outside it could be set in the window between that decision and the park,
/// and the `notify_one` that accompanies it would fire into an empty wait list.
/// The flusher would then sleep forever on a session that had already ended,
/// leaking its thread and keeping the sink (a Tauri channel, or the daemon
/// per-session fan-out) alive with it. Keeping the flag here makes the
/// check-and-park atomic with respect to it by construction.
struct Pending {
    bytes: Vec<u8>,
    /// Set by the waiter once the shell has exited and it has shipped the final
    /// bytes. The flusher unwinds the first time it sees this with an empty
    /// buffer.
    done: bool,
}

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
    // Shell leader pid, kept so the Windows tree-kill can fall back to
    // `taskkill /T` when the Job Object was never created (see `kill_tree`).
    #[cfg(windows)]
    leader_pid: Option<u32>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Session {
    /// Kill the whole child process tree, best-effort and synchronous. On Unix
    /// `killer.kill()` is the whole story. On Windows `killer.kill()` only
    /// `TerminateProcess`es the shell leader (portable-pty's ConPTY killer),
    /// so a `claude`/`node` running inside would be orphaned - the tree only
    /// dies via the Job Object. Terminate the job here so children die the
    /// instant the tab closes instead of waiting for the deferred `Session`
    /// drop; if the job was never created (create_for failed), walk the pid
    /// tree with `taskkill /T` BEFORE the leader kill, while the tree is still
    /// rooted at the live leader.
    pub fn kill_tree(&self) {
        #[cfg(windows)]
        {
            if let Some(job) = &self._job {
                job.terminate();
            } else if let Some(pid) = self.leader_pid {
                taskkill_tree(pid);
            }
        }
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

/// `taskkill /F /T /PID <pid>` - forcibly kill a process and its descendants.
/// The only job-independent tree kill on Windows; used as the fallback when
/// the Job Object is absent. Detached and best-effort (a closing tab must not
/// block on it); `CREATE_NO_WINDOW` keeps a console flash from appearing.
#[cfg(windows)]
fn taskkill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (frontend
        // disconnected, window crashed, dev HMR), the reader/flusher threads
        // would stay alive forever holding the child. Kill the child here so
        // the reader hits EOF and the threads unwind.
        #[cfg(windows)]
        {
            // Job present: closing its handle (in the field drop below) fires
            // KILL_ON_JOB_CLOSE and reaps the tree. Job absent (create_for
            // failed): the leader kill can't reach descendants, so walk the pid
            // tree first while the leader is still alive.
            if self._job.is_none() {
                if let Some(pid) = self.leader_pid {
                    taskkill_tree(pid);
                }
            }
        }
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
    let _guard = SPAWN_LOCK.lock_or_recover();
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
    let _spawn_guard = SPAWN_LOCK.lock_or_recover();

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
    let leader_pid = child.process_id();
    #[cfg(windows)]
    let job = match leader_pid {
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
        #[cfg(windows)]
        leader_pid,
        killer: Mutex::new(killer),
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
    });

    // Bytes the reader has taken off the PTY and the flusher has not shipped
    // yet, plus the condvar the reader signals when it appends.
    //
    // The condvar is what keeps an idle shell free. The flusher used to be a
    // bare `sleep(FLUSH_INTERVAL)` poll, so every live session woke a thread
    // 125 times a second forever whether or not the shell had produced a byte:
    // on the sidecar daemon that poll was measurably ALL of its idle CPU (the
    // only threads burning any were exactly the ones matching live sessions,
    // with no output flowing).
    //
    // The trade is a little first-byte latency. The old poll was free-running,
    // so a byte arriving mid-cycle waited a mean of 4 ms for the next wake;
    // parking wakes on the byte itself but then sleeps a full FLUSH_INTERVAL to
    // collect the rest of the burst, so the first byte after a quiet spell now
    // waits ~8 ms. That is half a frame on the echo path and buys an idle
    // terminal that costs nothing at all.
    let pending: Arc<(Mutex<Pending>, Condvar)> = Arc::new((
        Mutex::new(Pending {
            bytes: Vec::with_capacity(READ_BUF),
            done: false,
        }),
        Condvar::new(),
    ));
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
                        {
                            let mut g = pending_r.0.lock_or_recover();
                            if g.bytes.len() + n > MAX_PENDING {
                                // Discard the whole backlog rather than slicing
                                // through escape sequences. Emit a hard reset so
                                // xterm does not carry stale SGR/cursor state.
                                dropped_bytes += g.bytes.len() as u64;
                                g.bytes.clear();
                                g.bytes.extend_from_slice(OVERFLOW_NOTICE);
                            }
                            g.bytes.extend_from_slice(&buf[..n]);
                        }
                        // Guard dropped first: the flusher wakes straight into
                        // the lock rather than into contention on it.
                        pending_r.1.notify_one();
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
    thread::Builder::new()
        .name("tedi-pty-flusher".into())
        .spawn(move || {
            // Handed to the buffer on each flush so the next window writes into
            // the capacity this one already grew, instead of starting from
            // empty and walking the doubling chain again 125 times a second.
            let mut spare: Vec<u8> = Vec::with_capacity(READ_BUF);
            let (lock, cv) = &*pending_f;
            loop {
                // Park until the reader has something, or the session ended.
                {
                    let mut g = lock.lock_or_recover();
                    while g.bytes.is_empty() && !g.done {
                        g = cv.wait(g).unwrap_or_else(|e| e.into_inner());
                    }
                    // Empty and done: the waiter already shipped the tail.
                    if g.bytes.is_empty() {
                        break;
                    }
                }
                // Let the rest of the burst land so one flush carries a whole
                // window. This is the coalescing the fixed-interval poll used
                // to provide, and it is what keeps a build log from becoming
                // one IPC message per read.
                thread::sleep(FLUSH_INTERVAL);
                let chunk = std::mem::replace(&mut lock.lock_or_recover().bytes, spare);
                // The waiter can take the tail while this thread is inside the
                // coalescing sleep, which leaves nothing here. Shipping an empty
                // frame would be harmless but pointless, and the fixed-interval
                // poll this replaced never did it.
                if chunk.is_empty() {
                    spare = chunk;
                    continue;
                }
                // Sink decides encoding: Channel sink base64-encodes for the
                // Tauri JSON IPC, daemon sink stores raw + fans out to clients.
                if !sink_flush.data(&chunk) {
                    log::debug!("pty flusher exiting, sink closed");
                    break;
                }
                spare = chunk;
                spare.clear();
                // A single overflow window can leave 4 MiB of capacity behind;
                // keep a working window's worth and give the rest back.
                spare.shrink_to(READ_BUF * 4);
            }
        })
        .map_err(|e| {
            // Kill the child so the reader's blocking read() unblocks and
            // the (now lone) reader thread exits when we return Err.
            let _ = session.killer.lock().map(|mut k| k.kill());
            format!("spawn pty flusher thread: {e}")
        })?;

    let sink_exit = sink;
    // Clone instead of move so the outer `pending` stays reachable from the
    // map_err path below: if the waiter fails to spawn, that path has to mark
    // the session done and wake the flusher off its condvar itself.
    let pending_e = pending.clone();
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
            // One lock for both, so the flusher cannot observe "not done, and
            // nothing to send" and park just as this thread finishes. See
            // `Pending`.
            let tail = {
                let mut g = pending_e.0.lock_or_recover();
                g.done = true;
                std::mem::take(&mut g.bytes)
            };
            // The flusher parks on the condvar now, so setting `done` alone no
            // longer reaches it.
            pending_e.1.notify_one();
            if !tail.is_empty() {
                sink_exit.data(&tail);
            }
            sink_exit.exit(code);
        })
        .map_err(|e| {
            // Wake the flusher's empty-pending branch so it exits its loop,
            // and kill the child to unblock the reader. Same lock discipline
            // as the waiter above.
            pending.0.lock_or_recover().done = true;
            pending.1.notify_one();
            let _ = session.killer.lock().map(|mut k| k.kill());
            format!("spawn pty waiter thread: {e}")
        })?;

    Ok((session, size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    enum Ev {
        Data(Vec<u8>),
        Exit(i32),
    }

    /// Sink that forwards everything to one channel.
    ///
    /// It owns the only `Sender`, so the receiver seeing `Disconnected` means
    /// every `Arc` clone of the sink has been dropped, i.e. the flusher and the
    /// waiter threads have both unwound. That is the observable the teardown
    /// test asserts on.
    struct CollectSink {
        tx: mpsc::Sender<Ev>,
    }

    impl PtyEventSink for CollectSink {
        fn data(&self, bytes: &[u8]) -> bool {
            self.tx.send(Ev::Data(bytes.to_vec())).is_ok()
        }
        fn exit(&self, code: i32) {
            let _ = self.tx.send(Ev::Exit(code));
        }
    }

    struct Harness {
        /// `None` once `close()` has run, mirroring `pty_close` handing the
        /// session to `drop_session`.
        session: Option<Arc<Session>>,
        rx: mpsc::Receiver<Ev>,
        seen: String,
        exited: Option<i32>,
        hung_up: bool,
    }

    impl Harness {
        /// `None` when this environment has no usable shell, so the tests skip
        /// rather than fail on a machine that cannot spawn one.
        fn start() -> Option<Self> {
            let (tx, rx) = mpsc::channel();
            let (session, _size) =
                spawn_with_sink(80, 24, None, Arc::new(CollectSink { tx })).ok()?;
            Some(Harness {
                session: Some(session),
                rx,
                seen: String::new(),
                exited: None,
                hung_up: false,
            })
        }

        fn write(&self, bytes: &[u8]) {
            if let Some(s) = &self.session {
                let _ = s.writer.lock().unwrap().write_all(bytes);
            }
        }

        /// What closing a terminal actually does. Dropping the session closes
        /// the pseudoconsole, which is what lets the reader see EOF; hold it and
        /// ConPTY keeps the pipe open no matter what the shell did.
        fn close(&mut self) {
            if let Some(s) = self.session.take() {
                s.kill_tree();
                drop_session(s);
            }
        }

        /// Pump events until `stop` is satisfied or the deadline passes.
        ///
        /// Answers ConPTY's opening `ESC[6n` cursor-position query the way a
        /// terminal would: without a reply ConPTY waits and the shell never
        /// reaches a prompt, so nothing else would ever happen.
        fn pump(&mut self, secs: u64, mut stop: impl FnMut(&Harness) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(secs);
            let mut answered_cpr = false;
            while Instant::now() < deadline {
                if stop(self) {
                    return;
                }
                match self.rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(Ev::Data(chunk)) => self.seen.push_str(&String::from_utf8_lossy(&chunk)),
                    Ok(Ev::Exit(code)) => self.exited = Some(code),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        self.hung_up = true;
                        return;
                    }
                }
                if !answered_cpr && self.seen.contains("[6n") {
                    answered_cpr = true;
                    self.write(b"\x1b[1;1R");
                }
            }
        }

        /// Wait for the shell to print a prompt, so input is not typed into a
        /// shell that is still starting up.
        fn wait_for_prompt(&mut self) {
            self.pump(45, |h| h.seen.contains("133;B") || h.seen.len() > 120);
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.close();
        }
    }

    /// The flusher parks on a condvar instead of polling on a timer, which
    /// makes the reader's `notify_one` load-bearing: miss it and a terminal
    /// never paints, with nothing in the logs to say why. A unit test over the
    /// buffer cannot catch that, because the bug IS the handoff, so this drives
    /// a real shell through the real reader/flusher/sink chain.
    ///
    /// It covers the PARKED path rather than a single delivery: the flusher
    /// ships ConPTY's opening query, finds the buffer empty, parks again, and
    /// only a working notify gets the echoed command out afterwards.
    #[test]
    fn output_reaches_the_sink_through_the_parked_flusher() {
        let Some(mut h) = Harness::start() else {
            eprintln!("no usable shell in this environment; skipping");
            return;
        };
        h.wait_for_prompt();
        h.write(b"echo TEDI_FLUSH_OK\r\n");
        // Twice: once as the echoed command line, once as its output. One
        // occurrence would also be satisfied by a shell that never ran it.
        h.pump(45, |h| h.seen.matches("TEDI_FLUSH_OK").count() >= 2);
        let hits = h.seen.matches("TEDI_FLUSH_OK").count();
        assert!(
            hits >= 2,
            "flusher delivered {hits} copies of the marker in {} bytes; the reader \
             notify or the condvar wait is broken",
            h.seen.len()
        );
    }

    /// Closing a terminal must unwind every thread it started.
    ///
    /// This is the guard on the lost wakeup that [`Pending`] exists to prevent.
    /// A flag set outside the buffer mutex would let the flusher read "not
    /// done", the waiter set it and fire `notify_one` into an empty wait list,
    /// and the flusher park forever on a finished session, leaking its thread
    /// and holding the sink alive with it. The window is invisible in review
    /// and rare enough to survive manual testing, so it needs a test that
    /// fails on the symptom: threads that never let go.
    ///
    /// `Disconnected` is the assertion: the sink owns the only `Sender`, so the
    /// receiver only hangs up once the flusher and the waiter have both dropped
    /// their `Arc` of it. A parked flusher never would.
    #[test]
    fn closing_a_session_unwinds_every_thread() {
        let Some(mut h) = Harness::start() else {
            eprintln!("no usable shell in this environment; skipping");
            return;
        };
        h.wait_for_prompt();
        h.close();
        h.pump(60, |h| h.hung_up);
        assert!(
            h.hung_up,
            "the PTY threads still held the sink 60s after the session was dropped \
             (exit event: {:?}, {} bytes seen) - a thread is parked and leaked",
            h.exited,
            h.seen.len()
        );
    }
}
