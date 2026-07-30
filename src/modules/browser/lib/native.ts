import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri event carrying navigation reports from an embedded browser webview.
 * The event id string stays `"tedi:preview-nav"` because the Rust backend
 * (unchanged) emits that exact name - only the frontend concept was renamed.
 */
export const BROWSER_NAV_EVENT = "tedi:preview-nav";

export type BrowserNavEvent = {
  /** Owning browser leaf id (the native webview is keyed by leaf id). */
  tabId: number;
  /** "navigated" = a load started (address bar should update); "loaded" = it
   *  finished; "title" = the page's document.title changed (carries `title`,
   *  and `url` reflects the current page so SPA route changes are tracked). */
  kind: "navigated" | "loaded" | "title";
  url: string;
  /** Set on "title" events: the page's current document.title. */
  title?: string;
};

/**
 * Window CustomEvent asking the browser pane that owns `leafId` to focus its
 * address bar. Frontend-only (no Rust round-trip), keyed by leaf id so browser
 * shortcuts stay leaf-id-addressed like {@link previewEmbedDispatch} - the
 * focused `BrowserPane` listens and selects its input. Avoids threading a
 * browser-handle ref registry through the pane tree for a single consumer.
 * Note: one event vs. a 5-file ref registry; switch to a ref if a second
 * caller ever needs the live handle.
 */
export const BROWSER_FOCUS_ADDRESS_EVENT = "tedi:browser-focus-address";

export function focusBrowserAddressBar(leafId: number): void {
  window.dispatchEvent(new CustomEvent(BROWSER_FOCUS_ADDRESS_EVENT, { detail: { leafId } }));
}

export type EmbedBounds = { x: number; y: number; width: number; height: number };

/**
 * Create (first visible call) / reposition / show / hide the native browser
 * webview docked over a preview tab. Bounds are physical pixels. A hidden or
 * zero-area call hides the webview. Creation navigates to `url`; afterwards the
 * url is ignored here (use {@link previewEmbedNavigate}). `transparent` (read
 * from the app-opacity setting) makes the webview backdrop transparent; it only
 * takes effect when the webview is first created.
 */
export async function previewEmbedUpdate(
  tabId: number,
  url: string,
  bounds: EmbedBounds,
  visible: boolean,
  transparent: boolean,
): Promise<void> {
  await invoke("preview_embed_update", { tabId, url, bounds, visible, transparent });
}

/** Navigate an existing embedded preview webview to `url`. */
export async function previewEmbedNavigate(tabId: number, url: string): Promise<void> {
  await invoke("preview_embed_navigate", { tabId, url });
}

/** Drive the embedded webview's own history / loading: browser back, forward,
 *  reload, and `stop` to cancel a load in progress. */
export async function previewEmbedDispatch(
  tabId: number,
  action: "back" | "forward" | "reload" | "stop",
): Promise<void> {
  await invoke("preview_embed_dispatch", { tabId, action });
}

/** Read an embedded browser pane's rendered text (title + visible body, capped).
 *  Returns the live JS-rendered content - what a plain fetch can't see. When
 *  `fields` is true it also tags + lists interactive controls as `[N]` for
 *  {@link previewEmbedAct}. */
export async function previewEmbedRead(tabId: number, fields = false): Promise<string> {
  return invoke<string>("preview_embed_read", { tabId, fields });
}

/** One captured browser diagnostic: a console error/warning, an uncaught
 *  exception, or an unhandled promise rejection. Entries arrive in the order
 *  they occurred, so no timestamp is carried. */
export type BrowserDiag = { level: "error" | "warn"; text: string };

/** Drain an embedded browser pane's captured errors and warnings since the last
 *  call. Capture starts at document creation, so page-load failures are included.
 *  Draining (not peeking) keeps repeat calls from returning the same entries. */
export async function previewEmbedConsole(tabId: number): Promise<BrowserDiag[]> {
  const raw = await invoke<string>("preview_embed_console", { tabId });
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BrowserDiag[]) : [];
  } catch {
    return [];
  }
}

/** Type into or click an interactive control of an embedded browser pane,
 *  located by the `[N]` index from a `previewEmbedRead(_, true)`. Returns the
 *  raw result string: "ok", "not-found", "not-editable", or "error:..". */
export async function previewEmbedAct(
  tabId: number,
  index: number,
  action: "click" | "type" | "hover" | "key" | "scroll" | "clickxy",
  text: string,
  submit: boolean,
): Promise<string> {
  return invoke<string>("preview_embed_act", { tabId, index, action, text, submit });
}

/** Capture the embedded browser pane as a base64 JPEG (the agent's last-resort
 *  "look at it" for purely-visual targets). All three platforms: Windows renders
 *  the tab's own content via WebView2 `CapturePreview`, macOS and Linux crop a
 *  screen capture to the pane, so there the pane must be visible and the window
 *  in front. */
