import { WebglAddon } from "@xterm/addon-webgl";

import { wallpaperActive } from "./session-helpers";
import type { Session } from "./sessionState";

/**
 * WebGL renderer management for a terminal session. Centralizes the
 * load/dispose dance (with context-loss recovery) that otherwise gets
 * copy-pasted at every site that toggles the renderer: first attach, the
 * wallpaper sync, the font-size effect, and the WebGL-pref effect.
 *
 * The WebGL renderer in `@xterm/addon-webgl` has a known issue (xterm.js
 * #4054) where an rgba `theme.background` alpha-multiplies the foreground
 * glyphs too, so callers dispose it while a wallpaper is active and the DOM
 * renderer takes over (independent per-cell bg/fg). See
 * `syncRendererForWallpaper`.
 */

/**
 * Load the WebGL renderer onto the session's terminal and wire context-loss
 * recovery (a lost GL context disposes the addon and clears the slot so a
 * later sync can re-load it). Swallows construction failures — some
 * environments have no WebGL — leaving the session on the DOM renderer.
 * Caller is responsible for gating on whether the renderer *should* be active
 * (`s.webglEnabled`, wallpaper state, no existing addon).
 */
export function loadWebglRenderer(s: Session): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (s.webglAddon === webgl) s.webglAddon = null;
    });
    s.term.loadAddon(webgl);
    s.webglAddon = webgl;
  } catch (e) {
    console.warn("WebGL renderer unavailable:", e);
  }
}

/** Dispose any active WebGL renderer on the session and clear the slot. */
export function disposeWebglRenderer(s: Session): void {
  if (!s.webglAddon) return;
  try {
    s.webglAddon.dispose();
  } catch {
    /* ignore */
  }
  s.webglAddon = null;
}

/**
 * Toggle the WebGL renderer in/out depending on whether a wallpaper is
 * active and the user pref allows it. WebGL is disposed when the wallpaper
 * turns on (so semi-transparent cell backgrounds render correctly via the
 * DOM renderer) and re-loaded when it turns off.
 */
export function syncRendererForWallpaper(s: Session): void {
  const wantWebgl = s.webglEnabled && !wallpaperActive();
  if (wantWebgl && !s.webglAddon) {
    loadWebglRenderer(s);
  } else if (!wantWebgl && s.webglAddon) {
    disposeWebglRenderer(s);
  }
}
