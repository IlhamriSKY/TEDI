/**
 * F6-style region cycling. xterm and CodeMirror both keep Tab, so without this a
 * keyboard user who lands in a terminal has no way to reach the file tree, the AI
 * panel or the tab strip. The regions are found in the DOM, in reading order, so a
 * panel that is collapsed or docked elsewhere simply takes its place in the cycle.
 */
const REGIONS = "[data-focus-region], [data-section-column]";
const FOCUSABLE =
  'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
/** What a region should land on, best first, before any plain focusable. */
const PREFERRED = [
  '[role="tree"]',
  "textarea:not(.xterm-helper-textarea)",
  '[aria-selected="true"]',
];
const BLOCKING = '[role="dialog"], [role="alertdialog"], [role="menu"]';

const shown = (el: HTMLElement): boolean =>
  el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";

function landingTarget(region: HTMLElement): HTMLElement | null {
  for (const selector of PREFERRED) {
    const hit = region.querySelector<HTMLElement>(selector);
    if (hit && shown(hit)) return hit;
  }
  for (const el of region.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!el.matches(":disabled") && shown(el)) return el;
  }
  return null;
}

/** `focusPane` moves focus into the active pane, which only its handle can do
 *  properly (xterm, CodeMirror); false falls back to the region's first control. */
export function cycleFocusRegion(delta: 1 | -1, focusPane: () => boolean): void {
  // A modal owns the keyboard; moving focus out of it would break its trap.
  if ([...document.querySelectorAll<HTMLElement>(BLOCKING)].some(shown)) return;
  const regions = [...document.querySelectorAll<HTMLElement>(REGIONS)].filter(
    (r) => r.getBoundingClientRect().width > 1,
  );
  if (regions.length === 0) return;
  const here = regions.findIndex((r) => r.contains(document.activeElement));
  const panes = regions.findIndex((r) => r.dataset.focusRegion === "panes");
  // Focus on nothing (a closed dialog can leave it there) goes straight to the pane.
  const start = here >= 0 ? here : panes - delta;
  for (let i = 1; i <= regions.length; i++) {
    const region = regions[(start + delta * i + regions.length * i) % regions.length];
    // Checked, not assumed: a pane behind the kanban board cannot take focus, and
    // stopping here would pin every later press to this region.
    if (
      region.dataset.focusRegion === "panes" &&
      focusPane() &&
      region.contains(document.activeElement)
    )
      return;
    const target = landingTarget(region);
    if (target) {
      target.focus();
      return;
    }
  }
}

const GUTTER = '[data-slot="resizable-handle"]';

/** Focus the gutter beside a pane; from a gutter, the enclosing split's. A panel
 *  outside the panes region is app chrome (the sidebar), not a split of this pane. */
export function focusPaneGutter(leafId: number, focusPane: () => boolean): void {
  const active = document.activeElement;
  const from = active?.matches(GUTTER)
    ? active.parentElement
    : document.querySelector(`[data-pane-leaf="${leafId}"]`);
  const panel = from?.closest('[data-slot="resizable-panel"]');
  if (!panel?.closest('[data-focus-region="panes"]')) return;
  const gutter = [panel.nextElementSibling, panel.previousElementSibling].find((el) =>
    el?.matches(GUTTER),
  ) as HTMLElement | undefined;
  if (!gutter) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") focusPane();
  };
  gutter.addEventListener("keydown", onKey);
  gutter.addEventListener("blur", () => gutter.removeEventListener("keydown", onKey), {
    once: true,
  });
  gutter.focus();
}
