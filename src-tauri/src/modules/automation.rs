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

use crate::modules::ids::settings_candidates;

/// Key in `tedi-settings.json`. Written only by the Install MCP flow
/// (`setAutomationPort` in `src/modules/settings/store.ts`); deliberately NOT a
/// member of `Preferences`, so the MCP `set_setting` tool cannot reach it and an
/// agent cannot make its own access permanent.
const KEY: &str = "automationPort";

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
        for path in settings_candidates() {
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

/// Chromium features TEDI turns off for every webview it creates. These are
/// wry's defaults (the mini-menu, SmartScreen, the PDF OOUI); none of them
/// changes how the compositor schedules work.
#[cfg(target_os = "windows")]
const DISABLED_FEATURES: &str = "msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Flags every webview gets, automation or not.
///
/// `--disable-background-timer-throttling` is here on purpose, and it is the one
/// piece of the old Puppeteer flag set that TEDI genuinely needs as a terminal.
/// A covered window is `hidden` to Chromium, and a hidden page normally has its
/// timers cut to 1 Hz. xterm.js drains pending output on a chained
/// `setTimeout` (`WriteBuffer._innerWrite` reschedules whenever a write exceeds
/// its 12 ms budget), so at 1 Hz a build log running in a window you have
/// switched away from would arrive roughly twelve milliseconds of work per
/// second and pile up in the write buffer until you came back. Every poller in
/// the app is on the same footing.
///
/// Critically, keeping it costs almost nothing: timer throttling is not what
/// makes an unattended window expensive. See [`WEBVIEW2_AUTOMATION_ARGS`].
#[cfg(target_os = "windows")]
const WEBVIEW2_COMMON_ARGS: &str =
    "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling";

/// The flags that stop Chromium from ever noticing the window is not on screen.
///
/// THESE ARE AUTOMATION-ONLY, and it matters that they stay that way. Together
/// they turn off native occlusion detection (`CalculateNativeWinOcclusion`),
/// occluded-window backgrounding, and renderer backgrounding, so the compositor
/// and the GPU process keep producing frames at the display refresh rate
/// forever, whether TEDI is focused, buried under a browser, or minimized.
/// The automation channel needs that, because it drives a window the user may
/// have covered, and it is opt-in and off by default, so it pays for it.
///
/// They shipped to every user until v0.4.56. Measured on the same Chromium
/// build, one window fully covered by another, driving a page that renders
/// continuously and runs a 50 ms chained timer:
///
/// | argument set                     | CPU while covered | timer rate |
/// |----------------------------------|-------------------|------------|
/// | what shipped, to everyone        | 4.5% of a core    | 19.6 /s    |
/// | what a normal user gets now      | 0.1% of a core    | 15.1 /s    |
/// | what the automation channel gets | 3.4% of a core    | 19.3 /s    |
///
/// That middle row is why the split is where it is. Essentially all of the cost
/// of an unattended window is compositing it, and none of it is the timers, so
/// TEDI keeps its timers and lets Chromium stop drawing. (A covered window is
/// also deprioritized, which is the 19.6 -> 15.1 difference: the timer runs a
/// little slower, not 20x slower the way real throttling would make it.)
///
/// THE ONE THING THIS COSTS is browser panes, which are driven over in-process
/// COM CDP (`browser/cdp.rs`) rather than this port, so they do not get these
/// flags back. Measured on a covered window: `Page.captureScreenshot` still
/// SUCCEEDS, because Chromium forces a frame for the capture, but it takes
/// ~2.7s instead of ~165ms since there is no composited frame to hand back.
/// `CALL_TIMEOUT` is 45s, so it fits comfortably; an agent screenshotting a
/// pane while the user works in another window just waits a little longer.
#[cfg(target_os = "windows")]
const WEBVIEW2_AUTOMATION_ARGS: &str =
    "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding";

/// The `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` value for a given port setting.
///
/// Pure so the gating is testable: the occlusion flags must appear when, and
/// only when, the automation channel is on. `debug_port()` caches in a
/// `OnceLock`, so a test that went through it could only ever see one branch.
#[cfg(target_os = "windows")]
fn browser_args(port: Option<u16>) -> String {
    // `--disable-features` can only appear ONCE: Chromium keeps the last
    // occurrence and silently drops the earlier ones, so the occlusion entry is
    // appended to the shared list rather than passed as a second switch.
    match port {
        Some(port) => format!(
            "--disable-features={DISABLED_FEATURES},CalculateNativeWinOcclusion \
             {WEBVIEW2_AUTOMATION_ARGS} {WEBVIEW2_COMMON_ARGS} --remote-debugging-port={port}"
        ),
        None => format!("--disable-features={DISABLED_FEATURES} {WEBVIEW2_COMMON_ARGS}"),
    }
}

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
    let args = browser_args(debug_port());
    // Edition 2021: `set_var` is safe. Called on the main thread at startup before
    // any webview (or other thread) exists.
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ids::BUNDLE_ID;

    #[test]
    fn a_port_of_zero_is_off_not_a_port() {
        // Zero is what the UI writes to turn the channel off. Passing it through
        // would hand WebView2 `--remote-debugging-port=0`, which does not mean
        // "off" to Chromium - it means "pick any free port", i.e. silently ON.
        assert_eq!("0".trim().parse::<u16>().ok().filter(|p| *p != 0), None);
    }

    /// The whole point of the split, in both directions.
    ///
    /// A normal user must get a webview Chromium is allowed to stop DRAWING when
    /// it is covered, because that is where the cost of an unattended window is.
    /// They must still get unthrottled TIMERS, because that is what keeps xterm
    /// draining terminal output and the pollers polling while TEDI sits behind
    /// another window. Shipping the whole Puppeteer set to everyone bought the
    /// second at the price of the first.
    #[cfg(target_os = "windows")]
    #[test]
    fn only_the_occlusion_flags_are_gated_on_the_automation_channel() {
        let off = browser_args(None);
        for flag in [
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "CalculateNativeWinOcclusion",
            "--remote-debugging-port",
        ] {
            assert!(
                !off.contains(flag),
                "{flag} must not ship with the channel off"
            );
        }
        assert!(
            off.contains("--disable-background-timer-throttling"),
            "timers must stay unthrottled for every user, or a covered window \
             drains terminal output at 1 Hz"
        );

        let on = browser_args(Some(9222));
        for flag in [
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "CalculateNativeWinOcclusion",
            "--remote-debugging-port=9222",
        ] {
            assert!(
                on.contains(flag),
                "{flag} is required when the channel is on"
            );
        }

        // wry's own feature disables survive both branches, and `--disable-features`
        // appears exactly once or Chromium drops all but the last copy.
        for args in [&off, &on] {
            assert!(args.contains("msWebOOUI"));
            assert!(args.contains("msPdfOOUI"));
            assert!(args.contains("msSmartScreenProtection"));
            assert_eq!(args.matches("--disable-features=").count(), 1, "{args}");

            // A malformed command line does not fail loudly, it is just ignored,
            // so check the shape: every token is a switch, and the `\` string
            // continuations did not eat or double a separator.
            assert!(!args.contains("  "), "double space in {args:?}");
            assert_eq!(args.trim(), args, "stray outer whitespace in {args:?}");
            for token in args.split(' ') {
                assert!(
                    token.starts_with("--"),
                    "{token:?} is not a switch in {args:?}"
                );
            }
        }
    }

    #[test]
    fn settings_path_is_under_the_bundle_id() {
        let files = settings_candidates();
        assert!(!files.is_empty(), "no OS config or data dir resolved");
        for f in files {
            assert!(f.ends_with("tedi-settings.json"));
            assert!(f.to_string_lossy().contains(BUNDLE_ID));
        }
    }
}