export async function previewEmbedScreenshot(tabId: number): Promise<string> {
  return invoke<string>("preview_embed_screenshot", { tabId });
}

/** Resolve a site's real favicon by parsing its declared `<link rel="icon">`
 *  (handles sites that serve no root `/favicon.ico` and use a custom path).
 *  Returns an absolute icon URL, or null when the page declares none. Fetched
 *  from the site itself, not a third-party favicon service. */
export async function previewResolveFavicon(url: string): Promise<string | null> {
  return invoke<string | null>("preview_resolve_favicon", { url });
}

/** Zoom steps the toolbar walks through, matching what Chrome and Edge offer so
 *  the control feels like the browser it is. 1 is 100%. */
export const BROWSER_ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

/** The step one place up (`dir` 1) or down (`dir` -1) from `factor`, clamped at
 *  both ends. Nearest-step based rather than index based, so it still behaves
 *  when the current zoom came from the webview's own Ctrl+/- and sits between
 *  two steps. */
export function nextBrowserZoom(factor: number, dir: 1 | -1): number {
  const steps = BROWSER_ZOOM_STEPS;
  if (dir === 1) return steps.find((s) => s > factor + 1e-6) ?? steps[steps.length - 1];
  let prev: number = steps[0];
  for (const s of steps) {
    if (s < factor - 1e-6) prev = s;
    else break;
  }
  return prev;
}

/** Set a browser pane's zoom level. 1 is 100%. */
export async function previewEmbedZoom(tabId: number, factor: number): Promise<void> {
  await invoke("preview_embed_zoom", { tabId, factor });
}

/** Read a pane's current zoom back. Worth doing rather than trusting a local
 *  copy: the pane is a real webview, so its own Ctrl+/- and Ctrl+scroll change
 *  the zoom without TEDI ever seeing the keystroke. */
export async function previewEmbedZoomGet(tabId: number): Promise<number> {
  return invoke<number>("preview_embed_zoom_get", { tabId });
}

/** The url the pane's webview is really on, or null when it has none. The webview
 *  outlives its React component (a pane move remounts it; a float moves it to
 *  another window), so a freshly mounted pane asks instead of trusting the url it
 *  was handed. */
export async function previewEmbedUrl(tabId: number): Promise<string | null> {
  return invoke<string | null>("preview_embed_url", { tabId });
}

/** Move a pane's webview to another window (`"main"`, or a float window's label).
 *  The same webview is re-parented, so the page is NOT reloaded and its scroll
 *  position, session and playing media all survive popping out. */
export async function previewEmbedReparent(tabId: number, windowLabel: string): Promise<void> {
  await invoke("preview_embed_reparent", { tabId, windowLabel });
}

/** Set the page background color of an embedded browser pane (live), so its
 *  transparency follows the app-opacity slider. `color` is a CSS color string
 *  (e.g. `rgba(20,20,20,0.6)`). */
export async function previewEmbedSetBg(tabId: number, color: string): Promise<void> {
  await invoke("preview_embed_set_bg", { tabId, color });
}

// Whether each embedded webview was created with a transparent (alpha-capable)
// backdrop. The webview outlives its React component (pane moves remount the
// component without destroying the webview), so this must be keyed by the
// webview's own lifetime - the leaf id - not held in a per-component ref.
const createdTransparentById = new Map<number, boolean>();

/** Record, once, whether the webview for `tabId` was created transparent. Only
 *  the first call (the actual create) sticks; later repositions/remounts no-op,
 *  so the flag reflects create time even after the pane is moved. */
export function markPreviewCreated(tabId: number, transparent: boolean): void {
  if (!createdTransparentById.has(tabId)) createdTransparentById.set(tabId, transparent);
}

/** Whether the webview for `tabId` was created transparent. Only such webviews
 *  can actually fade their backdrop, so the opacity slider drives only these. */
export function wasPreviewCreatedTransparent(tabId: number): boolean {
  return createdTransparentById.get(tabId) === true;
}

/** Destroy the embedded webview when its preview tab closes. */
export async function browserEmbedClose(tabId: number): Promise<void> {
  createdTransparentById.delete(tabId);
  await invoke("preview_embed_close", { tabId });
}

/**
 * Hide (but do NOT destroy) an embedded webview. Used when a preview's owning
 * workspace becomes inactive: its `BrowserPane` unmounts, so the rAF loop that
 * normally hides the always-on-top native webview is gone, yet the webview is
 * deliberately kept alive (so switching back doesn't reload the page). Without
 * this the webview stays composited over the now-active workspace. Empty url +
 * `visible: false` hides an existing webview, or no-ops when none exists - it
 * never creates or reloads one.
 */
export async function browserEmbedHide(tabId: number): Promise<void> {
  await invoke("preview_embed_update", {
    tabId,
    url: "",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    transparent: false,
  });
}
