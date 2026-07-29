import { toForwardSlash } from "@/lib/path";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef } from "react";

/** Mirrors Rust `cli::CliTarget`. Same shape `cli_initial_target` returns. */
type CliTarget = { kind: "folder"; path: string } | { kind: "file"; path: string; parent: string };

/** Marks the header's tab-strip row (see Header.tsx). */
const TAB_STRIP = "[data-tab-strip]";

type Handlers = {
  /**
   * `useFileActions`' `handleOpenFile`, NOT `openFileTab` directly: it owns the
   * which-surface decision (a PDF opens in a browser pane, everything else in
   * an editor tab), and routing drops around it would make a dropped file
   * behave differently from the same file clicked in the explorer.
   */
  openFile: (path: string, pin?: boolean) => void;
  /** Open a terminal tab rooted at `cwd`. Used when the dropped path is a folder. */
  newTerminalTab: (cwd: string) => void;
};

/**
 * OS-level file drop → open the dropped path, VSCode-style.
 *
 * Tauri captures native drags globally and emits one `onDragDropEvent`; there's
 * a listener per surface (terminal, AI composer, this one). They stay mutually
 * exclusive by hit-testing the drop point:
 *   - over a terminal leaf → `useTerminalFileDrop` types the shell-quoted path.
 *   - over the AI composer → `useComposerFileDrop` attaches it.
 *   - over any other pane leaf (an editor), or over the tab strip → opened here,
 *     even when the file lives outside the current workspace root (`openFile`
 *     takes any absolute path).
 *
 * `data-pane-leaf` marks every leaf container (PaneTreeView); terminal leaves
 * additionally carry `data-terminal-leaf-id` on an inner element, so a drop over
 * a terminal body is skipped here and left to the terminal listener.
 *
 * Folder-vs-file is decided by `cli_classify_path` (a real fs stat), not by the
 * file name: a folder opens a terminal tab rooted there, a file goes to
 * `openFile`, and a path that is neither is ignored. Guessing from the
 * extension would open an editor onto a directory, which then fails to load.
 * Which surface a FILE lands in is `openFile`'s call, not this hook's.
 */
export function useEditorFileDrop({ openFile, newTerminalTab }: Handlers): void {
  const ref = useRef({ openFile, newTerminalTab });
  ref.current = { openFile, newTerminalTab };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // `position` is physical pixels; `elementFromPoint` wants CSS pixels.
    const elementAt = (position: { x: number; y: number }): Element | null => {
      const dpr = window.devicePixelRatio || 1;
      return document.elementFromPoint(position.x / dpr, position.y / dpr);
    };

    // Toggle the tab strip's drop affordance. Written straight to the DOM
    // rather than through React state: `over` fires continuously for the whole
    // duration of a drag, and the Header is memoised precisely so it does not
    // re-render on unrelated churn.
    const markStrip = (active: boolean): void => {
      const strip = document.querySelector<HTMLElement>(TAB_STRIP);
      if (!strip) return;
      if (active) strip.setAttribute("data-drop-active", "true");
      else strip.removeAttribute("data-drop-active");
    };

    const open = async (path: string): Promise<void> => {
      let target: CliTarget | null;
      try {
        target = await invoke<CliTarget | null>("cli_classify_path", { path });
      } catch (err) {
        // Caught per path, not around the loop: one unreadable entry in a
        // multi-file drop must not swallow the rest.
        console.error("classify dropped path failed:", path, err);
        return;
      }
      if (!target) return;
      if (target.kind === "folder") ref.current.newTerminalTab(target.path);
      // Pinned: a drop is a deliberate "keep this open", so it must not land in
      // the shared preview slot where the next preview would evict it.
      else ref.current.openFile(target.path, true);
    };

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          markStrip(false);
          return;
        }
        // `enter` as well as `over` so the strip lights up on the first frame
        // the drag crosses the window edge, not one `over` tick later.
        if (payload.type === "enter" || payload.type === "over") {
          markStrip(!!elementAt(payload.position)?.closest(TAB_STRIP));
          return;
        }
        if (payload.type !== "drop") return;
        markStrip(false);
        const { position, paths } = payload;
        if (!paths || paths.length === 0) return;
        const under = elementAt(position);
        if (!under) return;
        // Terminal body handles its own drop (pastes the path). Leave it alone.
        if (under.closest("[data-terminal-leaf-id]")) return;
        // Only the tab strip and pane leaves open a drop. The composer,
        // sidebar, status bar, etc. are left to their own handlers.
        if (!under.closest(TAB_STRIP) && !under.closest("[data-pane-leaf]")) return;
        // Sequential so a multi-file drop opens tabs in the order they were
        // dropped; `cli_classify_path` is one round-trip per path and they
        // would otherwise resolve out of order.
        void (async () => {
          for (const p of paths) await open(toForwardSlash(p));
        })();
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err) => console.error("editor drag-drop listen failed:", err));

    return () => {
      cancelled = true;
      markStrip(false);
      unlisten?.();
    };
  }, []);
}
