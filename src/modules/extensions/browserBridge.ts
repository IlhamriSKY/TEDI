import { runExtensionCommand, useExtensionsStore } from "./store";

/**
 * The one place core knows the browser extension by name.
 *
 * WHY CORE KNOWS AN EXTENSION AT ALL. Two core affordances legitimately mean
 * "show me this page": the preview pill that appears when a terminal prints a
 * dev-server URL, and the `+` menu. Both are terminal and workspace features,
 * and the only surface that can answer them is the browser extension.
 *
 * So core offers them ONLY when that extension is installed and enabled, and is
 * otherwise silent - a user who has not installed a browser is never shown a
 * control that opens nothing. This module is the whole of that coupling: one
 * id, two calls.
 */
export const BROWSER_EXTENSION_ID = "tedi.browser";

/** The extension's pane-opening command, and its agent tool. Both are part of
 *  its published surface, so neither is a private hook into it. */
const OPEN_PANE_COMMAND = "tedi.browser.open";
const BROWSER_TOOL = "browser";

/**
 * Is the browser extension installed AND enabled right now?
 *
 * Read live rather than cached: an extension can be installed, enabled or
 * disabled mid-session, and a stale answer means either a pill that opens
 * nothing or a hidden pill for a browser the user just installed.
 */
function browserExtensionReady(): boolean {
  return useExtensionsStore.getState().list.some((e) => e.id === BROWSER_EXTENSION_ID && e.enabled);
}

/** React-subscribed twin of {@link browserExtensionReady}, for components that
 *  show or hide a control based on it. */
export function useBrowserExtensionReady(): boolean {
  return useExtensionsStore((s) => s.list.some((e) => e.id === BROWSER_EXTENSION_ID && e.enabled));
}

/**
 * Open `url` in the extension's browser and bring its pane up.
 *
 * Two calls because they answer two different questions: the tool opens the tab
 * and owns the url, the command opens the pane the user then looks at. The tool
 * runs FIRST so the pane paints an already-loading page rather than a blank one
 * that jumps a moment later.
 *
 * Resolves false when the extension is not there, so a caller can fall back or
 * stay quiet instead of reporting a success that did not happen.
 */
export async function openUrlInBrowser(url: string): Promise<boolean> {
  if (!browserExtensionReady()) return false;
  try {
    if (url) {
      await runExtensionCommand(BROWSER_EXTENSION_ID, BROWSER_TOOL, { action: "open", url });
    }
    await runExtensionCommand(BROWSER_EXTENSION_ID, OPEN_PANE_COMMAND);
    return true;
  } catch {
    // A disabled-mid-call extension, or a handler that threw. Neither is worth
    // a toast: the user clicked a convenience, not a command they were owed.
    return false;
  }
}
