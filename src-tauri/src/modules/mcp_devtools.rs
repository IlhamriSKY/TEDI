//! The DevTools Protocol for the MCP tools that need it, over the bridge.
//!
//! WHY THIS EXISTS. Six MCP tools cannot be done in-realm: `keys`, `type_text`,
//! `click` and `drag` need a TRUSTED input event, `screenshot` needs the
//! compositor, and `eval_js` is CDP by definition. Until now they reached the
//! window over the automation port, and turning that port on is not free. It is
//! a WebView2 startup argument, so it needs a restart either way, and the Install
//! MCP button switched it on for everyone who installed the MCP server - along
//! with the flags that keep an automation window rendering while covered, which
//! were measured holding ~117 MB of renderer memory Chromium would otherwise
//! purge and costing 4.5% of a core instead of 0.1% behind another window.
//!
//! The same protocol is one COM call away on a webview this process already
//! owns (`browser::cdp::call`, which browser panes have used all along). Routing
//! the six tools through the authenticated local socket instead makes the port
//! unnecessary for MCP: no restart to turn anything on, nothing listening on
//! loopback, and no flags. What it costs: a screenshot of a window that is fully
//! covered by another one takes ~2.7 s rather than ~165 ms, because Chromium has
//! no composited frame to hand back and has to make one. It still succeeds.
//!
//! WHAT IS FORWARDED. Only the methods the driver actually sends (`ALLOWED`),
//! and nothing at all while the `misc` pack is switched off - the same switch
//! that hides those six tools, enforced here too, so a client holding the bridge
//! token cannot reach around it. `inspect logs` reads the console events this
//! module buffers while a client is using DevTools, exactly as the port-based
//! driver buffered them for its own connection.
//!
//! Windows only, like the port it replaces: WKWebView and WebKitGTK do not
//! implement the protocol.

use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

/// Bridge capability names. Handled in Rust, before anything reaches the webview.
pub const CAPABILITY: &str = "devtools";
pub const LOGS_CAPABILITY: &str = "devtoolsLogs";

/// Every CDP method `scripts/mcp/driver.mjs` sends for the six tools, and no
/// others. `Runtime.evaluate` alone is already arbitrary script in the page, so
/// this is not a sandbox; it is a statement of what the bridge is FOR, and it
/// keeps the browser-wide domains (`Storage`, `Network`, `Browser`, `Target`)
/// out of reach of anything that is not one of those tools.
const ALLOWED: &[&str] = &[
    "Runtime.evaluate",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Page.captureScreenshot",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.clearDeviceMetricsOverride",
];

/// The pack whose switch gates this channel. Mirrors `pack: "misc"` in
/// `scripts/mcp/tools.mjs`; `mcp-devtools-verify` checks the two agree.
pub const MISC_PACK: &[&str] = &[
    "keys",
    "type_text",
    "click",
    "drag",
    "screenshot",
    "eval_js",
];

/// The console sources `inspect logs` reports, the same three the port-based
/// driver listened to.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const LOG_EVENTS: &[&str] = &[
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Log.entryAdded",
];

/// Newest events kept. The page we are listening to is ours, but a render loop
/// that logs every frame must still not grow this without limit.
const LOG_RING: usize = 200;
/// Longest event kept, in characters of its JSON. A console call with a huge
/// object would otherwise pin megabytes here for one line of output.
const EVENT_CHARS: usize = 8000;

#[derive(Default)]
struct Capture {
    /// Bridge connections that have used DevTools and not disconnected.
    subscribers: usize,
    /// `(event, registration token)` for each live receiver. Only the COM half
    /// reads it, and that half exists on Windows alone.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    tokens: Vec<(String, i64)>,
    events: VecDeque<Value>,
}

fn capture() -> &'static Mutex<Capture> {
    static CAPTURE: OnceLock<Mutex<Capture>> = OnceLock::new();
    CAPTURE.get_or_init(Default::default)
}

/// Serialises `arm` and `disarm` end to end, awaits included. Without it a
/// connection leaving while another arrives could interleave as "enable (new),
/// disable (old)" and switch the capture off under a client that is still using
/// it - with nothing reporting that the logs had stopped.
fn sequence() -> &'static tokio::sync::Mutex<()> {
    static SEQUENCE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    SEQUENCE.get_or_init(Default::default)
}

/// Why a DevTools call is refused, or `None` when it may go ahead.
pub fn refusal(args: &[Value]) -> Option<String> {
    let Some(method) = args.first().and_then(Value::as_str) else {
        return Some("devtools: no method name".into());
    };
    if !ALLOWED.contains(&method) {
        return Some(format!(
            "devtools: {method} is not used by any MCP tool, so TEDI does not forward it"
        ));
    }
    if misc_pack_off() {
        return Some(
            "the misc pack (keys, type_text, click, drag, screenshot, eval_js) is switched off \
             in TEDI's MCP settings"
                .into(),
        );
    }
    None
}

