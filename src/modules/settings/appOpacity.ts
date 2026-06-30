/**
 * Whole-app transparency applier. The OS window is already created transparent
 * (see src-tauri/src/lib.rs); the app only looks solid because surfaces paint
 * opaque colours. Lowering app opacity fades the canvas + surfaces toward the
 * wallpaper image (or the desktop when none is set) for an Arch-terminal look.
 *
 * Main window only: the settings window stays solid so its controls remain
 * readable. The transparency on the main window (visible behind/around the
 * settings dialog) is the live feedback while dragging the slider.
 */
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { APP_OPACITY_DEFAULT, clampOpacity } from "./store";

const FAST_PATH_KEY = "tedi-app-opacity-shadow";
// Transient live-drag channel: the settings slider broadcasts each step so the
// main window fades in real time WITHOUT touching the stored value (which the
// slider is bound to — writing it mid-drag makes the thumb fight the drag).
const PREVIEW_EVENT = "tedi://app-opacity-preview";
// At/above this the canvas is effectively opaque, so the glass layer is off.
const GLASS_EPSILON = 0.999;

function readShadow(): number {
  if (typeof window === "undefined") return APP_OPACITY_DEFAULT;
  const raw = window.localStorage.getItem(FAST_PATH_KEY);
  return clampOpacity(raw === null ? APP_OPACITY_DEFAULT : Number(raw));
}

function writeShadow(value: number): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, String(value));
  } catch {
    // ignore: localStorage may be unavailable in some embeddings.
  }
}

// Secondary utility windows (Settings, Debug) opt out of app transparency so
// their controls stay solid/readable. Detect "not the main window" by the
// absence of `#root` (only index.html mounts there), so any future utility
// window opts out too.
function isSecondaryWindow(): boolean {
  if (typeof document === "undefined") return false;
  return document.getElementById("root") === null;
}

/**
 * Apply whole-app opacity to the main window: set `--tedi-app-opacity` and
 * toggle `data-tedi-glass`, which globals.css uses to fade the canvas +
 * surfaces. Settings window opts out so its controls stay readable.
 */
/**
 * CSS-only apply: set the var + glass attr + nudge the terminal canvases. No
 * persistence. Settings window opts out so its controls stay solid/readable.
 */
function applyOpacityCss(value: number): void {
  if (isSecondaryWindow()) return;
  const root = document.documentElement;
  root.style.setProperty("--tedi-app-opacity", String(value));
  if (value < GLASS_EPSILON) root.dataset.tediGlass = "on";
  else delete root.dataset.tediGlass;
  // Surfaces follow the CSS var instantly; nudge the terminal canvases too
  // (their rgba background is JS-rendered). Listener is rAF-throttled.
  window.dispatchEvent(new Event("tedi:canvas-opacity"));
}

export function applyAppOpacity(opacity: number): void {
  if (typeof document === "undefined") return;
  const value = clampOpacity(opacity);
  // Persist the fast-path shadow before the settings-window opt-out so the
  // next-boot first paint reflects the committed value regardless of which
  // window wrote it.
  writeShadow(value);
  applyOpacityCss(value);
}

/**
 * Transient drag-preview apply: CSS only, NEVER persisted. The shadow only
 * needs the committed value (written by `setAppOpacity` on release), so the
 * live-drag path skips the per-tick localStorage write.
 */
export function applyAppOpacityPreviewCss(value: number): void {
  if (typeof document === "undefined") return;
  applyOpacityCss(clampOpacity(value));
}

/**
 * Synchronous fast-path. Call before React mounts (main window only) so the
 * first paint already reflects the persisted opacity. Store hydration
 * re-applies the authoritative value shortly after.
 */
export function applyAppOpacityFastPath(): void {
  applyAppOpacity(readShadow());
}

/**
 * Broadcast a transient opacity for live slider dragging — applied to the main
 * window's CSS only, never persisted, so the bound value stays put and the
 * slider thumb tracks the drag smoothly. Persist with `setAppOpacity` on release.
 */
export function previewAppOpacity(value: number): void {
  void emit(PREVIEW_EVENT, clampOpacity(value));
}

/** Main window: apply transient drag previews from the settings slider. */
export function onAppOpacityPreview(cb: (value: number) => void): Promise<UnlistenFn> {
  return listen<number>(PREVIEW_EVENT, (e) => cb(e.payload));
}
