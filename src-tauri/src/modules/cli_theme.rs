//! Headless CLI for `tedi theme <subcmd>`. Short-circuits out of `lib::run`
//! before Tauri boots and writes directly to the `tedi-settings.json` store
//! the GUI's preferences hydrate from on launch. The running GUI does NOT
//! pick up these writes until the next restart (tauri-plugin-store has no
//! file watcher), so each command prints a hint to that effect when
//! relevant.
//!
//! Memory note: `theme bg <file>` base64-encodes the image into the prefs
//! JSON. For long-running idle sessions, prefer `theme bg <url>` so the
//! prefs store keeps only ~100 bytes (the URL) rather than the full
//! decoded payload.
//!
//! Subcommands:
//!   tedi theme list                  # list preset names
//!   tedi theme show                  # show currently active theme
//!   tedi theme set <id>              # apply a preset (queues for next boot)
//!   tedi theme on / off              # toggle the custom theme entirely
//!   tedi theme reset                 # restore the Default preset
//!   tedi theme bg <url|file-path>    # set wallpaper from URL or local file
//!   tedi theme bg off                # disable wallpaper
//!   tedi theme blur <0..40>          # set wallpaper blur (px)
//!   tedi theme opacity <0..1>        # set terminal/editor surface opacity
//!   tedi theme darken <0..1>         # set wallpaper darken overlay
//!
//! Concurrency: the GUI may also write `tedi-settings.json` (last writer
//! wins). Acceptable for the CLI use case — two GUI windows already accept
//! the same race today.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};

use crate::modules::cli;

/// Bundle id from `tauri.conf.json`. Kept in sync with `cli_ext::BUNDLE_ID`.
const BUNDLE_ID: &str = "id.ilhamrisky.tedi";
/// Store file managed by `tauri-plugin-store` (see `store.ts`).
const STORE_FILE: &str = "tedi-settings.json";

/// `(id, display_name)` for every preset baked into `themePresets.ts`. The
/// CLI writes `customThemePresetRequest = <id>`; the TS side resolves the
/// id back to its full color set on the next app boot. Keep this list in
/// lock-step with `THEME_PRESETS` in `themePresets.ts` (names match
/// case-insensitively via slug derivation).
const PRESETS: &[(&str, &str)] = &[
    ("default", "Default"),
    ("tokyo-night", "Tokyo Night"),
    ("nord", "Nord"),
    ("catppuccin", "Catppuccin"),
    ("solarized", "Solarized"),
    ("monokai", "Monokai"),
    ("matrix", "Matrix"),
];

pub fn help_text() -> &'static str {
    concat!(
        "tedi theme - manage the custom theme + wallpaper from the shell.\n",
        "\n",
        "USAGE:\n",
        "    tedi theme <SUBCOMMAND> [ARGS]\n",
        "\n",
        "SUBCOMMANDS:\n",
        "    list                       List available presets\n",
        "    show                       Show currently active theme\n",
        "    set <id>                   Apply a preset (queues for next launch)\n",
        "    on | off                   Toggle the custom theme entirely\n",
        "    reset                      Restore the Default preset\n",
        "    bg <url|file>              Set wallpaper from URL or local file\n",
        "    bg off                     Disable wallpaper\n",
        "    blur <0..40>               Wallpaper blur in pixels\n",
        "    opacity <0..1>             Terminal / editor surface opacity\n",
        "    darken <0..1>              Dark overlay strength on wallpaper\n",
        "\n",
        "PRESET IDS:\n",
        "    default, tokyo-night, nord, catppuccin, solarized, monokai, matrix\n",
        "\n",
        "NOTES:\n",
        "    Changes apply on the next TEDI launch. If the app is already\n",
        "    running, restart it (or close + reopen) to pick the new theme up.\n",
        "    `bg <file>` base64-encodes the image into the settings file; use a\n",
        "    URL for the lowest idle memory footprint.",
    )
}