/// Run one allowed method against the main window. Call [`refusal`] first.
pub async fn call(app: &AppHandle, args: &[Value]) -> Result<Value, String> {
    let method = args.first().and_then(Value::as_str).unwrap_or_default();
    let params = args
        .get(1)
        .filter(|p| p.is_object())
        .map(Value::to_string)
        .unwrap_or_else(|| "{}".into());
    let text = crate::modules::browser::cdp::call(app, "main", method, &params)
        .await
        // `cdp::call` was written for browser panes and says so when the webview
        // is missing; here the only webview is the main window.
        .map_err(|e| e.replace("no open browser pane with that id", "TEDI's main window is not open"))?;
    serde_json::from_str(&text).map_err(|e| format!("devtools: {method} answered non-JSON: {e}"))
}

fn misc_pack_off() -> bool {
    for path in crate::modules::ids::settings_candidates() {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        return serde_json::from_str::<Value>(&text)
            .map(|json| misc_pack_off_in(&json))
            .unwrap_or(false);
    }
    false
}

/// The pack counts as off only when EVERY tool in it is disabled: that is what
/// the pack switch writes, and a user who turned off just `eval_js` still wants
/// `click` to work, which needs `Runtime.evaluate` to find the element.
fn misc_pack_off_in(settings: &Value) -> bool {
    let Some(disabled) = settings.get("mcpDisabledTools").and_then(Value::as_array) else {
        return false;
    };
    MISC_PACK
        .iter()
        .all(|tool| disabled.iter().any(|d| d.as_str() == Some(tool)))
}

/// Start buffering console events for one more bridge connection. The first
/// subscriber turns the Runtime and Log domains on; later ones share them.
pub async fn arm(app: &AppHandle) -> Result<(), String> {
    // Refused before any bookkeeping where there is nothing to capture, so a
    // platform that can never arm does not leave a subscriber counted.
    if !cfg!(target_os = "windows") {
        return subscribe(app);
    }
    let _order = sequence().lock().await;
    let first = {
        let mut c = capture().lock().unwrap();
        c.subscribers += 1;
        if c.subscribers == 1 {
            // "Since this session connected", as the port-based driver meant it.
            c.events.clear();
        }
        c.subscribers == 1
    };
    if !first {
        return Ok(());
    }
    let started = async {
        subscribe(app)?;
        // The domains are what make the events flow. `Log` is tolerated on its
        // own: it is extra (blocked requests, CSP), and an older WebView2 that
        // lacks it must not cost the session the console.
        crate::modules::browser::cdp::call(app, "main", "Runtime.enable", "{}").await?;
        let _ = crate::modules::browser::cdp::call(app, "main", "Log.enable", "{}").await;
        Ok(())
    }
    .await;
    if started.is_err() {
        // Undo the count, or every later connection would read as "not the
        // first" and never try to subscribe again. The caller stays unarmed, so
        // this is the only place that releases it - and it is `release`, not
        // `disarm`, because the sequence lock is already held here.
        release(app).await;
    }
    started
}

/// One bridge connection that armed the capture has gone. The last one turns
/// the domains off again, so an idle TEDI keeps no DevTools session open - with
/// `Runtime` enabled, V8 also holds on to every object passed to `console.*`.
pub async fn disarm(app: &AppHandle) {
    let _order = sequence().lock().await;
    release(app).await;
}

/// `disarm` without taking the sequence lock, for a caller that holds it.
async fn release(app: &AppHandle) {
    let last = {
        let mut c = capture().lock().unwrap();
        c.subscribers = c.subscribers.saturating_sub(1);
        c.subscribers == 0
    };
    if !last {
        return;
    }
    unsubscribe(app);
    let _ = crate::modules::browser::cdp::call(app, "main", "Runtime.disable", "{}").await;
    let _ = crate::modules::browser::cdp::call(app, "main", "Log.disable", "{}").await;
}

