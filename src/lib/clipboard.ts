import { invoke } from "@tauri-apps/api/core";

/**
 * Clipboard text, or "" when there is nothing text-shaped to paste.
 *
 * Reads go through the host process (`clipboard_read_text`), NOT
 * `navigator.clipboard.readText()`. The webview API is write-only for us: wry
 * calls WebKitGTK's `set_javascript_can_access_clipboard` - which also flips
 * WebCore's `DOMPasteAllowed`, the flag gating clipboard READS - only when the
 * webview is built with `clipboard: true`, and Tauri defaults that to false with
 * no tauri.conf.json knob to raise it for a config-declared window. So on Linux
 * every `readText()` rejected with NotAllowedError while `writeText()` kept
 * working off the keystroke's user gesture: copy fine, paste dead (#10).
 *
 * Callers get "" rather than a rejection - an empty or image-only clipboard is
 * not an error, it just means "nothing to paste" - so paste sites stay a single
 * `if (text)` with no per-site catch.
 */
export async function readClipboardText(): Promise<string> {
  try {
    return await invoke<string>("clipboard_read_text");
  } catch (e) {
    console.warn("clipboard read failed:", e);
    return "";
  }
}
