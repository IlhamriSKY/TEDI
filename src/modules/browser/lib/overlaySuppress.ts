import { useSyncExternalStore } from "react";

import { IS_WINDOWS } from "@/lib/platform";

/**
 * Native webviews always composite *above* the DOM, so a dropdown, dialog,
 * command palette, or any popper that lands over an embedded preview webview
 * would be hidden behind it.
 *
 * Two answers, and which one is available depends on the platform. On Windows
 * the pane is a child window, so `BrowserPane` cuts the overlay's rectangle out
 * of its window region ({@link overlayRectsOver}) and the page stays on screen,
 * live, with the DOM showing through the hole. Everywhere else the only lever is
 * hiding the whole webview while an overlay overlaps it
 * ({@link anyOverlayIntersects}).
 *
 * This module is the cheap gate either way: a shallow `<body>` observer flips
 * {@link useAnyOverlayOpen} when any overlay element is mounted, so the
 * per-frame geometric test only runs while something is actually open.
 */
const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"]';

/**
 * Whether tooltips count as overlays. Only where a hole can be cut for them.
 *
 * Radix tooltips are popper-based, so they match the selector above like any
 * other overlay, but they are non-interactive and transient. Where the only
 * response is hiding the entire page, counting them was actively worse than
 * ignoring them: the status-bar icon buttons open their tooltips `side="top"`,
 * straight up over the pane, so the whole page flashed away on a plain hover and
 * came back on hover-out. Ignoring them cost a tooltip over the pane rendering
 * *behind* the page, i.e. invisibly, which was the lesser of two bad options.
 *
 * With a hole there is no trade to make, so on Windows they count and that
 * invisible-tooltip corner disappears.
 */
const COUNT_TOOLTIPS = IS_WINDOWS;

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

/** Whether this element should be ignored for the purposes of the pane. */
function skip(el: Element): boolean {
  return !COUNT_TOOLTIPS && isTooltipPopper(el);
}

/** True when at least one counting overlay is currently mounted. */
function hasRealOverlay(): boolean {
  const els = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < els.length; i++) {
    if (!skip(els[i])) return true;
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
 * Every open overlay box that lands on `rect` (viewport CSS px), in viewport
 * coordinates. These become the holes cut out of the pane. Call only while
 * {@link useAnyOverlayOpen} is true to keep it off the hot path.
 */
export function overlayRectsOver(rect: DOMRect): DOMRect[] {
  const out: DOMRect[] = [];
  const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < overlays.length; i++) {
    if (skip(overlays[i])) continue;
    const o = overlays[i].getBoundingClientRect();
    if (o.width < 1 || o.height < 1) continue;
    if (o.left < rect.right && o.right > rect.left && o.top < rect.bottom && o.bottom > rect.top) {
      out.push(o);
    }
  }
  return out;
}

/**
 * Whether any currently-open overlay's box intersects `rect`. The hide-the-pane
 * answer, for platforms that cannot cut a hole.
 */
export function anyOverlayIntersects(rect: DOMRect): boolean {
  return overlayRectsOver(rect).length > 0;
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
