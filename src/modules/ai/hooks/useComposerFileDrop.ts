import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * OS-level file drop onto the AI composer.
 *
 * Tauri 2's default `dragDropEnabled: true` installs a native drag-drop target
 * on the WebView, consuming the events before the HTML engine sees them, so DOM
 * `onDrop` never fires for files dragged from outside the app. We listen to
 * Tauri's `onDragDropEvent` instead, hit-test the drop point against `zoneRef`
 * (screen-coordinate, like `useTerminalFileDrop`), and hand the absolute paths
 * to `onPaths` — the composer reads each via `attachFileByPath`, which already
 * supports both images (data URL) and text files.
 *
 * Returns whether a drag is currently hovering the zone, for a visual cue.
 */
export function useComposerFileDrop(
  zoneRef: RefObject<HTMLElement | null>,
  onPaths: (paths: string[]) => void,
): boolean {
  const [isOver, setIsOver] = useState(false);
  // Hold the latest callback in a ref so the listener effect runs once.
  const onPathsRef = useRef(onPaths);
  onPathsRef.current = onPaths;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const within = (px: number, py: number): boolean => {
      const el = zoneRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      // `position` is physical pixels; getBoundingClientRect is CSS pixels.
      const dpr = window.devicePixelRatio || 1;
      const x = px / dpr;
      const y = py / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setIsOver(within(p.position.x, p.position.y));
        } else if (p.type === "leave") {
          setIsOver(false);
        } else if (p.type === "drop") {
          const over = within(p.position.x, p.position.y);
          setIsOver(false);
          if (over && p.paths.length > 0) onPathsRef.current(p.paths);
        }
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err) => console.error("composer drag-drop listen failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [zoneRef]);

  return isOver;
}
