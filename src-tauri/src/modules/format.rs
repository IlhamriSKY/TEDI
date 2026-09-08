use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::modules::shell::capture;

use serde::Serialize;

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
    let got = capture::run(
        cmd,
        capture::Options {
            timeout: dur,
            max_bytes: MAX_OUTPUT_BYTES,
            poll: POLL_INTERVAL,
            stdin: stdin_content,
            what: "fmt_run_external",
        },
    )?;
    Ok(FormatOutput {
        stdout: got.stdout,
        stderr: got.stderr,
        exit_code: got.exit_code,
        timed_out: got.timed_out,
        truncated: got.truncated,
    })
}
