//! Spawn a process and capture bounded stdout/stderr without leaking a thread.
//!
//! Two callers want this and had a copy each: `shell_run_command` (the agent's
//! hidden shell) and `fmt_run_external` (a formatter binary). They differ only
//! in how the `Command` is built and in how much output they will hold, but
//! each carried its own ~90 lines of drain threads, stop flag, timeout poll and
//! grace window. Concurrency written twice is the shape that rots: every fix
//! below had to be remembered in both places.
//!
//! WHY IT IS THIS INVOLVED. A naive `output()` deadlocks the moment the child
//! fills a pipe buffer, so both pipes are drained on their own threads. But a
//! `join()` on those threads would then pin a Tokio blocking-pool slot forever
//! whenever a backgrounded GRANDCHILD inherits the pipe and outlives the kill,
//! so the threads signal over a channel and the wait is bounded instead. The
//! `stop` flag is the other half of that: after the child is reaped and the
//! grace window passes, it lets the drain loops exit on their next read return
//! rather than leaking a thread, an FD and a buffer. A fully silent held pipe
//! still parks its thread until it closes; that is the residual, and it is
//! bounded on Windows by the Job Object below.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Long enough for a clean exit's two drain signals to arrive, short enough
/// that a stuck pipe does not hold the caller.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

pub struct Options {
    pub timeout: Duration,
    /// Per-stream cap. Past it, output is dropped and `truncated` is set.
    pub max_bytes: usize,
    /// How often the child is checked for exit.
    pub poll: Duration,
    /// Written to the child's stdin, which is then closed. `None` gives it
    /// `/dev/null` instead.
    pub stdin: Option<String>,
    /// Names the process in the spawn-failure log line.
    pub what: &'static str,
}

pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Run `cmd` to completion or to `timeout`, whichever comes first.
///
/// The caller supplies the program, args, cwd and env; stdio, the process
/// group and the Windows creation flags are set here so both callers get the
/// same treatment.
pub fn run(mut cmd: Command, opts: Options) -> Result<Captured, String> {
    let wants_stdin = opts.stdin.is_some();
    cmd.stdin(if wants_stdin {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Unix: make the child its own process-group leader so a future group-kill
    // could reach a backgrounded grandchild. Nothing kills the group today -
    // neither `libc` nor `nix` is a dependency, so there is no std-only
    // `kill(-pgid)` - and the bounded drain below is the portable mitigation.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    crate::modules::appimage::sanitize_env(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        log::warn!("{} spawn failed: {e}", opts.what);
        e.to_string()
    })?;

    // Windows: a kill-on-close Job so a timeout kill takes down the whole tree.
    // Without it a grandchild holding the pipes keeps them open and the drains
    // never see EOF. Dropped at end of scope, killing any survivors.
    #[cfg(windows)]
    let _job = crate::modules::pty::job::PtyJob::create_for(child.id()).ok();

    if let (Some(content), Some(mut pipe)) = (opts.stdin, child.stdin.take()) {
        // On its own thread: a large payload would otherwise block while the
        // child is still starting. The drop closes the pipe, which is the EOF
        // the child waits for.
        thread::spawn(move || {
            let _ = pipe.write_all(content.as_bytes());
        });
    }

    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    let stop = Arc::new(AtomicBool::new(false));
    let out_buf: Buffer = Arc::new(Mutex::new((Vec::new(), false)));
    let err_buf: Buffer = Arc::new(Mutex::new((Vec::new(), false)));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    drain_on_thread(
        stdout_pipe,
        stop.clone(),
        out_buf.clone(),
        done_tx.clone(),
        opts.max_bytes,
    );
    drain_on_thread(
        stderr_pipe,
        stop.clone(),
        err_buf.clone(),
        done_tx,
        opts.max_bytes,
    );

    let started = Instant::now();
    let mut timed_out = false;
    let exit_code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if started.elapsed() >= opts.timeout {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        thread::sleep(opts.poll);
    };

    // On a clean exit both signals are already waiting; on a stuck pipe we
    // proceed with whatever was buffered and then release the drain threads.
    let _ = done_rx.recv_timeout(DRAIN_GRACE);
    let _ = done_rx.recv_timeout(DRAIN_GRACE);
    stop.store(true, Ordering::Release);

    let (stdout_bytes, stdout_truncated) = out_buf.lock().unwrap().clone();
    let (stderr_bytes, stderr_truncated) = err_buf.lock().unwrap().clone();
    Ok(Captured {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

/// Captured bytes, and whether the cap was hit.
type Buffer = Arc<Mutex<(Vec<u8>, bool)>>;

fn drain_on_thread(
    mut pipe: impl Read + Send + 'static,
    stop: Arc<AtomicBool>,
    buf: Buffer,
    tx: mpsc::Sender<()>,
    max_bytes: usize,
) {
    thread::spawn(move || {
        *buf.lock().unwrap() = drain(&mut pipe, &stop, max_bytes);
        let _ = tx.send(());
    });
}

fn drain<R: Read>(reader: &mut R, stop: &AtomicBool, max_bytes: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        // Checked between reads, so a held-but-silent pipe still parks here
        // until it closes. That is the bound described at the top of the file.
        if stop.load(Ordering::Acquire) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= max_bytes {
                    truncated = true;
                    continue;
                }
                let take = (max_bytes - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(text: &str) -> Command {
        let mut c = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo", text]);
            c
        } else {
            let mut c = Command::new("echo");
            c.arg(text);
            c
        };
        c.env("TEDI_TEST", "1");
        c
    }

    fn opts() -> Options {
        Options {
            timeout: Duration::from_secs(10),
            max_bytes: 64 * 1024,
            poll: Duration::from_millis(10),
            stdin: None,
            what: "test",
        }
    }

    #[test]
    fn captures_stdout_and_exit_code() {
        let got = run(echo("hello"), opts()).expect("spawn");
        assert!(got.stdout.contains("hello"), "stdout was {:?}", got.stdout);
        assert_eq!(got.exit_code, Some(0));
        assert!(!got.timed_out);
        assert!(!got.truncated);
    }

    /// The cap is what stops a runaway command eating memory, so a breach has
    /// to be REPORTED, not silently swallowed.
    #[test]
    fn a_capped_stream_is_marked_truncated() {
        let mut o = opts();
        o.max_bytes = 2;
        let got = run(echo("hello"), o).expect("spawn");
        assert!(got.truncated, "2-byte cap on 'hello' must truncate");
        assert!(got.stdout.len() <= 2);
    }

    #[test]
    fn a_missing_program_is_an_error_not_a_panic() {
        assert!(run(Command::new("tedi-no-such-program-xyz"), opts()).is_err());
    }
}
