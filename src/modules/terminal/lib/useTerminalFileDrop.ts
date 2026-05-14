import { IS_WINDOWS } from "@/lib/platform";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";
import { findLeafIdFromPoint, writeToLeaf } from "./useTerminalSession";

// OS-level file drag/drop is captured by Tauri (dragDropEnabled defaults to
// true in v2), so the WebView never sees HTML5 `drop` events. We instead
// listen to `tauri://drag-drop`, hit-test the cursor against the visible
// terminal pane, and paste the shell-quoted path(s) into that pane's PTY.
// This is what lets CLIs like `claude` accept files dropped onto the
// terminal.

function quoteForShell(path: string): string {
  if (IS_WINDOWS) {
    // PowerShell + cmd both honor double quotes for paths with spaces.
    // Embedded `"` is escaped as `""`, which both shells accept.
    if (!/[\s"&^%!()<>|,;=]/.test(path)) return path;
    return `"${path.replace(/"/g, '""')}"`;
  }
  // POSIX: single-quote everything potentially special, escaping embedded
  // single quotes via the classic `'\''` close/escape/open trick.
  if (!/[\s"'\\$`!*?(){}[\];<>|&#~]/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
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
        // `position` is in physical pixels relative to the webview origin;
        // `elementFromPoint` wants CSS pixels.
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
