use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use shared_child::SharedChild;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::modules::lockext::LockExt;

use super::ringbuffer::BoundedRingBuffer;

const RING_CAP: usize = 4 * 1024 * 1024;

/// Suppress the auto-allocated console window Windows hands a
/// console-subsystem child of a GUI parent. Without it, every sidecar exe
/// (e.g. `tedi-discord-helper.exe`) flashes a black cmd window on spawn.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct BackgroundProc {
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub child: Arc<SharedChild>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    pub exit_code: AtomicI32,
    pub exit_unknown: AtomicBool,
    // Bounds the reader threads on Unix where there is no Job Object to close
    // the pipe: the wait-thread sets it after the child is reaped + a grace
    // window, so the readers exit on their next read return rather than leaking
    // the thread + FD + ring buffer when a backgrounded grandchild holds the
    // stdout/stderr pipe open. A fully silent held pipe still parks the reader
    // until its next read return; orphan grandchildren are NOT force-killed in
    // this build (no `libc`/`nix` dep for `kill(-pgid)`).
    stop_readers: AtomicBool,
    // Windows: kill-on-close Job Object catches descendants when TEDI dies.
    // Without it a pwsh-wrapped `npm run dev` leaks its node grandchild.
    #[cfg(windows)]
    _job: Option<crate::modules::pty::job::PtyJob>,
}

#[derive(Serialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct BackgroundProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl BackgroundProc {
    pub fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        let (bytes, next_offset, dropped) = self.buffer.lock_or_recover().read_from(since);
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }

    pub fn kill(&self) {
        // Unix: `SharedChild::kill` only kills the direct child (the shell or
        // binary), not a backgrounded grandchild that inherited the pipe. There
        // is no `libc`/`nix` dep here to `kill(-pgid)` the whole group, so we
        // also signal the reader threads to stop draining; otherwise a surviving
        // grandchild holding the pipe would leak them. Windows force-kills the
        // tree via the kill-on-close Job Object, so this is a no-op cost there.
        let _ = self.child.kill();
        self.stop_readers.store(true, Ordering::Release);
    }

    pub fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
        }
    }
}

impl Drop for BackgroundProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(command: String, cwd: Option<String>) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !PathBuf::from(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let mut cmd = super::build_oneshot_command(&trimmed);
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    track_spawned(&mut cmd, trimmed, cwd)
}

/// Direct-binary background spawn. Unlike [`spawn`], this never wraps the
/// program in a shell. The tracked PID is the binary's own process, so
/// `shell_bg_kill` actually terminates it. Use this for extension-bundled
/// native sidecars where a leaked grandchild would keep talking to
/// external systems (Discord IPC, etc.) after the parent thinks it's gone.
pub fn spawn_direct(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<Arc<BackgroundProc>, String> {
    if program.trim().is_empty() {
        return Err("empty program".into());
    }
    if let Some(ref dir) = cwd {
        if !PathBuf::from(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args);
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    // Display string for the supervisor's bookkeeping. Not parsed; surfaced
    // only via `shell_bg_list` and debug output.
    let display = if args.is_empty() {
        program.clone()
    } else {
        format!("{program} {}", args.join(" "))
    };
    track_spawned(&mut cmd, display, cwd)
}

/// Shared spawn-and-track plumbing used by [`spawn`] (shell-wrapped) and
/// [`spawn_direct`] (no wrapper). Sets up stdio redirects, hands the child
/// to `SharedChild`, and starts the three logging and wait threads.
fn track_spawned(
    cmd: &mut std::process::Command,
    display: String,
    cwd: Option<String>,
) -> Result<Arc<BackgroundProc>, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Unix: put the child in its own process group (it becomes the group
    // leader) so a future group-kill could reach a backgrounded grandchild.
    // We do NOT force-kill the group: neither `libc` nor `nix` is a dependency,
    // so there is no std-only `kill(-pgid)`. The bounded reader threads
    // (see `stop_readers`) are the portable mitigation; orphan grandchildren
    // holding the pipe are NOT force-killed here (Windows uses the Job below).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let shared = SharedChild::spawn(cmd).map_err(|e| e.to_string())?;
    let stdout_pipe = shared.take_stdout().ok_or("no stdout pipe")?;
    let stderr_pipe = shared.take_stderr().ok_or("no stderr pipe")?;

    #[cfg(windows)]
    let job = match crate::modules::pty::job::PtyJob::create_for(shared.id()) {
        Ok(j) => Some(j),
        Err(e) => {
            log::warn!(
                "shell bg job-object setup failed for pid={}: {e}",
                shared.id()
            );
            None
        }
    };

    let child = Arc::new(shared);

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(BackgroundProc {
        command: display,
        cwd,
        started_at_ms,
        child,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
        stop_readers: AtomicBool::new(false),
        #[cfg(windows)]
        _job: job,
    });

    {
        let proc_ref = proc.clone();
        let mut pipe = stdout_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                // Bounded exit: stop reading once `kill`/the wait-thread signals
                // (child reaped + grace) so a grandchild holding the pipe can't
                // leak this thread + FD. Checked between reads.
                if proc_ref.stop_readers.load(Ordering::Acquire) {
                    break;
                }
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => proc_ref.buffer.lock_or_recover().push(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let mut pipe = stderr_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if proc_ref.stop_readers.load(Ordering::Acquire) {
                    break;
                }
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => proc_ref.buffer.lock_or_recover().push(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        thread::spawn(move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            proc_ref.exited.store(true, Ordering::Release);
            // The direct child is reaped; on Unix a backgrounded grandchild may
            // still hold the pipe, so the readers above would block forever on
            // `read`. After a grace window, signal them to stop draining so the
            // threads + FDs + ring buffer are released. The reader exits on its
            // next read return (Windows: the Job already closed the pipe).
            const READER_GRACE: Duration = Duration::from_secs(2);
            thread::sleep(READER_GRACE);
            proc_ref.stop_readers.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}
