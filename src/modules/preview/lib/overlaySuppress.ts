import { useSyncExternalStore } from "react";

/**
 * Native webviews always composite *above* the DOM, so a dropdown, dialog,
 * command palette, or any popper that lands over an embedded preview webview
 * would be hidden behind it. `PreviewPane` fixes that by hiding its webview
 * while an overlay actually overlaps its rect.
 *
 * This module is the cheap gate: a shallow `<body>` observer flips
 * {@link useAnyOverlayOpen} when any overlay element is mounted, so the
 * per-frame geometric test ({@link anyOverlayIntersects}) only runs while
 * something is actually open. Overlays positioned *away* from the webview
 * (e.g. the toolbar tooltips, which open `side="top"`) never match the
 * geometric test, so hovering the toolbar doesn't flicker the page.
 */
const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"]';

let isOpen = false;
let rafId = 0;
let observer: MutationObserver | null = null;
let refCount = 0;
const listeners = new Set<() => void>();

function recompute() {
  rafId = 0;
  const next = document.querySelector(OVERLAY_SELECTOR) !== null;
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
