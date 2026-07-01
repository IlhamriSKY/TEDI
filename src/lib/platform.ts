import { platform } from "@tauri-apps/plugin-os";

const PLATFORM = (() => {
  try {
    return platform();
  } catch {
    return "";
  }
})();

export const IS_MAC = PLATFORM === "macos";
export const IS_LINUX = PLATFORM === "linux";
export const IS_WINDOWS = PLATFORM === "windows";

/** Custom window controls render on non-macOS platforms. macOS keeps the native traffic lights. */
export const USE_CUSTOM_WINDOW_CONTROLS = !IS_MAC && PLATFORM !== "";

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
/** KeyBinding property for the platform's primary modifier. */
export const MOD_PROP: "meta" | "ctrl" = IS_MAC ? "meta" : "ctrl";
export const CTRL_KEY = IS_MAC ? "⌃" : "Ctrl";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
export const SHIFT_KEY = IS_MAC ? "⇧" : "Shift";
export const TAB_KEY = IS_MAC ? "⇥" : "Tab";
export const ENTER_KEY = IS_MAC ? "↵" : "Enter";

export const KEY_SEP = IS_MAC ? "" : "+";

export function fmtShortcut(...parts: string[]): string {
  return parts.join(KEY_SEP);
}

/** Secondary utility windows (Settings, Debug) mount their own root, not `#root`
 *  (only index.html mounts there). Used to opt them out of main-window-only
 *  effects like wallpaper + app transparency, so any future utility window opts
 *  out too. */
export function isSecondaryWindow(): boolean {
  if (typeof document === "undefined") return false;
  return document.getElementById("root") === null;
}
