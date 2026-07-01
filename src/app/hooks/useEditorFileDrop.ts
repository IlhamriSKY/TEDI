import { toForwardSlash } from "@/lib/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef } from "react";

/**
 * OS-level file drop onto a pane → open the file in an editor tab, VSCode-style.
 *
 * Tauri captures native drags globally and emits one `onDragDropEvent`; there's
 * a listener per surface (terminal, AI composer, this one). They stay mutually
 * exclusive by hit-testing the drop point:
 *   - over a terminal leaf → `useTerminalFileDrop` types the shell-quoted path.
 *   - over the AI composer → `useComposerFileDrop` attaches it.
 *   - over any other pane leaf (an editor) → open each path here, even when the
 *     file lives outside the current workspace root (`openFileTab` takes any
 *     absolute path).
 *
 * `data-pane-leaf` marks every leaf container (PaneTreeView); terminal leaves
 * additionally carry `data-terminal-leaf-id` on an inner element, so a drop over
 * a terminal body is skipped here and left to the terminal listener.
 */
export function useEditorFileDrop(openFileTab: (path: string, pin?: boolean) => void): void {
  const openRef = useRef(openFileTab);
  openRef.current = openFileTab;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { position, paths } = event.payload;
        if (!paths || paths.length === 0) return;
        // `position` is physical pixels; `elementFromPoint` wants CSS pixels.
        const dpr = window.devicePixelRatio || 1;
        const under = document.elementFromPoint(position.x / dpr, position.y / dpr);
        if (!under) return;
        // Terminal body handles its own drop (pastes the path). Leave it alone.
        if (under.closest("[data-terminal-leaf-id]")) return;
        // Only open when the drop lands on a pane leaf (an editor pane). Drops on
        // the composer, sidebar, tab strip, etc. are left to their own handlers.
        if (!under.closest("[data-pane-leaf]")) return;
        // ponytail: dirs aren't filtered — dropping a folder opens an editor that
        // fails to load. Add an fs stat here if that UX ever bites.
        for (const p of paths) openRef.current(toForwardSlash(p), true);
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err) => console.error("editor drag-drop listen failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
