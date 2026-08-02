/**
 * The fold chevron TEDI paints in a gutter.
 *
 * Its own module (with no imports) so the extension host's lightweight
 * `ctx.ui.codeEditor` can use the exact same glyph as the editor pane without
 * pulling in the rest of `lib/extensions.ts` (minimap, lint, search). A fold
 * arrow that differs between the two surfaces reads as two different controls.
 *
 * `cm-foldMarker-open` on the open state is what lets a theme keep a COLLAPSED
 * marker visible while the open ones fade.
 */
export function makeFoldMarker(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-foldMarker" + (open ? " cm-foldMarker-open" : "");
  span.innerHTML = open
    ? '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 4 L10 8 L6 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return span;
}
