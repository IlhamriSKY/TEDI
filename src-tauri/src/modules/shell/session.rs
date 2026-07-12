use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use super::run_blocking;

/// Persistent agent shell session. Each `run` executes through the user's
/// login shell with the session's tracked cwd. Cwd persists across calls;
/// environment overrides via `export` do not. This is an agent shell, not
/// an interactive REPL; interactive tools must not be invoked here. Use the
/// background process API for long-running work.
pub struct ShellSession {
    pub cwd: Mutex<PathBuf>,
    /// While pristine (no `run` yet), caller-provided cwd hints reseed `cwd`.
    pub pristine: AtomicBool,
}

#[derive(Serialize)]
pub struct SessionRunOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub cwd_after: String,
}

/// Sentinel emitted on stdout right before the command exits so we can
/// recover the post-command cwd. Unlikely literal; collisions with real
/// output would corrupt cwd tracking.
const CWD_SENTINEL: &str = "__TEDI_CWD__";

impl ShellSession {
    pub fn new(initial_cwd: PathBuf) -> Self {
        Self {
            cwd: Mutex::new(initial_cwd),
            pristine: AtomicBool::new(true),
        }
    }

    pub fn current_cwd(&self) -> PathBuf {
        self.cwd.lock().unwrap().clone()
    }

    pub fn run(
        &self,
        command: String,
        cwd_hint: Option<String>,
        timeout: Duration,
    ) -> Result<SessionRunOutput, String> {
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if self.pristine.load(Ordering::Acquire) {
            if let Some(hint) = cwd_hint.filter(|s| !s.is_empty()) {
                let p = PathBuf::from(&hint);
                if p.is_dir() {
                    *self.cwd.lock().unwrap() = p;
                }
            }
        }
        let cwd = self.current_cwd();
        let wrapped = wrap_with_sentinel(&trimmed);

        // Already on Tauri's blocking pool (see the single caller in mod.rs), and
        // run_blocking is a self-contained sync fn, so call it directly instead of
        // hopping to a throwaway thread and blocking on a channel.
        let raw = run_blocking(wrapped, Some(cwd), timeout)?;
        self.pristine.store(false, Ordering::Release);

        let (stdout_clean, cwd_after) = strip_cwd_sentinel(&raw.stdout);
        if let Some(ref new_cwd) = cwd_after {
            let p = PathBuf::from(new_cwd);
            if p.is_dir() {
                *self.cwd.lock().unwrap() = p;
            }
        }
        let resolved_cwd = crate::modules::fs::to_canon(self.current_cwd());

        Ok(SessionRunOutput {
            stdout: stdout_clean,
            stderr: raw.stderr,
            exit_code: raw.exit_code,
            timed_out: raw.timed_out,
            truncated: raw.truncated,
            cwd_after: resolved_cwd,
        })
    }
}

#[cfg(unix)]
fn wrap_with_sentinel(command: &str) -> String {
    format!(
        "{command}\n__tedi_rc=$?\nprintf '\\n%s%s\\n' '{CWD_SENTINEL}' \"$(pwd)\"\nexit $__tedi_rc\n",
    )
}

#[cfg(windows)]
fn wrap_with_sentinel(command: &str) -> String {
    format!(
        "{command}\n$__tedi_rc = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\n\"`n{CWD_SENTINEL}$($PWD.Path)\"\nexit $__tedi_rc\n",
    )
}

fn strip_cwd_sentinel(stdout: &str) -> (String, Option<String>) {
    if let Some(idx) = stdout.rfind(CWD_SENTINEL) {
        let before = &stdout[..idx];
        let after = &stdout[idx + CWD_SENTINEL.len()..];
        let cwd_line = after.lines().next().unwrap_or("").trim();
        let cleaned = before.trim_end_matches('\n').to_string();
        return (cleaned, Some(cwd_line.to_string()));
    }
    (stdout.to_string(), None)
}
