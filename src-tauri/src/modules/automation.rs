//! Where the automation channel's port comes from.
//!
//! `TEDI_DEBUG_PORT=9222` opens the WebView2 DevTools Protocol on loopback and
//! sets `window.__TEDI_AUTOMATION__`, which together are how `scripts/mcp/`
//! and the MCP server every AI CLI talks to reach a running TEDI.
//!
//! An env var alone made that unusable from the app itself. WebView2 fixes its
//! browser arguments when it creates its environment, so the port can only be
//! decided BEFORE the first webview exists - which means before any `AppHandle`,
//! before the settings store is loaded, and long before a user could click
//! anything. The only way for TEDI to turn its own automation on was to be
//! relaunched from a shell that exported the variable, and an "Install MCP"
//! button that cannot do that is a button that lies.
//!
//! So the port is read from the settings file directly, on disk, at startup.
//! The env var still wins when set - it is the override a developer reaches for,
//! and it must not be silently replaced by a stale stored value.
//!
//! OFF BY DEFAULT, and it stays that way unless the user turns it on: an open
//! DevTools port has no authentication of any kind, so anything already running
//! as this user can drive the window. That is the same trust boundary as the
//! user's own shell, and it is why the header shows an indicator whenever the
//! channel is live rather than leaving it invisible.

use std::sync::OnceLock;

use crate::modules::ids::BUNDLE_ID;

/// Key in `tedi-settings.json`. Written only by the Install MCP flow
/// (`setAutomationPort` in `src/modules/settings/store.ts`); deliberately NOT a
/// member of `Preferences`, so the MCP `set_setting` tool cannot reach it and an
/// agent cannot make its own access permanent.
const KEY: &str = "automationPort";

/// The settings file, without an `AppHandle`.
///
/// Both candidates are checked rather than picked: `tauri-plugin-store` resolves
/// a bare filename against the app CONFIG dir, which on Windows is the same
/// Roaming folder as the data dir but on Linux is not (`~/.config` vs
/// `~/.local/share`). Trying both costs one `exists()` and removes the guess.
fn settings_files() -> Vec<std::path::PathBuf> {
    [dirs::config_dir(), dirs::data_dir()]
        .into_iter()
        .flatten()
        .map(|d| d.join(BUNDLE_ID).join("tedi-settings.json"))
        .collect()
}

/// Port the automation channel should listen on, or `None` for off.
///
/// Cached: this is read on the startup path by both the WebView2 argument
/// builder and the init-script plugin, and neither should pay a file read twice
/// or - worse - disagree with the other because the file changed in between.
pub fn debug_port() -> Option<u16> {
    static PORT: OnceLock<Option<u16>> = OnceLock::new();
    *PORT.get_or_init(|| {
        // The env var is the override. Checked first so a developer's
        // `$env:TEDI_DEBUG_PORT=9223` is never quietly overruled by whatever a
        // previous Install MCP wrote.
        if let Ok(raw) = std::env::var("TEDI_DEBUG_PORT") {
            return raw.trim().parse::<u16>().ok().filter(|p| *p != 0);
        }
        for path in settings_files() {
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            // `as_u64` then narrow: the store writes JSON numbers, and a value
            // that does not fit a port is off rather than truncated into some
            // other port.
            if let Some(port) = json.get(KEY).and_then(|v| v.as_u64()) {
                return u16::try_from(port).ok().filter(|p| *p != 0);
            }
            // The file existed and simply has no key yet - that IS the answer.
            return None;
        }
        None
    })
}

// ---------------------------------------------------------------------------
// WebView2 startup flags.
// ---------------------------------------------------------------------------

/// WebView2 command-line flags for TEDI's own webviews.
///
/// Keeps wry's defaults (disable the mini-menu / SmartScreen / PDF OOUI) and adds
/// the bits that keep the window processing while it is minimized or occluded:
/// turning off `CalculateNativeWinOcclusion` plus renderer and timer background
/// throttling, so CDP input and rendering keep working for the automation
/// channel rather than freezing behind an occlusion check.
#[cfg(target_os = "windows")]
const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required";

/// Publish those flags, plus the automation port when one is configured, through
/// the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var the WebView2 loader reads
/// when it creates each environment - so every webview is created with the SAME
/// additional args.
///
/// Per-webview `additional_browser_args` that differ from the main webview's
/// render a child permanently BLANK on Windows (tauri-apps/tauri#13092), which is
/// why this is process-wide rather than set where a webview is built.
///
/// Must run once at startup, before the first webview is created.
#[cfg(target_os = "windows")]
pub fn apply_webview2_browser_args_env() {
    // Opt-in automation port: it opens the WebView2 DevTools Protocol on loopback
    // so external tooling (see `scripts/mcp/`) can evaluate JS, dispatch real
    // input and capture stills. Off unless asked for, so shipped builds keep no
    // listening socket. `TEDI_DEBUG_PORT`, or the stored setting the Install MCP
    // button writes - which is why it reads `debug_port()` rather than the env
    // var directly: the app has to be able to turn its own channel on.
    let args = match debug_port() {
        Some(port) => format!("{WEBVIEW2_ARGS} --remote-debugging-port={port}"),
        None => WEBVIEW2_ARGS.to_string(),
    };
    // Edition 2021: `set_var` is safe. Called on the main thread at startup before
    // any webview (or other thread) exists.
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_port_of_zero_is_off_not_a_port() {
        // Zero is what the UI writes to turn the channel off. Passing it through
        // would hand WebView2 `--remote-debugging-port=0`, which does not mean
        // "off" to Chromium - it means "pick any free port", i.e. silently ON.
        assert_eq!("0".trim().parse::<u16>().ok().filter(|p| *p != 0), None);
    }

    #[test]
    fn settings_path_is_under_the_bundle_id() {
        let files = settings_files();
        assert!(!files.is_empty(), "no OS config or data dir resolved");
        for f in files {
            assert!(f.ends_with("tedi-settings.json"));
            assert!(f.to_string_lossy().contains(BUNDLE_ID));
        }
    }
}
