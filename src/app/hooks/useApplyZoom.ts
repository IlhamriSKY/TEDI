import { useEffect } from "react";

/**
 * Applies the two zoom CSS knobs read from the preferences store.
 *
 * `contentZoom` is exposed as the `--content-zoom` CSS variable so CodeMirror
 * and diff surfaces can scale via `calc(... * var(--content-zoom))`. `uiZoom`
 * is applied as CSS `zoom` on `document.body` to scale the chrome plus
 * portaled overlays. The caller passes the live values; the workspace pane
 * counter-zooms back to 1 elsewhere so terminal/editor/preview keep native
 * resolution.
 */
export function useApplyZoom(contentZoom: number, uiZoom: number): void {
  // Expose the zoom factor as a CSS variable so CodeMirror and diff
  // surfaces can scale via `calc(... * var(--content-zoom))`. The terminal
  // reads the factor from the prefs store and multiplies into xterm's
  // `fontSize`. CSS `zoom` on a canvas/WebGL terminal breaks cursor and
  // glyph positioning, so we do not touch surfaces outside content.
  useEffect(() => {
    document.documentElement.style.setProperty("--content-zoom", String(contentZoom));
  }, [contentZoom]);
  // UI zoom scales the chrome only (header / tabs, sidebar, side panels, status
  // bar) plus portaled overlays, which mount on `document.body` outside `#root`.
  // Applied as CSS `zoom` on the body; the workspace pane counter-zooms back to
  // 1 (see `workspaceCounterZoom` below) so terminal / editor / preview keep
  // native resolution and their own `--content-zoom`. Cleared at 100% so we
  // don't leave a stray inline style.
  useEffect(() => {
    document.body.style.zoom = uiZoom === 1 ? "" : String(uiZoom);
  }, [uiZoom]);
}
