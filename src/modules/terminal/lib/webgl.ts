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
 * Auto-reload attempts after a GPU context loss, per session. Locking Windows
 * (and driver resets, and blowing past Chromium's ~16-live-context ceiling with
 * enough panes) fires `webglcontextlost`; the addon waits 3s for a restore and
 * then gives up. Disposing without re-loading drops the pane to the DOM
 * renderer — an order of magnitude slower — silently, for the rest of the
 * session, which reads as "TEDI got sluggish after I unlocked". Capped so a
 * genuine context storm settles on the DOM renderer instead of ping-ponging.
 */
const MAX_CONTEXT_LOSS_RELOADS = 3;
const CONTEXT_LOSS_RELOAD_DELAY_MS = 1_000;

/**
 * Load the WebGL renderer onto the session's terminal and wire context-loss
 * recovery: a lost GL context disposes the addon (xterm falls back to the DOM
 * renderer) and schedules one re-load, up to `MAX_CONTEXT_LOSS_RELOADS`.
 * Swallows construction failures — some environments have no WebGL — leaving
 * the session on the DOM renderer. Caller is responsible for gating on whether
 * the renderer *should* be active (`s.webglEnabled`, wallpaper state, no
 * existing addon).
 */
export function loadWebglRenderer(s: Session): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (s.webglAddon !== webgl) return;
      s.webglAddon = null;
      if (s.webglLossReloads >= MAX_CONTEXT_LOSS_RELOADS) {
        console.warn("WebGL context lost repeatedly; staying on the DOM renderer");
        return;
      }
      s.webglLossReloads += 1;
      // Delay so the GPU process has settled before we ask for a new context;
      // re-entering through the wallpaper sync keeps the "should it be on at
      // all" decision in one place.
      setTimeout(() => {
        if (s.disposed || s.webglAddon || !s.term.element) return;
        syncRendererForWallpaper(s);
      }, CONTEXT_LOSS_RELOAD_DELAY_MS);
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
