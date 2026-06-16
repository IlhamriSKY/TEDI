//! Shared ANSI paint vocabulary for the headless `tedi` CLI surfaces
//! (`cli`, `cli_ext`, `cli_theme`, `cli_update`). One palette so
//! `tedi --help`, `tedi ext`, `tedi theme`, and `tedi --update` look like a
//! single CLI rather than four styles.
//!
//! Colour is emitted only when stdout is a TTY and `NO_COLOR` is unset, so
//! piped output (CI logs, file redirection) stays clean. The decision is
//! cached once via a `OnceLock` so repeated calls don't re-probe the
//! terminal.

use std::io::{IsTerminal, Write};
use std::sync::OnceLock;

/// `true` when ANSI SGR codes should be emitted: stdout is a TTY and
/// `NO_COLOR` is unset. Cached for the life of the process.
pub fn color_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none())
}

/// Wrap `text` in the SGR `code` (e.g. `"36;1"`), or return it unchanged
/// when colour is disabled.
pub fn ansi(code: &str, text: &str) -> String {
    if color_enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

// ── named roles ─────────────────────────────────────────────────────────
// Shared by help text + runtime output across the four CLI modules. The
// SGR codes are the palette; keep them in one place so a tweak applies to
// every surface at once.

pub fn paint_bold(s: &str) -> String {
    ansi("1", s)
}
pub fn paint_dim(s: &str) -> String {
    ansi("2", s)
}
pub fn paint_header(s: &str) -> String {
    ansi("36;1", s)
}
pub fn paint_id(s: &str) -> String {
    ansi("33;1", s)
}
pub fn paint_ok(s: &str) -> String {
    ansi("32", s)
}
pub fn paint_err(s: &str) -> String {
    ansi("31", s)
}
pub fn paint_warn(s: &str) -> String {
    ansi("33", s)
}
pub fn paint_brand(s: &str) -> String {
    ansi("34;1", s)
}
/// Highlighted/active row (bright green). Same code as `paint_installed`.
pub fn paint_active(s: &str) -> String {
    ansi("32;1", s)
}

// ── extension-list specific roles ───────────────────────────────────────

pub fn paint_official(label: &str) -> String {
    ansi("36;1", label)
}
pub fn paint_unofficial(label: &str) -> String {
    ansi("33;1", label)
}
pub fn paint_on() -> String {
    ansi("32;1", "[on] ")
}
pub fn paint_off() -> String {
    ansi("90", "[off]")
}
pub fn paint_update_hint(text: &str) -> String {
    ansi("33", text)
}
pub fn paint_installed(text: &str) -> String {
    ansi("32;1", text)
}

// ── progress rendering ───────────────────────────────────────────────────
// One bar style shared by every download (`tedi --update`, `tedi ext
// install`) and the extraction tick, so progress looks identical wherever it
// shows up. Carriage-return overwrites only fire on a TTY; piped output stays
// free of control bytes.

/// `true` when stdout is a TTY, independent of `NO_COLOR`. In-place line
/// overwrites (`\r`) only make sense on a real terminal - redirected output
/// must not carry control bytes even when the user kept colour on. Cached for
/// the process lifetime.
pub fn stdout_is_tty() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| std::io::stdout().is_terminal())
}

/// Width of the progress-bar track in cells.
const PROGRESS_BAR_WIDTH: usize = 24;

/// Human-readable byte count (`B` / `KiB` / `MiB`). Shared so every CLI
/// surface renders sizes the same way.
pub fn fmt_bytes(b: u64) -> String {
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

/// A `████████░░░░░░░░`-style bar for `fraction` in `0.0..=1.0`. The filled
/// run is bright green, the remaining track dim grey; with colour disabled
/// the two block glyphs still read by density alone.
pub fn progress_bar(fraction: f64) -> String {
    let f = fraction.clamp(0.0, 1.0);
    let filled = ((f * PROGRESS_BAR_WIDTH as f64).round() as usize).min(PROGRESS_BAR_WIDTH);
    let empty = PROGRESS_BAR_WIDTH - filled;
    let fill = "\u{2588}".repeat(filled); // █
    let track = "\u{2591}".repeat(empty); // ░
    if color_enabled() {
        format!("{}{}", ansi("32;1", &fill), ansi("90", &track))
    } else {
        format!("{fill}{track}")
    }
}

/// Compose `label  [bar]  NN%  detail`. `label` + `detail` are dim so the bar
/// and percentage carry the eye.
pub fn progress_line(label: &str, fraction: f64, detail: &str) -> String {
    let pct = (fraction.clamp(0.0, 1.0) * 100.0).round() as u32;
    format!(
        "{}  {}  {:>3}%  {}",
        paint_dim(label),
        progress_bar(fraction),
        pct,
        paint_dim(detail),
    )
}

/// Overwrite the current stdout line with `s` (carriage return + clear). A
/// no-op when stdout is not a TTY, so redirected/piped output stays clean.
pub fn overwrite_line(s: &str) {
    if !stdout_is_tty() {
        return;
    }
    let mut out = std::io::stdout();
    let _ = write!(out, "\r\x1b[2K{s}");
    let _ = out.flush();
}

/// Finish a run of [`overwrite_line`] updates by dropping to a fresh line.
/// No-op off a TTY (nothing was drawn there to terminate).
pub fn end_progress_line() {
    if stdout_is_tty() {
        let _ = writeln!(std::io::stdout());
    }
}

/// Render an in-place download progress bar. `total` is the advertised
/// content-length when the server sent one; without it no percentage is
/// possible, so the bar falls back to a running byte count.
pub fn print_download_progress(done: u64, total: Option<u64>) {
    match total {
        Some(t) if t > 0 => {
            let frac = done as f64 / t as f64;
            overwrite_line(&progress_line(
                "Downloading",
                frac,
                &format!("{} / {}", fmt_bytes(done), fmt_bytes(t)),
            ));
        }
        _ => overwrite_line(&format!(
            "{}  {}",
            paint_dim("Downloading"),
            paint_dim(&fmt_bytes(done)),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests run with stdout piped, so `color_enabled()` is false: the bar is
    // bare block glyphs and `progress_line` returns plain text. The
    // assertions match those colour-free shapes.

    #[test]
    fn fmt_bytes_units() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(1024), "1.0 KiB");
        assert_eq!(fmt_bytes(1024 * 1024), "1.0 MiB");
        assert_eq!(fmt_bytes(1024 * 1024 * 3 / 2), "1.5 MiB");
    }

    #[test]
    fn progress_bar_is_fixed_width_and_clamped() {
        for frac in [-1.0, 0.0, 0.5, 1.0, 2.0] {
            assert_eq!(
                progress_bar(frac).chars().count(),
                PROGRESS_BAR_WIDTH,
                "bar width drifted for fraction {frac}"
            );
        }
        // 0% is all track, 100% is all fill.
        assert!(progress_bar(0.0).chars().all(|c| c == '\u{2591}'));
        assert!(progress_bar(1.0).chars().all(|c| c == '\u{2588}'));
    }

    #[test]
    fn progress_line_reports_percentage() {
        let line = progress_line("Downloading", 0.5, "5 / 10 MiB");
        assert!(line.contains("50%"), "missing percentage: {line}");
        assert!(line.contains("Downloading"), "missing label: {line}");
        assert!(line.contains("5 / 10 MiB"), "missing detail: {line}");
    }
}
