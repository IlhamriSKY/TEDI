/**
 * Safe reads of a `react-resizable-panels` panel's current size.
 *
 * `PanelImperativeHandle.getSize()` THROWS `Layout not found for Panel <id>`
 * whenever the panel element exists but the group has not registered a layout
 * for it. There is no non-throwing way to ask: both `getSize()` and
 * `isCollapsed()` go through the same two lookups (`group.panels.find(...)` and
 * `layout[id]`), and each throws on a miss.
 *
 * That state is not exotic - it is the normal frame after a column mounts. The
 * side columns render NO panel while they hold nothing, so the first section to
 * arrive both mounts the panel and bumps the section count, and an effect that
 * reacts to the count then reads a ref that is already set while the layout for
 * that brand-new panel is still absent. The throw escapes the effect, reaches
 * the ErrorBoundary, and blanks the pane stack - which is what "opening the
 * right pane errors" looked like from the outside.
 *
 * A `panel &&` null check does not cover it, because the ref is non-null by
 * then. Reading through here does.
 */
import type { PanelImperativeHandle } from "react-resizable-panels";

/**
 * The panel's width as a percentage, or `null` when it has no layout yet.
 *
 * Callers must decide what "unknown" means for them rather than defaulting it
 * here, because the two uses in this app want opposite answers: an expand wants
 * to do nothing, while a visibility read wants "not visible".
 */
export function panelSizePct(panel: PanelImperativeHandle | null | undefined): number | null {
  if (!panel) return null;
  try {
    return panel.getSize().asPercentage;
  } catch {
    // Mounted but not yet laid out. A freshly mounted panel starts at its
    // `defaultSize`, so there is nothing a caller needs to correct.
    return null;
  }
}

/** Whether the panel is currently taking up width. Unknown counts as hidden. */
export function isPanelOpen(panel: PanelImperativeHandle | null | undefined): boolean {
  return (panelSizePct(panel) ?? 0) > 0;
}

/**
 * Expand the panel only if it is genuinely collapsed shut.
 *
 * Skips when the layout is unknown: a panel that has only just mounted is
 * already at its `defaultSize`, so expanding it would be a no-op at best and a
 * fight with the user's own collapse at worst.
 */
export function expandIfShut(panel: PanelImperativeHandle | null | undefined): void {
  const pct = panelSizePct(panel);
  if (pct !== null && pct <= 0) panel?.expand();
}

/**
 * Flip the panel open or shut. No-op when it has no layout yet.
 *
 * The guard is not only about the READ. `expand()` and `collapse()` resolve the
 * panel's constraints and layout through the same two lookups `getSize()` does,
 * so both throw on the same miss - which means `isPanelOpen(p) ? collapse() :
 * expand()` still crashes on a just-mounted panel even though the read itself
 * was made safe. Skipping is the right answer rather than guessing a direction:
 * a panel with no layout is one the user cannot have seen yet.
 */
export function togglePanelOpen(panel: PanelImperativeHandle | null | undefined): void {
  const pct = panelSizePct(panel);
  if (pct === null) return;
  if (pct > 0) panel?.collapse();
  else panel?.expand();
}

/** Drive the panel to `open`. No-op when unknown, or already there. */
export function setPanelOpen(panel: PanelImperativeHandle | null | undefined, open: boolean): void {
  const pct = panelSizePct(panel);
  if (pct === null) return;
  const isOpen = pct > 0;
  if (open && !isOpen) panel?.expand();
  else if (!open && isOpen) panel?.collapse();
}

/**
 * `isCollapsed()`, or `null` when the panel has no layout yet.
 *
 * NOT interchangeable with `isPanelOpen`. A side COLUMN collapses to zero, so
 * its width answers the question; a SECTION inside a column collapses to its
 * header height, which is not zero, so only the library can say. Using the
 * width there would report every minimized section as still open.
 */
export function panelCollapsed(panel: PanelImperativeHandle | null | undefined): boolean | null {
  if (!panel) return null;
  try {
    return panel.isCollapsed();
  } catch {
    return null;
  }
}

/** Drive the panel to `collapsed`. No-op when unknown, or already there. */
export function setPanelCollapsed(
  panel: PanelImperativeHandle | null | undefined,
  collapsed: boolean,
): void {
  const state = panelCollapsed(panel);
  if (state === null || state === collapsed) return;
  if (collapsed) panel?.collapse();
  else panel?.expand();
}
