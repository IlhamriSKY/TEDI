/**
 * Shared protocol for mirroring a pane into a floating OS window. Transport is
 * Tauri events (the proven cross-window channel - the Debug window uses the same
 * mechanism in ai/store/debugBridge; BroadcastChannel does NOT bridge separate
 * WebView2 windows). Leaf params travel in the float window's URL query.
 */

export type FloatKind = "terminal" | "editor" | "table" | "browser" | "extension-panel";

export type FloatLeafParams = {
  leafId: number;
  kind: FloatKind;
  title: string;
  /** editor leaf: absolute path */
  path?: string;
  /** editor leaf: private (AI disabled) */
  privateLeaf?: boolean;
  /**
   * terminal leaf: the pty lives on a remote host (SSH), not on this machine.
   * The float builds its own xterm over the SAME byte stream, so it needs the
   * same ConPTY compatibility decision the pane made (`WINDOWS_PTY`) - and an
   * SSH leaf must opt OUT of it, because that pty is a Unix one.
   */
  remotePty?: boolean;
  /** browser leaf: the address to seed the float's address bar with. The page
   *  itself is NOT reloaded - the same native webview is re-parented into the
   *  float window - so this only tells the float what it is already showing. */
  url?: string;
  /** table: the table serialized as markdown. Static content, so it rides in the
   *  window URL and needs no live event mirror (unlike terminals). */
  markdown?: string;
  /** extension-panel leaf: which panel to mount. Panel renderers live in
   *  per-webview registries, so the float window activates the extension in its
   *  own JS context and re-runs the renderer - nothing is mirrored. */
  extensionId?: string;
  panelId?: string;
  /** extension-panel leaf: the key the pane was opened with, so the float
   *  mounts the same instance a per-key panel would otherwise have to guess. */
  reuseKey?: string;
};

/** Encode leaf params for the float window URL (`float.html?p=...`). */
export function encodeFloatParams(p: FloatLeafParams): string {
  return encodeURIComponent(strToB64(JSON.stringify(p)));
}

/** Decode leaf params from the current float window URL. Returns null if absent/bad. */
export function decodeFloatParams(search: string): FloatLeafParams | null {
  const raw = new URLSearchParams(search).get("p");
  if (!raw) return null;
  try {
    return JSON.parse(b64ToStr(decodeURIComponent(raw))) as FloatLeafParams;
  } catch {
    return null;
  }
}

function strToB64(s: string): string {
  return bytesToB64(new TextEncoder().encode(s));
}
function b64ToStr(b64: string): string {
  return new TextDecoder().decode(b64ToBytes(b64));
}

// Per-leaf event names so multiple open floats never cross-talk.
export const floatEv = {
  out: (id: number) => `tedi://float-out:${id}`, // host -> client: output bytes (base64)
  in: (id: number) => `tedi://float-in:${id}`, // client -> host: input string
  hello: (id: number) => `tedi://float-hello:${id}`, // client -> host: ready, send snapshot
  snap: (id: number) => `tedi://float-snap:${id}`, // host -> client: FloatSnap
  size: (id: number) => `tedi://float-size:${id}`, // host -> client: FloatSize
  bye: (id: number) => `tedi://float-bye:${id}`, // client -> host: closing
  close: (id: number) => `tedi://float-close:${id}`, // host -> client: please close (dock back)
  url: (id: number) => `tedi://float-url:${id}`, // client -> host: browser navigated
};

export type FloatSnap = { text: string; cols: number; rows: number };
export type FloatSize = { cols: number; rows: number };

// Events serialize as JSON, so raw bytes ride as base64.
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
