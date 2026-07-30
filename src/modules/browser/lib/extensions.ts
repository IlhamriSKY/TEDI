import { invoke } from "@tauri-apps/api/core";

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
};

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

/** Install from an `https://` link to a `.zip` / `.crx`, or a GitHub
 *  `owner/repo` whose latest release ships one. */
export async function browserExtInstall(source: string): Promise<BrowserExt> {
  return invoke<BrowserExt>("browser_ext_install", { source });
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
