import { useSyncExternalStore } from "react";

/**
 * Native webviews always composite *above* the DOM, so a dropdown, dialog,
 * command palette, or any popper that lands over an embedded preview webview
 * would be hidden behind it. `BrowserPane` fixes that by hiding its webview
 * while an overlay actually overlaps its rect.
 *
 * This module is the cheap gate: a shallow `<body>` observer flips
 * {@link useAnyOverlayOpen} when any overlay element is mounted, so the
 * per-frame geometric test ({@link anyOverlayIntersects}) only runs while
 * something is actually open.
 *
 * **Tooltips are deliberately excluded.** Radix tooltips are popper-based, so
 * they also match `[data-radix-popper-content-wrapper]`, but they are
 * non-interactive (`pointer-events: none`) and transient. The status-bar icon
 * buttons open their tooltips `side="top"` - i.e. straight up over the preview
 * pane - so counting them as overlays made the whole browser page flash away on
 * a plain hover, then reappear on hover-out. Real, interactive surfaces (menus,
 * dialogs, popovers, selects) still suppress the webview so they stay clickable
 * on top of it; only tooltips are ignored. The trade-off is a tooltip that
 * happens to overlap the pane renders *behind* the webview, which is far less
 * disruptive than the page vanishing.
 */
const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"]';

/**
 * A tooltip popper to be ignored. Two independent signals, either is enough:
 *  - `[data-slot="tooltip-content"]`, the app's own marker on every
 *    {@link file://../../../components/ui/tooltip.tsx} bubble, and
 *  - `[role="tooltip"]`, which radix itself renders (a visually-hidden a11y
 *    span) *inside* the popper wrapper for EVERY tooltip - so even a tooltip
 *    that somehow lost the app marker (raw radix usage, prop-spread order) is
 *    still recognised and never flickers the browser pane away.
 * Both live as descendants of `[data-radix-popper-content-wrapper]`. Non-tooltip
 * overlays (menus, dialogs, popovers, selects, hover-cards) carry neither, so
 * they still count and keep suppressing the webview while open.
 */
function isTooltipPopper(el: Element): boolean {
  return el.querySelector('[data-slot="tooltip-content"], [role="tooltip"]') !== null;
}

/** True when at least one *non-tooltip* overlay is currently mounted. */
function hasRealOverlay(): boolean {
  const els = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < els.length; i++) {
    if (!isTooltipPopper(els[i])) return true;
  }
  return false;
}

let isOpen = false;
let rafId = 0;
let observer: MutationObserver | null = null;
let refCount = 0;
const listeners = new Set<() => void>();

function recompute() {
  rafId = 0;
  const next = hasRealOverlay();
  if (next === isOpen) return;
  isOpen = next;
  listeners.forEach((l) => l());
}

function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(recompute);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (refCount++ === 0) {
    observer = new MutationObserver(schedule);
    // Radix portals mount as direct children of <body>, so a shallow childList
    // observer catches every open/close - far cheaper than a subtree observer
    // that would fire on every terminal or editor DOM mutation.
    observer.observe(document.body, { childList: true });
    schedule();
  }
  return () => {
    listeners.delete(onChange);
    if (--refCount === 0 && observer) {
      observer.disconnect();
      observer = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }
  };
}

/** True while any overlay (dropdown / dialog / popover / menu) is mounted. */
export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}

/**
 * Whether any currently-open overlay's box intersects `rect` (viewport CSS px).
 * Call only while {@link useAnyOverlayOpen} is true to keep it off the hot path.
 */
export function anyOverlayIntersects(rect: DOMRect): boolean {
  const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < overlays.length; i++) {
    if (isTooltipPopper(overlays[i])) continue;
    const o = overlays[i].getBoundingClientRect();
    if (o.width < 1 || o.height < 1) continue;
    if (o.left < rect.right && o.right > rect.left && o.top < rect.bottom && o.bottom > rect.top) {
      return true;
    }
  }
  return false;
}

// Pane drag-and-drop: while a pane is being dragged, hide preview webviews. The
// native webview sits above the DOM, so otherwise it would (a) cover the blue
// drop-indicator box and (b) capture the pointer, starving dnd-kit of the
// pointer-move events it needs to resolve the drop target over a browser pane.
let dragActive = false;
const dragListeners = new Set<() => void>();

export function setPaneDragActive(active: boolean): void {
  if (active === dragActive) return;
  dragActive = active;
  dragListeners.forEach((l) => l());
}

/** True while a pane is being dragged anywhere in the app. */
export function usePaneDragActive(): boolean {
  return useSyncExternalStore(
    (cb) => {
      dragListeners.add(cb);
      return () => dragListeners.delete(cb);
    },
    () => dragActive,
    () => false,
  );
}
