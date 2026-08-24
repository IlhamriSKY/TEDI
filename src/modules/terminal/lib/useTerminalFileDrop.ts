import { IS_WINDOWS } from "@/lib/platform";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";
import { findLeafIdFromPoint, writeToLeaf } from "./useTerminalSession";

// Two drop pathways into terminal PTYs, both ending in `writeToLeaf`:
//
//   1. OS-level file drops from outside the WebView (file manager, etc).
//      Captured by Tauri (`dragDropEnabled: true` by default) and emitted
//      as `tauri://drag-drop`. Handled by `useTerminalFileDrop` below
//      with screen-coordinate hit-testing via `findLeafIdFromPoint`.
//   2. Internal drops from a TEDI file explorer row → terminal pane.
//      Synthesized from raw mouse events by `ensureFsDragListener`
//      (HTML5 drag-drop is unreliable inside the WebView because the
//      Tauri intercept consumes drag events before HTML sees them).
//   3. Internal drops from a file explorer row → any element carrying
//      `data-fs-drop="<destination dir>"`. Same synthesized gesture as (2);
//      instead of writing to a PTY it fires `FS_DROP_EVENT` on the zone, so
//      the panel that owns the zone decides what the drop means (the SSH
//      tree reads it as a remote move, or an upload when the source row is
//      a local one). Keeps this bridge free of any panel's semantics.
//
// `quoteForShell` is shared by both paths and the only OS-specific bit
// in this file. PowerShell + cmd accept double-quoted paths on Windows;
// POSIX shells use single quotes with the `'\''` close-escape-open trick.

