import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Chrome / Edge extensions the embedded browser pane loads.
 *
 * A generic installer, not a feature for one kind of extension: content blocking
 * is the case that motivated it (the user brings a blocker they trust and it
 * maintains its own filter lists, instead of TEDI shipping one), but a password
 * manager or an internal corporate extension installs through the identical path
 * and needs no code of its own.
 *
 * Windows only: the pane is WebView2 (Chromium) there. macOS WKWebView has no
 * extension support, and on Linux the equivalent knob wants compiled WebKitGTK
 * `.so` plugins, not Chrome extensions. {@link BrowserExtInfo.supported} carries
 * that verdict from Rust so the UI never has to branch on platform itself.
 */
export type BrowserExt = {
  /** Folder name on disk. The handle for toggling and removing. */
  dir: string;
  name: string;
  version: string;
  /** 2 or 3. Chromium is removing Manifest V2, so the UI flags 2. */
  manifest_version: number;
  enabled: boolean;
  /** What it was installed from, when re-fetchable. Empty for a local file, so
   *  the UI only offers Update when there is something to re-fetch. */
  source: string;
  /** The extension's own settings page, relative to its root. Empty when it
   *  declares none. Opened as `chrome-extension://<id>/<optionsPage>`, which in
   *  a webview is the only way to configure an extension at all. */
  optionsPage: string;
};

/** One extension as the pane's browser engine reports it. The `id` is assigned
 *  by the engine from the install path, so it cannot be derived on our side. */
export type LoadedExt = { id: string; name: string };

/** The extensions the pane's engine has actually loaded. An installed extension
 *  missing from this list is not running, which reading our own folders could
 *  never reveal. Empty when the pane has no webview yet. */
export async function previewEmbedLoadedExts(tabId: number): Promise<LoadedExt[]> {
  return invoke<LoadedExt[]>("preview_embed_loaded_exts", { tabId });
}

/** Where the "browse extensions" button goes. */
export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/category/extensions";

/**
 * The extension id in a store listing url, or null when this is not one.
 *
 * Lets the browser offer to install whatever listing you are looking at, the way
 * a real browser's "Add to Chrome" button does. Deliberately anchored to the
 * three store hosts rather than matching an id anywhere: a 32-character
 * lowercase path segment is not rare enough on its own, and a false positive
 * would offer to install an arbitrary page.
 */
export function storeExtensionId(url: string): string | null {
  if (
    !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com|microsoftedge\.microsoft\.com)\//i.test(
      url,
    )
  ) {
    return null;
  }
  const path = url.toLowerCase().split(/[?#]/)[0];
  const m = /(?:^|\/)([a-p]{32})(?:\/|$)/.exec(path);
  return m ? m[1] : null;
}

export type BrowserExtInfo = {
  /** False on macOS / Linux, where the pane's engine cannot load extensions. */
  supported: boolean;
  /** Absolute path to the active extensions folder, for "reveal in folder". */
  extensionsDir: string;
  items: BrowserExt[];
};

export async function browserExtList(): Promise<BrowserExtInfo> {
  return invoke<BrowserExtInfo>("browser_ext_list");
}

/**
 * How far along an install is. Two phases, because both are slow for unrelated
 * reasons: a large store package is tens of MB to fetch and several times that
 * to write, so one undifferentiated spinner would sit still for minutes twice
 * over.
 */
export type ExtInstallProgress = {
  phase: "download" | "unpack";
  done: number;
  /** null only when a server declined to declare a content-length. */
  total: number | null;
};

/** Percentage for a progress bar, 0 when the total is not known yet. */
export function extInstallPercent(p: ExtInstallProgress | null): number {
  if (!p?.total) return 0;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

/** "12.4 / 77.0 MB", or just the numerator when no total was advertised. */
export function extInstallLabel(p: ExtInstallProgress | null): string {
  if (!p) return "";
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return p.total ? `${mb(p.done)} / ${mb(p.total)} MB` : `${mb(p.done)} MB`;
}

/** Install from a Chrome Web Store / Edge Add-ons listing, an `https://` link to
 *  a `.zip` / `.crx`, or a GitHub `owner/repo` whose latest release ships one.
 *  `onProgress` fires as the archive downloads and then as it unpacks. */
export async function browserExtInstall(
  source: string,
  onProgress?: (p: ExtInstallProgress) => void,
): Promise<BrowserExt> {
  // Rust takes the channel unconditionally - Tauri has no `CommandArg` for an
  // `Option<Channel>` - so one is always created. Without a listener it is inert.
  const progress = new Channel<ExtInstallProgress>();
  if (onProgress) progress.onmessage = onProgress;
  return invoke<BrowserExt>("browser_ext_install", { source, progress });
}

/** Install a `.zip` / `.crx` already on disk: one pulled from a store by hand,
 *  built locally, or distributed internally. Not a fallback for the url path,
 *  just the other half of it. */
export async function browserExtInstallFile(path: string): Promise<BrowserExt> {
  return invoke<BrowserExt>("browser_ext_install_file", { path });
}

/** Enable / disable by moving the folder in or out of the loaded directory,
 *  which is the only per-extension switch WebView2 gives us. */
export async function browserExtSetEnabled(dir: string, enabled: boolean): Promise<void> {
  await invoke("browser_ext_set_enabled", { dir, enabled });
}

export async function browserExtRemove(dir: string): Promise<void> {
  await invoke("browser_ext_remove", { dir });
}
