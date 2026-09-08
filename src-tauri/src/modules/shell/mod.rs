pub mod background;
pub mod capture;
pub mod ringbuffer;
pub mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Serialize;

use background::{BackgroundLogResponse, BackgroundProc, BackgroundProcInfo};
use session::{SessionRunOutput, ShellSession};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Run a one-shot command via the user's login shell. Output is capped and
/// the process is force-killed on timeout. Output does not flow into the
/// user's interactive PTY (that would fight their input); AI tool calls
/// surface in chat as a structured result.
#[tauri::command]
pub async fn shell_run_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

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

    // Blocking spawn + wait on Tokio's dedicated blocking pool via Tauri's
    // wrapper. The earlier hand-rolled `thread::spawn` + `rx.recv()` moved
    // work off-thread but then blocked the async future on the channel,
    // defeating the runtime.
    tauri::async_runtime::spawn_blocking(move || run_blocking(trimmed, cwd_path, dur))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub(crate) fn run_blocking(
    command: String,
    cwd: Option<PathBuf>,
    dur: Duration,
) -> Result<CommandOutput, String> {
    let mut cmd = build_oneshot_command(&command);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let got = capture::run(
        cmd,
        capture::Options {
            timeout: dur,
            max_bytes: MAX_OUTPUT_BYTES,
            poll: POLL_INTERVAL,
            stdin: None,
            what: "shell_run_command",
        },
    )?;
    Ok(CommandOutput {
        stdout: got.stdout,
        stderr: got.stderr,
        exit_code: got.exit_code,
        timed_out: got.timed_out,
        truncated: got.truncated,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Persistent agent shell state + background process state.
// ──────────────────────────────────────────────────────────────────────────

pub struct ShellState {
    sessions: RwLock<HashMap<u32, Arc<ShellSession>>>,
    bg: RwLock<HashMap<u32, Arc<BackgroundProc>>>,
    next_session_id: AtomicU32,
    next_bg_id: AtomicU32,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            bg: RwLock::new(HashMap::new()),
            next_session_id: AtomicU32::new(1),
            next_bg_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
pub fn shell_session_open(
    state: tauri::State<ShellState>,
    cwd: Option<String>,
) -> Result<u32, String> {
    let initial = match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(c) => {
            let p = PathBuf::from(c);
            if !p.is_dir() {
                return Err(format!("cwd is not a directory: {c}"));
            }
            p
        }
        None => dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
    };
    let session = Arc::new(ShellSession::new(initial));
    let id = state.next_session_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().unwrap().insert(id, session);
    Ok(id)
}

#[tauri::command]
pub async fn shell_session_run(
    state: tauri::State<'_, ShellState>,
    id: u32,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<SessionRunOutput, String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    tauri::async_runtime::spawn_blocking(move || session.run(command, cwd, dur))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub fn shell_session_close(state: tauri::State<ShellState>, id: u32) -> Result<(), String> {
    state.sessions.write().unwrap().remove(&id);
    Ok(())
}

/// Max EXITED background procs retained for post-mortem log inspection.
/// Beyond this, the oldest exited entries are dropped on the next spawn so a
/// long agent session that churns dev servers/watchers cannot grow `bg`
/// without bound. Live procs are never reaped.
const MAX_RETAINED_EXITED: usize = 32;

/// Drop exited background procs beyond `MAX_RETAINED_EXITED`, oldest first
/// (handle id ascends with spawn order). Dropping the `Arc` frees the ring
/// buffer and OS/Job handles via `BackgroundProc::Drop`. Live procs are kept.
fn reap_exited_bg(map: &mut HashMap<u32, Arc<BackgroundProc>>) {
    let mut exited: Vec<u32> = map
        .iter()
        .filter(|(_, p)| p.exited.load(Ordering::Acquire))
        .map(|(id, _)| *id)
        .collect();
    if exited.len() <= MAX_RETAINED_EXITED {
        return;
    }
    exited.sort_unstable();
    let drop_count = exited.len() - MAX_RETAINED_EXITED;
    for id in exited.into_iter().take(drop_count) {
        map.remove(&id);
    }
}

/// The `CreateProcess` is offloaded: a sync `#[tauri::command]` runs on the
/// WebView2 UI thread on Windows, and spawning through the host shell there
/// costs hundreds of ms. `state` cannot cross into the blocking pool (it is
/// borrowed, not `'static`), so only the spawn goes over; the registry insert
/// after the await is a HashMap write.
#[tauri::command]
pub async fn shell_bg_spawn(
    state: tauri::State<'_, ShellState>,
    command: String,
    cwd: Option<String>,
) -> Result<u32, String> {
    let proc = tauri::async_runtime::spawn_blocking(move || background::spawn(command, cwd))
        .await
        .map_err(|e| format!("shell_bg_spawn join error: {e}"))??;
    let id = state.next_bg_id.fetch_add(1, Ordering::Relaxed);
    let mut map = state.bg.write().unwrap();
    reap_exited_bg(&mut map);
    map.insert(id, proc);
    Ok(id)
}

/// Background spawn that bypasses the host shell. The tracked PID is the
/// binary itself, so `shell_bg_kill` actually terminates the program rather
/// than a `pwsh` / `bash` wrapper that leaks the real child. Use this for
/// extension sidecars where a leaked grandchild would keep an external
/// connection alive (e.g. Discord IPC) after the extension is disabled.
#[tauri::command]
pub async fn shell_bg_spawn_direct(
    state: tauri::State<'_, ShellState>,
    program: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<u32, String> {
    let proc = tauri::async_runtime::spawn_blocking(move || {
        background::spawn_direct(program, args.unwrap_or_default(), cwd)
    })
    .await
    .map_err(|e| format!("shell_bg_spawn_direct join error: {e}"))??;
    let id = state.next_bg_id.fetch_add(1, Ordering::Relaxed);
    let mut map = state.bg.write().unwrap();
    reap_exited_bg(&mut map);
    map.insert(id, proc);
    Ok(id)
}

#[tauri::command]
pub fn shell_bg_logs(
    state: tauri::State<ShellState>,
    handle: u32,
    since_offset: Option<u64>,
) -> Result<BackgroundLogResponse, String> {
    let proc = state
        .bg
        .read()
        .unwrap()
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no background handle".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub fn shell_bg_kill(state: tauri::State<ShellState>, handle: u32) -> Result<(), String> {
    if let Some(proc) = state.bg.read().unwrap().get(&handle).cloned() {
        proc.kill();
    }
    Ok(())
}

/// Drop a background proc from the registry. The `Arc` drop kills the child (a
/// no-op if already exited) and frees its ring buffer + OS/Job handles via
/// `BackgroundProc::Drop`. Use after the caller no longer needs its logs;
/// exited entries are also reaped automatically on the next spawn.
#[tauri::command]
pub fn shell_bg_remove(state: tauri::State<ShellState>, handle: u32) -> Result<(), String> {
    state.bg.write().unwrap().remove(&handle);
    Ok(())
}

#[tauri::command]
pub fn shell_bg_list(state: tauri::State<ShellState>) -> Result<Vec<BackgroundProcInfo>, String> {
    let map = state.bg.read().unwrap();
    let mut out = Vec::with_capacity(map.len());
    for (id, p) in map.iter() {
        out.push(p.info(*id));
    }
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

pub(crate) fn build_oneshot_command(command: &str) -> Command {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = Command::new(shell);
        cmd.arg("-lc").arg(command);
        crate::modules::appimage::sanitize_env(&mut cmd);
        cmd
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let mut cmd = Command::new(&shell);
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        if is_cmd {
            cmd.arg("/C").arg(command);
        } else {
            cmd.arg("-NoProfile").arg("-Command").arg(command);
        }
        cmd
    }
}
