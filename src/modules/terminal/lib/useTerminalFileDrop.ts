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
body.tedi-fs-dragging [data-terminal-leaf-id].tedi-fs-drop-target {
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
      // Highlight the terminal pane under the cursor. `elementFromPoint`
      // is more reliable than `e.target` here because the cursor may be
      // over an element our `mousemove` listener doesn't bubble to
      // (e.g. xterm internal layers).
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const leafEl = (under?.closest?.("[data-terminal-leaf-id]") ?? null) as HTMLElement | null;
      if (leafEl !== drag.currentTarget) {
        drag.currentTarget?.classList.remove("tedi-fs-drop-target");
        drag.currentTarget = leafEl;
        leafEl?.classList.add("tedi-fs-drop-target");
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (e: MouseEvent) => {
      if (!drag) return;
      // Only the left-button release commits or cancels a drag. A
      // right-click during an in-progress drag still fires mouseup
      // (with `button === 2`) — without this filter that mid-gesture
      // release would mis-trigger a drop and lose the user's drag.
      if (e.button !== 0) return;
      const wasActive = drag.active;
      const path = drag.path;
      const targetLeaf = drag.currentTarget;
      reset();
      // Below the activation threshold → treat as a click; let onClick
      // on the source row run normally (we never preventDefault on
      // mousedown, so the click event still fires).
      if (!wasActive) return;
      // Drop ONLY counts if released over a terminal pane. Use
      // `elementFromPoint` at release time in case the cursor moved
      // off the highlighted target in the final frame.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const leafEl =
        ((under?.closest?.("[data-terminal-leaf-id]") ?? null) as HTMLElement | null) ??
        targetLeaf;
      if (!leafEl) return;
      const leafIdAttr = leafEl.getAttribute("data-terminal-leaf-id");
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

  // Cancel if the page loses focus mid-drag (alt-tab, etc.) so the
  // body class doesn't get stuck.
  window.addEventListener("blur", () => {
    if (drag) reset();
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
