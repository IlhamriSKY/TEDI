//! Shared ANSI paint vocabulary for the headless `tedi` CLI surfaces
//! (`cli`, `cli_ext`, `cli_theme`, `cli_update`). One palette so
//! `tedi --help`, `tedi ext`, `tedi theme`, and `tedi --update` look like a
//! single CLI rather than four styles.
//!
//! Colour is emitted only when stdout is a TTY and `NO_COLOR` is unset, so
//! piped output (CI logs, file redirection) stays clean. The decision is
//! cached once via a `OnceLock` so repeated calls don't re-probe the
//! terminal.

use std::io::IsTerminal;
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