/// Scan argv for the `theme` subcommand, dispatch, exit. Returns without
/// acting when the subcommand is absent so `lib::run` continues to boot
/// the GUI normally.
pub fn handle_theme_command_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    let Some(pos) = args.iter().position(|a| a == "theme") else {
        return;
    };
    cli::attach_parent_console();
    let sub = args.get(pos + 1).map(String::as_str).unwrap_or("help");
    let arg = args.get(pos + 2).cloned();
    let arg2 = args.get(pos + 3).cloned();

    let result = match sub {
        "help" | "-h" | "--help" => {
            print(help_text());
            Ok(())
        }
        "list" => list_presets(),
        "show" => show_current(),
        "set" => set_preset(arg.as_deref()),
        "on" => set_enabled(true),
        "off" => set_enabled(false),
        "reset" => reset_to_default(),
        "bg" => set_bg(arg.as_deref(), arg2.as_deref()),
        "blur" => set_number_field(&["customTheme", "background", "blur"], arg.as_deref(), 0.0, 40.0),
        "opacity" => set_number_field(
            &["customTheme", "background", "surfaceOpacity"],
            arg.as_deref(),
            0.0,
            1.0,
        ),
        "darken" => set_number_field(&["customTheme", "background", "darken"], arg.as_deref(), 0.0, 1.0),
        _ => {
            eprint(&format!("unknown subcommand: {sub}\n"));
            print(help_text());
            std::process::exit(2);
        }
    };

    match result {
        Ok(()) => {
            let _ = std::io::stdout().flush();
            std::process::exit(0);
        }
        Err(e) => {
            eprint(&format!("error: {e}\n"));
            std::process::exit(1);
        }
    }
}

fn list_presets() -> Result<(), String> {
    print("Available theme presets:\n");
    for (id, name) in PRESETS {
        print(&format!("  {id:<14} {name}\n"));
    }
    print("\nUse `tedi theme set <id>` to apply.\n");
    Ok(())
}

fn show_current() -> Result<(), String> {
    let store = read_store()?;
    let enabled = store
        .get("customThemeEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let name = store
        .get("customTheme")
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Default");
    let pending = store
        .get("customThemePresetRequest")
        .and_then(Value::as_str)
        .map(String::from);
    let bg_enabled = store
        .get("customTheme")
        .and_then(|v| v.get("background"))
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    print(&format!(
        "Custom theme : {}\nActive preset : {name}\nWallpaper    : {}\n",
        if enabled { "on" } else { "off" },
        if bg_enabled { "on" } else { "off" },
    ));
    if let Some(p) = pending {
        print(&format!("Pending      : {p} (applies on next launch)\n"));
    }
    Ok(())
}

fn set_preset(id: Option<&str>) -> Result<(), String> {
    let id = id.ok_or("missing preset id (try `tedi theme list`)")?;
    let normalized = slugify(id);
    if !PRESETS.iter().any(|(p, _)| *p == normalized) {
        return Err(format!(
            "unknown preset `{id}`. Run `tedi theme list` to see the available ids."
        ));
    }
    update_store(|store| {
        store.insert("customThemePresetRequest".into(), Value::String(normalized.clone()));
        store.insert("customThemeEnabled".into(), Value::Bool(true));
    })?;
    let display = PRESETS
        .iter()
        .find(|(p, _)| *p == normalized)
        .map(|(_, n)| *n)
        .unwrap_or(&normalized);
    print(&format!(
        "Queued preset `{display}`. Restart TEDI to apply (already takes effect if TEDI is not running).\n"
    ));
    Ok(())
}

fn set_enabled(value: bool) -> Result<(), String> {
    update_store(|store| {
        store.insert("customThemeEnabled".into(), Value::Bool(value));
    })?;
    print(&format!(
        "Custom theme {}. Restart TEDI to apply.\n",
        if value { "enabled" } else { "disabled" }
    ));
    Ok(())
}

fn reset_to_default() -> Result<(), String> {
    update_store(|store| {
        store.insert(
            "customThemePresetRequest".into(),
            Value::String("default".into()),
        );
        store.insert("customThemeEnabled".into(), Value::Bool(true));
        // Drop any user overrides so the Default preset applies cleanly.
        store.remove("customTheme");
    })?;
    print("Reset to Default preset. Restart TEDI to apply.\n");
    Ok(())
}

fn set_bg(arg: Option<&str>, _arg2: Option<&str>) -> Result<(), String> {
    let arg = arg.ok_or("missing argument: `tedi theme bg <url|file|off>`")?;
    if arg.eq_ignore_ascii_case("off") {
        update_store(|store| {
            mutate_bg_field(store, |bg| {
                bg.insert("enabled".into(), Value::Bool(false));
                bg.insert("dataUrl".into(), Value::String(String::new()));
                bg.insert("path".into(), Value::String(String::new()));
            });
        })?;
        print("Wallpaper disabled.\n");
        return Ok(());
    }

    let (path, data_url) = if is_url(arg) {
        (arg.to_string(), arg.to_string())
    } else {
        let file_path = PathBuf::from(arg);
        if !file_path.exists() {
            return Err(format!("file not found: {arg}"));
        }
        let bytes = fs::read(&file_path).map_err(|e| format!("read failed: {e}"))?;
        let mime = guess_image_mime(&file_path, &bytes)
            .ok_or_else(|| "unsupported image format (png/jpg/webp/gif/bmp/svg)".to_string())?;
        let encoded = B64.encode(&bytes);
        let data_url = format!("data:{mime};base64,{encoded}");
        let path_str = file_path.to_string_lossy().to_string();
        (path_str, data_url)
    };

    let path_for_msg = path.clone();
    update_store(|store| {
        mutate_bg_field(store, |bg| {
            bg.insert("enabled".into(), Value::Bool(true));
            bg.insert("path".into(), Value::String(path.clone()));
            bg.insert("dataUrl".into(), Value::String(data_url.clone()));
        });
    })?;
    print(&format!(
        "Wallpaper set to `{path_for_msg}`. Restart TEDI to apply.\n"
    ));
    if !is_url(&path_for_msg) {
        print(
            "Tip: for the lowest idle memory, host the image online and use `tedi theme bg <url>` instead.\n",
        );
    }
    Ok(())
}

fn set_number_field(path: &[&str], arg: Option<&str>, min: f64, max: f64) -> Result<(), String> {
    let arg = arg.ok_or_else(|| format!("missing value (expected {min}..{max})"))?;
    let value: f64 = arg
        .parse()
        .map_err(|_| format!("not a number: `{arg}` (expected {min}..{max})"))?;
    let clamped = value.max(min).min(max);
    update_store(|store| {
        let mut cursor: &mut serde_json::Map<String, Value> = store;
        // Walk the path, creating intermediate objects as needed.
        for (i, key) in path.iter().enumerate() {
            if i + 1 == path.len() {
                cursor.insert((*key).to_string(), json!(clamped));
            } else {
                let entry = cursor
                    .entry((*key).to_string())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()));
                if !entry.is_object() {
                    *entry = Value::Object(serde_json::Map::new());
                }
                cursor = entry.as_object_mut().expect("just-inserted is object");
            }
        }
    })?;
    print(&format!(
        "Set {} = {clamped}. Restart TEDI to apply.\n",
        path.join(".")
    ));
    Ok(())
}

