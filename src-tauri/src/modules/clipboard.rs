/// Clipboard text for a paste, read in the HOST process instead of the webview.
///
/// `navigator.clipboard.readText()` is not usable on Linux: wry only enables
/// WebKitGTK's `javascript_can_access_clipboard` - which also flips WebCore's
/// `DOMPasteAllowed`, the flag gating clipboard READS - when the webview is built
/// with `clipboard: true`, and Tauri defaults that to false with no
/// tauri.conf.json knob to raise it for a config-declared window like `main`. So
/// every read rejected with NotAllowedError while writes kept working off the
/// keystroke's user gesture: copy fine, paste dead (#10). Writes stay on the
/// webview API; only reads come through here, on all three platforms so there is
/// one path to reason about.
///
/// A fresh `Clipboard` per call is deliberate. The handle owns an X11 connection
/// (or a Wayland data-control socket) that only has to outlive one read; keeping
/// one alive for the app's life is what selection OWNERSHIP needs, i.e. writes,
/// which we do not do here. `spawn_blocking` because the read is a synchronous
/// round trip to whichever process owns the selection - a slow owner would
/// otherwise stall the window, the same reason `pty_open` is async.
///
/// An empty or image-only clipboard comes back as `Err` from arboard, which the
/// frontend maps to "nothing to paste" like any other failure.
#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        arboard::Clipboard::new()
            .and_then(|mut c| c.get_text())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("clipboard task failed: {e}"))?
}
