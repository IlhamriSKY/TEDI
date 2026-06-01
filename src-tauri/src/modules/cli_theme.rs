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
//!   tedi theme opacity <0..1>        # whole-app transparency (1 = solid, 0 = clear)
//!   tedi theme darken <0..1>         # set wallpaper darken overlay
//!
//! Concurrency: the GUI may also write `tedi-settings.json` (last writer
//! wins). Acceptable for the CLI use case - two GUI windows already accept
//! the same race today.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};

use crate::modules::cli;
use crate::modules::cli_paint::{
    color_enabled, paint_active, paint_bold, paint_dim, paint_header, paint_id, paint_ok,
    paint_warn,
};
use crate::modules::ids::BUNDLE_ID;

/// Store file managed by `tauri-plugin-store` (see `store.ts`).
const STORE_FILE: &str = "tedi-settings.json";

/// One preset row. The CLI writes `customThemePresetRequest = <id>`; the TS
/// side resolves the id back to its full color set on the next app boot.
/// The four `*_hex` fields are preview swatches rendered next to each row in
/// `theme list` - they mirror the dark variant of the matching preset in
/// `themePresets.ts`. Keep both files in lock-step; the swatches are visual,
/// nothing else relies on them at runtime.
struct Preset {
    id: &'static str,
    name: &'static str,
    bg_hex: &'static str,
    fg_hex: &'static str,
    button_hex: &'static str,
    accent_hex: &'static str,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "default",
        name: "Default",
        bg_hex: "#1e1e1e",
        fg_hex: "#cccccc",
        button_hex: "#0057fe",
        accent_hex: "#0a2870",
    },
    Preset {
        id: "tokyo-night",
        name: "Tokyo Night",
        bg_hex: "#1a1b26",
        fg_hex: "#c0caf5",
        button_hex: "#7aa2f7",
        accent_hex: "#3d59a1",
    },
    Preset {
        id: "nord",
        name: "Nord",
        bg_hex: "#2e3440",
        fg_hex: "#d8dee9",
        button_hex: "#88c0d0",
        accent_hex: "#5e81ac",
    },
    Preset {
        id: "catppuccin",
        name: "Catppuccin",
        bg_hex: "#1e1e2e",
        fg_hex: "#cdd6f4",
        button_hex: "#cba6f7",
        accent_hex: "#45475a",
    },
    Preset {
        id: "solarized",
        name: "Solarized",
        bg_hex: "#002b36",
        fg_hex: "#93a1a1",
        button_hex: "#268bd2",
        accent_hex: "#b58900",
    },
    Preset {
        id: "monokai",
        name: "Monokai",
        bg_hex: "#272822",
        fg_hex: "#f8f8f2",
        button_hex: "#a6e22e",
        accent_hex: "#66d9ef",
    },
    Preset {
        id: "matrix",
        name: "Matrix",
        bg_hex: "#000000",
        fg_hex: "#00ff41",
        button_hex: "#00ff41",
        accent_hex: "#003b00",
    },
];

fn hex_to_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let s = hex.strip_prefix('#').unwrap_or(hex);
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some((r, g, b))
}

/// Two-space wide block with ANSI 24-bit background color. Lets `theme list`
/// preview the preset's palette without depending on glyph rendering.
fn swatch(hex: &str) -> String {
    if !color_enabled() {
        return "  ".to_string();
    }
    match hex_to_rgb(hex) {
        Some((r, g, b)) => format!("\x1b[48;2;{r};{g};{b}m  \x1b[0m"),
        None => "  ".to_string(),
    }
}

/// Render the 4-square palette preview used in `theme list`.
fn swatch_strip(p: &Preset) -> String {
    format!(
        "{}{}{}{}",
        swatch(p.bg_hex),
        swatch(p.fg_hex),
        swatch(p.button_hex),
        swatch(p.accent_hex),
    )
}