/// In-place mutator that ensures `customTheme.background` exists as an
/// object, then hands it to the caller. Other customTheme fields stay
/// untouched so the GUI's normalize step can still backfill defaults.
fn mutate_bg_field<F: FnOnce(&mut serde_json::Map<String, Value>)>(
    store: &mut serde_json::Map<String, Value>,
    f: F,
) {
    let theme = store
        .entry("customTheme".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !theme.is_object() {
        *theme = Value::Object(serde_json::Map::new());
    }
    let theme_obj = theme.as_object_mut().unwrap();
    let bg = theme_obj
        .entry("background".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !bg.is_object() {
        *bg = Value::Object(serde_json::Map::new());
    }
    f(bg.as_object_mut().unwrap());
}

fn read_store() -> Result<serde_json::Map<String, Value>, String> {
    let path = store_path();
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings: {e}"))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("parse settings: {e}"))?;
    v.as_object()
        .cloned()
        .ok_or_else(|| "settings file is not a JSON object".to_string())
}

/// Mutate the store with a callback then atomically write back. On error
/// the file is untouched. Pretty-printed JSON matches what the plugin
/// would emit, so a diff stays readable.
fn update_store<F: FnOnce(&mut serde_json::Map<String, Value>)>(f: F) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
    }
    let mut store = read_store()?;
    f(&mut store);
    let bytes = serde_json::to_vec_pretty(&Value::Object(store))
        .map_err(|e| format!("serialize settings: {e}"))?;
    let tmp = path.with_extension("tedi.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("stage write: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("commit write: {e}")
    })?;
    Ok(())
}

fn store_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(BUNDLE_ID)
        .join(STORE_FILE)
}

fn is_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("data:")
}

fn guess_image_mime(path: &std::path::Path, bytes: &[u8]) -> Option<&'static str> {
    // Magic bytes first; extension as fallback for text-based formats.
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("svg") => Some("image/svg+xml"),
        Some("avif") => Some("image/avif"),
        _ => None,
    }
}

/// Slugify a user-supplied preset name to the canonical id form.
/// `"Tokyo Night"` -> `"tokyo-night"`, `"Catppuccin"` -> `"catppuccin"`.
fn slugify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = true;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            for c in ch.to_lowercase() {
                out.push(c);
            }
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn print(s: &str) {
    let _ = std::io::stdout().write_all(s.as_bytes());
}

fn eprint(s: &str) {
    let _ = std::io::stderr().write_all(s.as_bytes());
}
