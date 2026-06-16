//! Install execution for the `tedi ext` CLI: the plain-mode progress
//! reporter plus the local-file and GitHub-release install paths.

use crate::modules::cli_paint::{
    end_progress_line, overwrite_line, paint_dim, paint_id, paint_ok, print_download_progress,
    progress_line,
};
use crate::modules::extensions::github;
use crate::modules::extensions::install::{
    install_from_bytes_with_progress, InstallOutcome, InstallPhase, InstallProgress, NoopProgress,
};

use super::helpers::interactive;

/// Plain-mode progress reporter for `tedi ext` installs. Renders the shared
/// `cli_paint` download/extract bar on a single overwritten line, plus one dim
/// status line per non-download phase. `last_was_progress` tracks whether a
/// sticky bar is still on the current line so the next status line starts
/// fresh. The bar helpers no-op off a TTY, so piped output stays clean.
pub(super) struct CliProgress {
    last_was_progress: std::sync::Mutex<bool>,
}

impl CliProgress {
    pub(super) fn new() -> Self {
        Self {
            last_was_progress: std::sync::Mutex::new(false),
        }
    }

    fn set_sticky(&self, sticky: bool) {
        *self
            .last_was_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = sticky;
    }

    /// Drop to a fresh line if a sticky progress bar is still on screen, so a
    /// following status line isn't appended to the half-drawn bar.
    fn finish_sticky(&self) {
        let mut last = self
            .last_was_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *last {
            end_progress_line();
            *last = false;
        }
    }
}

impl InstallProgress for CliProgress {
    fn phase(&self, phase: InstallPhase) {
        if let InstallPhase::Downloading {
            bytes_done,
            bytes_total,
        } = phase
        {
            print_download_progress(bytes_done, bytes_total);
            self.set_sticky(true);
            return;
        }
        // Every other phase is a one-shot status line. Close the sticky bar
        // first so the line isn't appended to a half-drawn bar.
        self.finish_sticky();
        let line = match phase {
            InstallPhase::Verifying => "Verifying...",
            InstallPhase::Extracting => "Extracting...",
            InstallPhase::Finalizing => "Finalizing...",
            InstallPhase::Done => "Done.",
            InstallPhase::Downloading { .. } => unreachable!("handled above"),
        };
        println!("{}", paint_dim(line));
    }

    fn file(&self, index: usize, total: usize, _path: &str) {
        if total == 0 {
            return;
        }
        // Throttle to ~10 ticks plus a guaranteed final one so the bar doesn't
        // thrash on archives with thousands of entries.
        let step = (total / 10).max(1);
        let is_last = index + 1 == total;
        if !index.is_multiple_of(step) && !is_last {
            return;
        }
        let frac = (index as f64 + 1.0) / total as f64;
        overwrite_line(&progress_line(
            "Extracting",
            frac,
            &format!("{} / {} files", index + 1, total),
        ));
        if is_last {
            end_progress_line();
            self.set_sticky(false);
        } else {
            self.set_sticky(true);
        }
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
    println!("{} {}", paint_dim("Downloading"), paint_dim(&zip_url));
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
