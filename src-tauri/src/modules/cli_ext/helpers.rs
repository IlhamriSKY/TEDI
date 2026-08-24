//! Small leaf helpers for the `tedi ext` CLI: TTY detection, the tokio
//! runtime + extensions-root resolvers, reference-shape heuristics, and the
//! colourised `--help` text.

use std::fs;
use std::path::PathBuf;

use crate::modules::cli_paint::{paint_brand, paint_dim, paint_header, paint_id};
use dialoguer::theme::{ColorfulTheme, Theme};

use crate::modules::cli_paint::color_enabled;

/// `ColorfulTheme` brings dialoguer's coloured prompt + active-item ">"
/// indicator. Wrapped in a small selector so non-TTY shells still get the
/// plain theme (no ANSI in pipes / CI).
pub(super) fn picker_theme() -> Box<dyn Theme> {
    if color_enabled() {
        Box::new(ColorfulTheme::default())
    } else {
        Box::new(dialoguer::theme::SimpleTheme)
    }
}

pub(super) fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

pub(super) fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + c.as_str(),
        None => String::new(),
    }
}

pub(super) fn extensions_root() -> Result<PathBuf, String> {
    let p = crate::modules::ids::extensions_root()
        .ok_or_else(|| "could not determine data_dir".to_string())?;
    fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))?;
    Ok(p)
}

pub(super) fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))
}

pub(super) fn looks_like_path(s: &str) -> bool {
    if s.contains('\\') {
        return true;
    }
    if s.starts_with("./") || s.starts_with("../") || s.starts_with("~/") || s.starts_with('/') {
        return true;
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    false
}

pub(super) fn looks_like_github_ref(s: &str) -> bool {
    if s.contains('\\') {
        return false;
    }
    if s.contains("://") || s.starts_with("github.com/") {
        return true;
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    if parts[0].starts_with('.') || parts[1].starts_with('.') {
        return false;
    }
    let id_safe = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    id_safe(parts[0]) && id_safe(parts[1])
}

pub(super) fn print_help() {
    print!("{}", help_text());
}

/// Colorised help text. Matches the palette used by `cli.rs::help_text()`
/// and `cli_theme.rs::help_text()` so the three `--help` outputs look
/// uniform. ANSI codes are gated through `ansi()` (TTY + `NO_COLOR`).
pub(super) fn help_text() -> String {
    let r = paint_dim("[<REF>]");
    let i = paint_dim("[<ID>]");
    format!(
        "{title}  {tag}\n\
         \n\
         {usage}\n  \
         {tedi} ext {sub}        Pick an action (arrow keys)\n  \
         {tedi} ext install {r}    path | owner/repo | GitHub URL | registry id\n  \
         {tedi} --extension {sub}  Alias for `tedi ext {sub}`\n\
         \n\
         {hint}\n  \
         {dim_hint1}\n  \
         {dim_hint2}\n\
         \n\
         {subs}\n  \
         {c_install} {r}         Install. Omit {r} for an interactive registry picker\n  \
         {c_list}                  Browse the public registry (TTY picker)\n  \
         {c_list_inst}      Show locally installed extensions\n  \
         {c_installed}             Alias for `list --installed`\n  \
         {c_update} {i}          Check upstream / apply updates\n  \
         {c_uninst} {i}       Remove an installed extension\n  \
         {c_enable} {i}          Enable an installed extension\n  \
         {c_disable} {i}         Disable an installed extension\n  \
         {c_help}                  Print this help\n\
         \n\
         {authoring}\n  \
         {c_create} {i}          Scaffold a new extension into ./<id>/\n  \
         {c_types} {d}          Refresh tedi.d.ts + manifest.schema.json from this binary\n  \
         {c_validate} {d}       Pre-publish check of an extension folder\n\
         \n\
         {dim_registry}\n",
        title = paint_brand(&format!("tedi ext  {}", env!("CARGO_PKG_VERSION"))),
        tag = paint_dim("· manage TEDI extensions"),
        usage = paint_header("USAGE"),
        tedi = paint_id("tedi"),
        sub = paint_dim("[<subcommand>]"),
        r = r,
        hint = paint_header("INTERACTIVE"),
        dim_hint1 = paint_dim(
            "Subcommands prompt with an arrow-key picker when the target arg is omitted."
        ),
        dim_hint2 =
            paint_dim("Non-TTY shells (CI, pipes) print a hint instead of stalling on the picker."),
        subs = paint_header("SUBCOMMANDS"),
        c_install = paint_id("install   "),
        c_list = paint_id("list             "),
        c_list_inst = paint_id("list --installed"),
        c_installed = paint_id("installed        "),
        c_update = paint_id("update   "),
        c_uninst = paint_id("uninstall"),
        c_enable = paint_id("enable   "),
        c_disable = paint_id("disable  "),
        c_help = paint_id("help             "),
        dim_registry = paint_dim("Registry: https://tedi.ilhamriski.com/extensions/"),
        authoring = paint_header("AUTHORING"),
        d = paint_dim("[<DIR>]"),
        c_create = paint_id("create   "),
        c_types = paint_id("types    "),
        c_validate = paint_id("validate "),
        i = i,
    )
}