pub fn help_text() -> String {
    let ids = PRESETS.iter().map(|p| p.id).collect::<Vec<_>>().join(", ");
    format!(
        "{title}\n\
         \n\
         {usage}\n\
         \n  tedi theme <subcommand> [args]\n\
         \n\
         {subs}\n\
         \n  {p_list}      List presets with color preview\n  \
         {p_show}      Show currently active theme\n  \
         {p_set} <id>   Apply preset (queues for next launch)\n  \
         {p_on} | {p_off}    Toggle custom theme entirely\n  \
         {p_reset}     Restore the Default preset\n  \
         {p_bg} <url|file|off>   Set or clear wallpaper\n  \
         {p_blur} <0..40>      Wallpaper blur (px)\n  \
         {p_opacity} <0..1>   Whole-app transparency (1 solid .. 0 clear)\n  \
         {p_darken} <0..1>    Wallpaper darken overlay\n\
         \n\
         {presets}\n\
         \n  {ids}\n\
         \n\
         {notes}\n\
         {dim_notes}\n",
        title = paint_bold("tedi theme  -  manage the custom theme + wallpaper"),
        usage = paint_header("USAGE"),
        subs = paint_header("SUBCOMMANDS"),
        p_list = paint_id("list      "),
        p_show = paint_id("show      "),
        p_set = paint_id("set       "),
        p_on = paint_id("on  "),
        p_off = paint_id("off "),
        p_reset = paint_id("reset     "),
        p_bg = paint_id("bg        "),
        p_blur = paint_id("blur      "),
        p_opacity = paint_id("opacity   "),
        p_darken = paint_id("darken    "),
        presets = paint_header("PRESET IDS"),
        ids = paint_dim(&ids),
        notes = paint_header("NOTES"),
        dim_notes = paint_dim(
            "  Changes apply on the next TEDI launch - restart the app to see them.\n  \
             `bg <file>` base64-encodes the image into the settings file; prefer a\n  \
             URL for the lowest idle memory footprint."
        ),
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
            print(&help_text());
            Ok(())
        }
        "list" => list_presets(),
        "show" => show_current(),
        "set" => set_preset(arg.as_deref()),
        "on" => set_enabled(true),
        "off" => set_enabled(false),
        "reset" => reset_to_default(),
        "bg" => set_bg(arg.as_deref(), arg2.as_deref()),
        "blur" => set_number_field(
            &["customTheme", "background", "blur"],
            arg.as_deref(),
            0.0,
            40.0,
        ),
        // Whole-app transparency: the live control is the top-level `appOpacity`
        // pref (drives `--tedi-app-opacity` + `data-tedi-glass`). The old target
        // `customTheme.background.surfaceOpacity` was read by no render path, so
        // the command silently did nothing.
        "opacity" => set_number_field(&["appOpacity"], arg.as_deref(), 0.0, 1.0),
        "darken" => set_number_field(
            &["customTheme", "background", "darken"],
            arg.as_deref(),
            0.0,
            1.0,
        ),
        _ => {
            eprint(&format!("unknown subcommand: {sub}\n"));
            print(&help_text());
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
    // Best-effort lookup of the currently-active preset slug so the row can
    // be marked. Errors here (missing store, parse failure) just skip the
    // marker; the list itself stays useful.
    let active_slug = current_preset_slug().unwrap_or_default();
    let pending = read_store()
        .ok()
        .and_then(|s| {
            s.get("customThemePresetRequest")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .unwrap_or_default();

    print(&format!("{}\n", paint_bold("Theme presets")));
    print(&format!(
        "  {}\n\n",
        paint_dim("swatch = bg / fg / button / accent"),
    ));
    for p in PRESETS {
        let is_active = !active_slug.is_empty() && p.id == active_slug;
        let is_pending = !pending.is_empty() && p.id == pending;
        let marker = if is_active {
            paint_active("●")
        } else if is_pending {
            paint_warn("◐")
        } else {
            " ".to_string()
        };
        let id_col = if is_active {
            paint_active(&format!("{:<12}", p.id))
        } else {
            paint_id(&format!("{:<12}", p.id))
        };
        let name_col = if is_active {
            paint_bold(p.name)
        } else {
            p.name.to_string()
        };
        let tail = if is_active {
            paint_dim("  (active)")
        } else if is_pending {
            paint_warn("  (pending - applies on next launch)")
        } else {
            String::new()
        };
        print(&format!(
            "  {marker}  {id_col} {swatches}  {name_col}{tail}\n",
            swatches = swatch_strip(p),
        ));
    }
    print(&format!(
        "\n{}\n",
        paint_dim("Apply: tedi theme set <id>   ·   Restart TEDI to see the change."),
    ));
    Ok(())
}

/// Slug-form of the active preset name persisted in `customTheme.name`.
/// Returns the empty string when no preset is in effect (e.g. fresh install
/// or user-customised theme that no longer matches any built-in).
fn current_preset_slug() -> Result<String, String> {
    let store = read_store()?;
    let name = store
        .get("customTheme")
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(slugify(name))
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

    let on_off = |b: bool| {
        if b {
            paint_ok("on")
        } else {
            paint_dim("off")
        }
    };
    print(&format!("{}\n", paint_bold("Current theme")));
    print(&format!(
        "  {:<14} {}\n",
        paint_dim("Custom theme"),
        on_off(enabled)
    ));
    print(&format!(
        "  {:<14} {}\n",
        paint_dim("Active preset"),
        paint_id(name),
    ));
    print(&format!(
        "  {:<14} {}\n",
        paint_dim("Wallpaper"),
        on_off(bg_enabled)
    ));
    if let Some(p) = pending {
        print(&format!(
            "  {:<14} {} {}\n",
            paint_dim("Pending"),
            paint_warn(&p),
            paint_dim("(applies on next launch)"),
        ));
    }
    Ok(())
}

fn set_preset(id: Option<&str>) -> Result<(), String> {
    let id = id.ok_or("missing preset id (try `tedi theme list`)")?;
    let normalized = slugify(id);
    let preset = PRESETS.iter().find(|p| p.id == normalized).ok_or_else(|| {
        format!("unknown preset `{id}`. Run `tedi theme list` to see the available ids.")
    })?;
    update_store(|store| {
        store.insert(
            "customThemePresetRequest".into(),
            Value::String(normalized.clone()),
        );
        store.insert("customThemeEnabled".into(), Value::Bool(true));
    })?;
    print(&format!(
        "{} Queued preset {}. {}\n",
        paint_ok("✓"),
        paint_id(preset.name),
        paint_dim("Restart TEDI to apply."),
    ));
    Ok(())
}

fn set_enabled(value: bool) -> Result<(), String> {
    update_store(|store| {
        store.insert("customThemeEnabled".into(), Value::Bool(value));
    })?;
    print(&format!(
        "{} Custom theme {}. {}\n",
        paint_ok("✓"),
        if value {
            paint_ok("enabled")
        } else {
            paint_dim("disabled")
        },
        paint_dim("Restart TEDI to apply."),
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
    print(&format!(
        "{} Reset to {} preset. {}\n",
        paint_ok("✓"),
        paint_id("Default"),
        paint_dim("Restart TEDI to apply."),
    ));
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
        print(&format!("{} Wallpaper disabled.\n", paint_ok("✓")));
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
        "{} Wallpaper set to {}. {}\n",
        paint_ok("✓"),
        paint_id(&path_for_msg),
        paint_dim("Restart TEDI to apply."),
    ));
    if !is_url(&path_for_msg) {
        print(&format!(
            "{} {}\n",
            paint_warn("tip"),
            paint_dim("for the lowest idle memory, host the image online and use `tedi theme bg <url>` instead."),
        ));
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
        "{} {} {} {} {}\n",
        paint_ok("✓"),
        paint_dim("Set"),
        paint_id(&path.join(".")),
        paint_dim(&format!("= {clamped}.")),
        paint_dim("Restart TEDI to apply."),
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
    crate::modules::fs::atomic::atomic_write(&path, &bytes)
        .map_err(|e| format!("commit write: {e}"))?;
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
