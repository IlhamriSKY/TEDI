//! Install execution for the `tedi ext` CLI: the plain-mode progress
//! reporter plus the local-file and GitHub-release install paths.

use std::io::Write;

use crate::modules::cli_paint::{paint_dim, paint_id, paint_ok};
use crate::modules::extensions::github;
use crate::modules::extensions::install::{
    install_from_bytes_with_progress, InstallOutcome, InstallPhase, InstallProgress, NoopProgress,
};

use super::helpers::interactive;

/// Plain-mode progress reporter: prints one human-readable line per phase
/// and overwrites the extract progress on a single line so the terminal
/// doesn't get spammed. Falls back to plain println on Windows console
/// hosts that don't honour `\r`.
pub(super) struct CliProgress {
    last_was_progress: std::sync::Mutex<bool>,
}

impl CliProgress {
    pub(super) fn new() -> Self {
        Self {
            last_was_progress: std::sync::Mutex::new(false),
        }
    }
}

impl InstallProgress for CliProgress {
    fn phase(&self, phase: InstallPhase) {
        let (line, sticky) = match phase {
            InstallPhase::Downloading {
                bytes_done,
                bytes_total,
            } => (
                match bytes_total {
                    Some(t) if t > 0 => {
                        format!("Downloading: {} / {}", fmt_bytes(bytes_done), fmt_bytes(t))
                    }
                    _ => format!("Downloading: {}", fmt_bytes(bytes_done)),
                },
                true,
            ),
            InstallPhase::Verifying => ("Verifying...".into(), false),
            InstallPhase::Extracting => ("Extracting...".into(), false),
            InstallPhase::Finalizing => ("Finalizing...".into(), false),
            InstallPhase::Done => ("Done.".into(), false),
        };
        let mut stdout = std::io::stdout();
        let mut last = self
            .last_was_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *last && !sticky {
            let _ = writeln!(stdout);
        }
        if sticky {
            let _ = write!(stdout, "\r\x1b[2K{line}");
        } else {
            let _ = writeln!(stdout, "{line}");
        }
        let _ = stdout.flush();
        *last = sticky;
    }

    fn file(&self, index: usize, total: usize, _path: &str) {
        if total == 0 {
            return;
        }
        let step = (total / 10).max(1);
        if !index.is_multiple_of(step) && index + 1 != total {
            return;
        }
        let pct = ((index as f64 + 1.0) / total as f64 * 100.0).round() as u32;
        let mut stdout = std::io::stdout();
        let _ = write!(
            stdout,
            "\r\x1b[2KExtracting: {}/{} files ({pct}%)",
            index + 1,
            total
        );
        let _ = stdout.flush();
        let mut last = self
            .last_was_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if index + 1 == total {
            let _ = writeln!(stdout);
            *last = false;
        } else {
            *last = true;
        }
    }
}

pub(super) fn fmt_bytes(b: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if b >= MB {
        format!("{:.1} MiB", b as f64 / MB as f64)
    } else if b >= KB {
        format!("{:.1} KiB", b as f64 / KB as f64)
    } else {
        format!("{b} B")
    }
}

pub(super) fn install_with_progress(
    root: &std::path::Path,
    state_path: &std::path::Path,
    bytes: &[u8],
    source: &str,
) -> Result<InstallOutcome, String> {
    let progress: Box<dyn InstallProgress> = if interactive() {
        Box::new(CliProgress::new())
    } else {
        Box::new(NoopProgress)
    };
    install_from_bytes_with_progress(root, state_path, bytes, source, progress.as_ref())
}

pub(super) fn install_github(
    runtime: &tokio::runtime::Runtime,
    owner_repo: &str,
    root: &std::path::Path,
    state_path: &std::path::Path,
) -> Result<(), String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    let json = runtime.block_on(github::http_get_text(&api))?;
    let zip_url = github::pick_release_zip(&json)
        .ok_or_else(|| format!("no .zip asset in latest release of {owner_repo}"))?;
    println!("{} {zip_url}", paint_dim("Downloading"));
    let progress: Box<dyn InstallProgress> = if interactive() {
        Box::new(CliProgress::new())
    } else {
        Box::new(NoopProgress)
    };
    let bytes = runtime.block_on(github::http_get_bytes_with_progress(
        &zip_url,
        |done, total| {
            progress.phase(InstallPhase::Downloading {
                bytes_done: done,
                bytes_total: total,
            });
        },
    ))?;
    let outcome = install_from_bytes_with_progress(
        root,
        state_path,
        &bytes,
        &format!("github:{owner_repo}"),
        progress.as_ref(),
    )?;
    println!(
        "{} Installed {} {} {}",
        paint_ok("✓"),
        paint_id(&outcome.manifest.id),
        paint_dim(&format!("v{}", outcome.manifest.version)),
        paint_dim(&format!("(from github:{owner_repo})")),
    );
    Ok(())
}
