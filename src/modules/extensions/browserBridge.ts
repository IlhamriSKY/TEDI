import { runExtensionCommand, useExtensionsStore } from "./store";

/**
 * The one place core knows the browser extension by name, and deliberately the
 * whole of that coupling: one id, two calls, nothing exported but the two
 * helpers below.
 *
 * Two core affordances legitimately mean "show me this page": the preview pill
 * that appears when a terminal prints a dev-server URL, and the `+` menu. Both
 * are terminal and workspace features, and the only surface that can answer
 * them is the browser extension. So core offers them ONLY while that extension
 * is installed and enabled, and is otherwise silent, rather than showing a
 * control that opens nothing.
 */
const BROWSER_EXTENSION_ID = "tedi.browser";

/** Part of the extension's published surface, so neither is a private hook. */
const OPEN_PANE_COMMAND = "tedi.browser.open";
const BROWSER_TOOL = "browser";

/** Read live, never cached: an extension can be installed, enabled or disabled
 *  mid-session, and a stale answer means either a pill that opens nothing or a
 *  hidden pill for a browser the user just installed. */
function browserExtensionReady(): boolean {
  return useExtensionsStore.getState().list.some((e) => e.id === BROWSER_EXTENSION_ID && e.enabled);
}

/** React-subscribed twin of {@link browserExtensionReady}. */
export function useBrowserExtensionReady(): boolean {
  return useExtensionsStore((s) => s.list.some((e) => e.id === BROWSER_EXTENSION_ID && e.enabled));
}

/**
 * Open `url` in the extension's browser and bring its pane up. Resolves false
 * when the extension is not there, so a caller can fall back or stay quiet
 * instead of reporting a success that did not happen.
 *
 * Two calls, because they answer different questions: the tool opens the tab
 * and owns the url, the command opens the pane the user then looks at. The tool
 * runs FIRST so the pane paints an already-loading page rather than a blank one
 * that jumps a moment later.
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