/// Buffered events, oldest first, as `{ method, params }`.
pub fn logs() -> Vec<Value> {
    capture().lock().unwrap().events.iter().cloned().collect()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn push(method: &str, params_json: &str) {
    let params = if params_json.len() > EVENT_CHARS {
        // Kept as a marker rather than dropped: "something big was logged" is
        // still an answer, and a truncated JSON string would not parse.
        serde_json::json!({ "truncated": true, "chars": params_json.len() })
    } else {
        serde_json::from_str(params_json).unwrap_or(Value::Null)
    };
    let mut c = capture().lock().unwrap();
    if c.subscribers == 0 {
        return;
    }
    c.events
        .push_back(serde_json::json!({ "method": method, "params": params }));
    while c.events.len() > LOG_RING {
        c.events.pop_front();
    }
}

#[cfg(target_os = "windows")]
fn subscribe(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use webview2_com::DevToolsProtocolEventReceivedEventHandler;
    use windows::core::{HSTRING, PCWSTR, PWSTR};

    let webview = app
        .get_webview("main")
        .ok_or_else(|| "TEDI's main window is not open".to_string())?;
    webview
        .with_webview(|platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let mut tokens = Vec::new();
            for event in LOG_EVENTS {
                let name = HSTRING::from(*event);
                let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(PCWSTR(name.as_ptr()))
                else {
                    continue;
                };
                let method = (*event).to_string();
                let handler =
                    DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut json = PWSTR::null();
                            if args.ParameterObjectAsJson(&mut json).is_ok() {
                                push(&method, &webview2_com::take_pwstr(json));
                            }
                        }
                        Ok(())
                    }));
                let mut token = 0i64;
                if receiver
                    .add_DevToolsProtocolEventReceived(&handler, &mut token)
                    .is_ok()
                {
                    tokens.push(((*event).to_string(), token));
                }
            }
            // The lock is released BEFORE any COM call below. The event handler
            // takes the same lock on this same thread, and a std mutex is not
            // re-entrant, so holding it across a receiver call is a deadlock
            // waiting for the one event that lands at the wrong moment.
            let abandoned = {
                let mut c = capture().lock().unwrap();
                if c.subscribers == 0 {
                    true
                } else {
                    c.tokens.extend(tokens.iter().cloned());
                    false
                }
            };
            if abandoned {
                // Everyone left before the main thread got here: undo at once
                // rather than leave receivers nobody will ever remove.
                for (event, token) in tokens {
                    let name = HSTRING::from(event.as_str());
                    if let Ok(r) = core.GetDevToolsProtocolEventReceiver(PCWSTR(name.as_ptr())) {
                        let _ = r.remove_DevToolsProtocolEventReceived(token);
                    }
                }
            }
        })
        .map_err(|e| format!("TEDI's main window is not reachable: {e}"))
}

#[cfg(target_os = "windows")]
fn unsubscribe(app: &AppHandle) {
    use tauri::Manager;
    use windows::core::{HSTRING, PCWSTR};

    let Some(webview) = app.get_webview("main") else {
        return;
    };
    let _ = webview.with_webview(|platform| unsafe {
        let tokens = std::mem::take(&mut capture().lock().unwrap().tokens);
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        for (event, token) in tokens {
            let name = HSTRING::from(event.as_str());
            if let Ok(r) = core.GetDevToolsProtocolEventReceiver(PCWSTR(name.as_ptr())) {
                let _ = r.remove_DevToolsProtocolEventReceived(token);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn subscribe(_app: &AppHandle) -> Result<(), String> {
    Err("the DevTools Protocol is available on Windows only; \
         WKWebView and WebKitGTK do not implement it"
        .to_string())
}

#[cfg(not(target_os = "windows"))]
fn unsubscribe(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_methods_the_tools_send_are_forwarded() {
        let method = |m: &str| vec![Value::from(m), serde_json::json!({})];
        for m in ALLOWED {
            // The pack check reads the real settings file; only assert the
            // allowlist half here.
            let r = refusal(&method(m));
            assert!(
                r.is_none() || r.as_deref().is_some_and(|s| s.contains("misc pack")),
                "{m} should pass the allowlist: {r:?}"
            );
        }
        for m in [
            "Storage.getCookies",
            "Network.getAllCookies",
            "Browser.close",
            "Target.createTarget",
        ] {
            let r = refusal(&method(m)).unwrap_or_default();
            assert!(
                r.contains("not used by any MCP tool"),
                "{m} must be refused: {r}"
            );
        }
        assert!(refusal(&[]).unwrap().contains("no method name"));
    }

    #[test]
    fn the_pack_is_off_only_when_every_tool_in_it_is() {
        let with = |list: &[&str]| serde_json::json!({ "mcpDisabledTools": list });
        assert!(!misc_pack_off_in(&serde_json::json!({})), "no setting: on");
        assert!(
            !misc_pack_off_in(&with(&["eval_js"])),
            "one tool off: still on"
        );
        assert!(misc_pack_off_in(&with(MISC_PACK)), "every tool off: off");
        let mut all = MISC_PACK.to_vec();
        all.push("sh");
        assert!(
            misc_pack_off_in(&with(&all)),
            "other packs' tools do not matter"
        );
    }

    #[test]
    fn the_log_ring_is_bounded_and_only_fills_while_armed() {
        capture().lock().unwrap().subscribers = 0;
        push("Runtime.consoleAPICalled", "{}");
        assert!(logs().is_empty(), "nothing is kept with no subscriber");

        capture().lock().unwrap().subscribers = 1;
        for i in 0..(LOG_RING + 25) {
            push("Runtime.consoleAPICalled", &format!("{{\"n\":{i}}}"));
        }
        let kept = logs();
        assert_eq!(kept.len(), LOG_RING);
        assert_eq!(
            kept[0]["params"]["n"], 25,
            "the oldest are the ones dropped"
        );

        push(
            "Log.entryAdded",
            &format!("\"{}\"", "x".repeat(EVENT_CHARS + 1)),
        );
        assert_eq!(logs().last().unwrap()["params"]["truncated"], true);
        let mut c = capture().lock().unwrap();
        c.subscribers = 0;
        c.events.clear();
    }
}
