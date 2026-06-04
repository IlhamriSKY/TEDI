use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const MAX_TIMEOUT_SECS: u64 = 120;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024; // 8 MiB — formatted files can be large.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Serialize)]
pub struct FormatOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Run an external formatter binary directly (no shell wrapper). Optional
/// stdin is piped in; stdout/stderr are captured. Distinct from the AI
/// `shell_run_command` because formatters need raw stdin piping and a tight
/// timeout, and bypassing the shell avoids quoting traps in user args.
#[tauri::command]
pub async fn fmt_run_external(
    program: String,
    args: Option<Vec<String>>,
    stdin: Option<String>,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<FormatOutput, String> {
    let program = program.trim().to_string();
    if program.is_empty() {
        return Err("empty program".into());
    }
    let args = args.unwrap_or_default();
    let cwd_path = if let Some(dir) = cwd.as_deref().filter(|s| !s.is_empty()) {
        let p = PathBuf::from(dir);
        if !p.is_dir() {
            return Err(format!("cwd is not a directory: {}", p.display()));
        }
        Some(p)
    } else {
        None
    };
    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    tauri::async_runtime::spawn_blocking(move || run_blocking(program, args, stdin, cwd_path, dur))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn run_blocking(
    program: String,
    args: Vec<String>,
    stdin_content: Option<String>,
    cwd: Option<PathBuf>,
    dur: Duration,
) -> Result<FormatOutput, String> {
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(if stdin_content.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Unix: put the child in its own process group (it becomes the group
    // leader) so a future group-kill could reach a backgrounded grandchild.
    // We do NOT force-kill the group on timeout: neither `libc` nor `nix` is a
    // dependency, so there is no std-only `kill(-pgid)`. The bounded-drain
    // below is the portable mitigation; orphan grandchildren holding the pipe
    // are NOT force-killed in this build (Windows is covered by the Job below).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        log::warn!("fmt_run_external spawn failed for {program}: {e}");
        format!("spawn failed: {e}")
    })?;

    // Windows: kill-on-close Job so a timeout kill takes down the whole tree.
    // Without it a grandchild holding the stdout/stderr pipe would keep the
    // pipe open and the drain threads would never reach EOF.
    #[cfg(windows)]
    let _job = crate::modules::pty::job::PtyJob::create_for(child.id()).ok();

    if let (Some(content), Some(mut pipe)) = (stdin_content, child.stdin.take()) {
        // Spawn a thread to write stdin so a huge payload can't block while
        // the child is still spinning up.
        thread::spawn(move || {
            let _ = pipe.write_all(content.as_bytes());
            // Drop closes the pipe → EOF for the child.
        });
    }

    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    // Drain into shared buffers + signal over a channel so we never block on a
    // `join()` that would pin this Tokio blocking-pool slot forever when a
    // grandchild keeps the pipe open past a timeout kill.
    //
    // `stop` bounds the drain threads on Unix where there is no Job Object to
    // close the pipe: after the child is reaped + a grace window the main
    // thread sets it, so the drain loops exit on their next read return rather
    // than leaking the thread + FD + buffer forever.
    let stop = Arc::new(AtomicBool::new(false));
    let stdout_buf: Arc<Mutex<(Vec<u8>, bool)>> = Arc::new(Mutex::new((Vec::new(), false)));
    let stderr_buf: Arc<Mutex<(Vec<u8>, bool)>> = Arc::new(Mutex::new((Vec::new(), false)));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    {
        let buf = stdout_buf.clone();
        let tx = done_tx.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            let res = drain(&mut stdout_pipe, &stop);
            *buf.lock().unwrap() = res;
            let _ = tx.send(());
        });
    }
    {
        let buf = stderr_buf.clone();
        let tx = done_tx;
        let stop = stop.clone();
        thread::spawn(move || {
            let res = drain(&mut stderr_pipe, &stop);
            *buf.lock().unwrap() = res;
            let _ = tx.send(());
        });
    }

    let started = Instant::now();
    let mut timed_out = false;
    let exit_code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if started.elapsed() >= dur {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        thread::sleep(POLL_INTERVAL);
    };

    // Bounded wait for the drains to flush; never block forever. `stop` then
    // tells the drain loops to exit on their next read return so a grandchild
    // holding the pipe can't leak the threads (Windows: the Job already does).
    const DRAIN_GRACE: Duration = Duration::from_secs(2);
    let _ = done_rx.recv_timeout(DRAIN_GRACE);
    let _ = done_rx.recv_timeout(DRAIN_GRACE);
    stop.store(true, Ordering::Release);
    let (stdout_bytes, stdout_truncated) = stdout_buf.lock().unwrap().clone();
    let (stderr_bytes, stderr_truncated) = stderr_buf.lock().unwrap().clone();

    Ok(FormatOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

fn drain<R: Read>(reader: &mut R, stop: &AtomicBool) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        // Bounded exit: stop draining once the caller signals (child reaped +
        // grace) so a grandchild holding the pipe can't leak this thread + FD.
        if stop.load(Ordering::Acquire) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= MAX_OUTPUT_BYTES {
                    truncated = true;
                    continue;
                }
                let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
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
