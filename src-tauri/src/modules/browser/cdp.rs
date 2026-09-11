//! The DevTools Protocol, over the webview we already own.
//!
//! WHAT THIS IS. A browser pane is a `wry` webview this app created, and on
//! Windows that means WebView2, whose host can speak the DevTools Protocol to it
//! directly: `ICoreWebView2::CallDevToolsProtocolMethod` is one COM call on an
//! object we already hold. No debugging port, no WebSocket, no origin
//! allow-list, and nothing listening on loopback for another local program to
//! drive.
//!
//! WHAT IT BUYS. The whole agent surface: `Accessibility.getFullAXTree` for the
//! numbered-controls snapshot, `Input.dispatchMouseEvent` for TRUSTED clicks (a
//! click that `event.isTrusted` gates will accept, unlike anything synthesised
//! in JS), `Page.captureScreenshot`, `Runtime.evaluate`, and
//! `Emulation.setDeviceMetricsOverride`, which is how a pane on the canvas
//! renders a desktop-width page scaled down instead of relaying out into a
//! phone.
//!
//! (For the record, because the shape of this file is a reaction to it: the same
//! protocol used to be reached over a TCP debugging port opened by a second
//! browser process, with its number read off disk and its socket refused unless
//! the app's origin was allow-listed. Five moving parts, all of them gone.)
//!
//! WINDOWS ONLY, AND THE FALLBACK IS NOT A SECOND IMPLEMENTATION. WKWebView and
//! WebKitGTK have no DevTools Protocol at all, so there is nothing to call and
//! nothing to emulate: `call` returns one sentence naming the platform, and
//! callers either degrade to `evaluate_script` or say plainly that the action
//! needs Windows.

/// Send one CDP command to the browser pane behind `label` and return its JSON
/// result.
///
/// `params` is a JSON object as text, because that is what the COM API takes
/// and what every caller already has: the frontend composes it, and re-parsing
/// it here into a `serde_json::Value` only to print it again would be two
/// conversions that can each fail for no benefit.
#[cfg(target_os = "windows")]
pub async fn call(
    app: &tauri::AppHandle,
    label: &str,
    method: &str,
    params: &str,
) -> Result<String, String> {
    use tauri::Manager;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};

    let webview = app
        .get_webview(label)
        .ok_or_else(|| "no open browser pane with that id".to_string())?;

    // An EMPTY params string is not valid JSON and WebView2 rejects the whole
    // call for it, so the empty case has to become `{}` rather than being
    // passed through. Callers legitimately omit params for `Page.reload` and
    // friends.
    let params = if params.trim().is_empty() {
        "{}".to_string()
    } else {
        params.to_string()
    };
    let owned_method = method.to_string();

    // ONE-SHOT, NOT `wait_for_async_operation`. That helper pumps the message
    // loop while it waits, which is safe only on the thread that owns the loop;
    // this runs on a Tokio worker, where pumping another thread's queue is
    // undefined. The closure below runs on the main thread (that is what
    // `with_webview` guarantees) and hands the answer back over a channel.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    // SHARED, because two places can answer: the completion handler, and a call
    // WebView2 refuses outright, which never reaches that handler at all.
    let slot: std::sync::Arc<Reply> = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let for_handler = slot.clone();

    webview
        .with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(core) => core,
                Err(e) => return answer(&slot, Err(format!("no CoreWebView2: {e}"))),
            };
            let done =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
                    answer(
                        &for_handler,
                        match hr {
                            Ok(()) => Ok(json),
                            Err(e) => Err(format!("CDP call failed: {e}")),
                        },
                    );
                    Ok(())
                }));
            let m = HSTRING::from(owned_method.as_str());
            let p = HSTRING::from(params.as_str());
            // Reported from HERE, and it used to be dropped: the caller then read
            // "the browser pane went away" for a method WebView2 simply refused.
            if let Err(e) =
                core.CallDevToolsProtocolMethod(PCWSTR(m.as_ptr()), PCWSTR(p.as_ptr()), &done)
            {
                answer(&slot, Err(format!("CDP call failed: {e}")));
            }
        })
        .map_err(|e| format!("webview is not reachable: {e}"))?;

    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the browser pane went away before it answered".to_string()),
        Err(_) => Err(format!(
            "{method} got no answer in {}s",
            CALL_TIMEOUT.as_secs()
        )),
    }
}

/// Longest a DevTools call is waited for. WebView2 never completes one sent to
/// a page blocked in `alert()`, and the task awaiting it used to wait forever.
/// Longer than the extension's own deadline (30 s), so its message, which names
/// the likely dialog, is the one a caller sees.
#[cfg(target_os = "windows")]
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

#[cfg(target_os = "windows")]
type Reply = std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>;

/// Hand back the one answer. Whichever of the two answering places gets here
/// first wins; the other finds the sender already taken.
#[cfg(target_os = "windows")]
fn answer(slot: &Reply, value: Result<String, String>) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(value);
        }
    }
}

/// Every non-Windows target. One sentence, so a caller can match on nothing and
/// simply fall back to `evaluate_script`.
#[cfg(not(target_os = "windows"))]
pub async fn call(
    _app: &tauri::AppHandle,
    _label: &str,
    _method: &str,
    _params: &str,
) -> Result<String, String> {
    Err("the DevTools Protocol is available on Windows only; \
         WKWebView and WebKitGTK do not implement it"
        .to_string())
}
