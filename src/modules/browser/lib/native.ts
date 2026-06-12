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

/** Drive the embedded webview's own history / reload (browser back/forward/reload). */
export async function previewEmbedDispatch(
  tabId: number,
  action: "back" | "forward" | "reload",
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
 *  "look at it" for purely-visual targets). Windows-only; rejects elsewhere. */
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
