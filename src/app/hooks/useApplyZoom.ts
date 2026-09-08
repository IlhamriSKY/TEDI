import { useEffect } from "react";

/**
 * Applies the two zoom preferences, which scale different things by different
 * mechanisms.
 *
 * `contentZoom` becomes the `--content-zoom` CSS variable, which CodeMirror and
 * the diff surfaces multiply into their own sizes. The terminal reads the
 * preference directly and scales xterm's `fontSize` instead, because CSS `zoom`
 * on a WebGL canvas misplaces the cursor and the glyphs.
 *
 * `uiZoom` is CSS `zoom` on `document.body`, so it also catches overlays
 * portaled outside `#root`. `WorkspaceArea` then counter-zooms the workspace
 * back to 1, keeping terminal, editor and preview at native resolution under
 * their own `--content-zoom`.
 */
export function useApplyZoom(contentZoom: number, uiZoom: number): void {
  useEffect(() => {
    document.documentElement.style.setProperty("--content-zoom", String(contentZoom));
  }, [contentZoom]);

  useEffect(() => {
    // Cleared at 100% rather than set to "1", so no stray inline style is left.
    document.body.style.zoom = uiZoom === 1 ? "" : String(uiZoom);
  }, [uiZoom]);
}
