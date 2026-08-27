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