export function quoteForShell(path: string): string {
  if (IS_WINDOWS) {
    // PowerShell and cmd both accept double-quoted paths; embedded `"` is escaped as `""`.
    if (!/[\s"&^%!()<>|,;=]/.test(path)) return path;
    return `"${path.replace(/"/g, '""')}"`;
  }
  // POSIX: single-quote, escape embedded single quotes via `'\''`.
  if (!/[\s"'\\$`!*?(){}[\];<>|&#~]/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Fired on a `data-fs-drop` element when an explorer row is released over
 *  it. Bubbles, so a panel listens once on its container. */
export const FS_DROP_EVENT = "tedi-fs-drop";

export type FsDropDetail = {
  /** `data-fs-path` of the dragged row. */
  path: string;
  /** `data-fs-drop` of the zone it landed on: the destination directory. */
  dir: string;
  /** The dragged row itself, so a listener can tell its own rows (a move)
   *  from another tree's (a transfer). */
  sourceEl: HTMLElement;
};

/** Nearest element under the cursor that accepts an fs drop: an internal drop
 *  zone or a terminal pane. `closest` picks whichever is nearer, so a zone
 *  nested inside a pane still wins. */
function dropTargetFromPoint(under: Element | null): HTMLElement | null {
  return (under?.closest?.("[data-fs-drop],[data-terminal-leaf-id]") ?? null) as HTMLElement | null;
}

// Module-scope guards.
let fsDragBridgeAttached = false;
let dragStyleInjected = false;

/**
 * Synthetic mouse-based "drag" for internal fs-path drops into terminal.
 *
 * Why mouse events instead of HTML5 drag-drop? Tauri 2's default
 * `dragDropEnabled: true` installs an OS-level drag-drop target on the
 * WebView (so it can emit `tauri://drag-drop` for external file drops).
 * The native intercept consumes drag events before the WebView's HTML
 * engine sees them, so HTML5 `dragstart`/`dragover`/`drop` either don't
 * fire reliably or show the "not allowed" cursor because the WebView
 * can't preventDefault on events it never received.
 *
 * Mouse events (`mousedown` / `mousemove` / `mouseup`) aren't part of
 * the drag-drop intercept surface; they fire normally regardless of
 * Tauri's setting. We synthesize a drag gesture:
 *
 *   - `mousedown` on `data-fs-path="<abs path>"` arms the source.
 *   - `mousemove` past a 5 px threshold activates drag mode (cursor +
 *     drop-target outline via `tedi-fs-dragging`).
 *   - `mouseup` over `data-terminal-leaf-id` writes the shell-quoted
 *     path into that PTY.
 *   - `mouseup` elsewhere or `Escape` cancels cleanly.
 *
 * Tradeoff: no native ghost preview under the cursor (browser only
 * draws ghosts for HTML5 drags). We compensate with a body-level
 * `cursor: copy` and an outline on the terminal pane under the cursor.
 *
 * The OS-level file drop path is unchanged. `useTerminalFileDrop`
 * still handles `tauri://drag-drop` for files dragged from outside.
 */
const DRAG_ACTIVATION_PX = 5;

type SyntheticDragState = {
  path: string;
  sourceEl: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  currentTarget: HTMLElement | null;
};

function injectFsDragStyle(): void {
  if (dragStyleInjected) return;
  if (typeof document === "undefined") return;
  // Belt-and-suspenders for Vite HMR: module-scope guards reset on
  // hot reload but the previously-injected `<style>` survives in the
  // DOM. A DOM check prevents accumulating duplicate tags during dev.
  if (document.querySelector('style[data-tedi-fs-drag="1"]')) {
    dragStyleInjected = true;
    return;
  }
  dragStyleInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-tedi-fs-drag", "1");
  style.textContent = `
body.tedi-fs-dragging,
body.tedi-fs-dragging * {
  cursor: copy !important;
  user-select: none !important;
}
/* Not gated on the body class: the OS-level drop path (an external file
   dragged in) has no synthesized gesture to set it, and marks its target
   row with the same class. */
.tedi-fs-drop-target {
  outline: 2px solid var(--ring, #3b82f6);
  outline-offset: -2px;
  transition: outline-color 80ms;
}
`;
  document.head.appendChild(style);
}

export function ensureFsDragListener(): void {
  if (fsDragBridgeAttached) return;
  if (typeof document === "undefined") return;
  fsDragBridgeAttached = true;
  injectFsDragStyle();

  let drag: SyntheticDragState | null = null;

  const clearDropTarget = (): void => {
    if (drag?.currentTarget) {
      drag.currentTarget.classList.remove("tedi-fs-drop-target");
      drag.currentTarget = null;
    }
  };

  const reset = (): void => {
    clearDropTarget();
    drag = null;
    document.body.classList.remove("tedi-fs-dragging");
  };

  document.addEventListener(
    "mousedown",
    (e: MouseEvent) => {
      if (e.button !== 0) return; // left-button only
      // Defensive: clear any stale drag state from a previous gesture
      // whose `mouseup` was missed (e.g. user released the button
      // outside the window on some platforms). Without this the body
      // class could stay stuck and a fresh click would inherit weird
      // visual state.
      if (drag) reset();
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-fs-path]");
      if (!el) return;
      const path = el.getAttribute("data-fs-path");
      if (!path) return;
      drag = {
        path,
        sourceEl: el as HTMLElement,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        currentTarget: null,
      };
    },
    true,
  );

  document.addEventListener(
    "mousemove",
    (e: MouseEvent) => {
      if (!drag) return;
      if (!drag.active) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (dx * dx + dy * dy < DRAG_ACTIVATION_PX * DRAG_ACTIVATION_PX) return;
        drag.active = true;
        document.body.classList.add("tedi-fs-dragging");
      }
      // Highlight the drop target under the cursor. `elementFromPoint`
      // is more reliable than `e.target` here because the cursor may be
      // over an element our `mousemove` listener doesn't bubble to
      // (e.g. xterm internal layers).
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const targetEl = dropTargetFromPoint(under);
      if (targetEl !== drag.currentTarget) {
        drag.currentTarget?.classList.remove("tedi-fs-drop-target");
        drag.currentTarget = targetEl;
        targetEl?.classList.add("tedi-fs-drop-target");
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (e: MouseEvent) => {
      if (!drag) return;
      const wasActive = drag.active;
      const path = drag.path;
      const sourceEl = drag.sourceEl;
      const lastTarget = drag.currentTarget;
      // Any button release ends the gesture and clears `tedi-fs-dragging` FIRST,
      // so the body class (which forces cursor:copy + user-select:none app-wide)
      // can never get stuck if the terminating release isn't the left button
      // (chorded click, or a WebView2 quirk). Only a left-button release over
      // a drop zone or terminal commits; a right-click mid-drag just cancels.
      reset();
      if (e.button !== 0) return;
      // Below the activation threshold → treat as a click; let onClick
      // on the source row run normally (we never preventDefault on
      // mousedown, so the click event still fires).
      if (!wasActive) return;
      // Drop ONLY counts if released over a drop zone or a terminal pane.
      // Use `elementFromPoint` at release time in case the cursor moved
      // off the highlighted target in the final frame.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const targetEl = dropTargetFromPoint(under) ?? lastTarget;
      if (!targetEl) return;
      // An internal drop zone claims the drop and just gets told what landed
      // on it. Dropping a row on its own zone is a no-op the owner filters.
      const dir = targetEl.getAttribute("data-fs-drop");
      if (dir !== null) {
        targetEl.dispatchEvent(
          new CustomEvent<FsDropDetail>(FS_DROP_EVENT, {
            bubbles: true,
            detail: { path, dir, sourceEl },
          }),
        );
        return;
      }
      const leafIdAttr = targetEl.getAttribute("data-terminal-leaf-id");
      const leafId = leafIdAttr ? Number(leafIdAttr) : NaN;
      if (Number.isNaN(leafId)) return;
      writeToLeaf(leafId, quoteForShell(path));
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag) reset();
    },
    true,
  );

  // Cancel if the gesture is interrupted - focus loss / alt-tab (blur), a
  // cancelled pointer, or the window being hidden/minimized - so the body class
  // never gets stuck. (HTML5 `dragend` is intentionally not used: Tauri's
  // dragDropEnabled intercept consumes drag events, so it would never fire.)
  const hardReset = () => {
    if (drag) reset();
  };
  window.addEventListener("blur", hardReset);
  document.addEventListener("pointercancel", hardReset, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hardReset();
  });
}

export function useTerminalFileDrop(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { position, paths } = event.payload;
        if (!paths || paths.length === 0) return;
        // `position` is in physical pixels; `elementFromPoint` wants CSS pixels.
        const dpr = window.devicePixelRatio || 1;
        const x = position.x / dpr;
        const y = position.y / dpr;
        const leafId = findLeafIdFromPoint(x, y);
        if (leafId == null) return;
        const text = paths.map(quoteForShell).join(" ");
        writeToLeaf(leafId, text);
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err) => console.error("terminal drag-drop listen failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
