import { toast } from "@/components/ui/toast";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "@/modules/preview/lib/proxy";
import { activeLeaf, MAX_PANES_PER_TAB, type Tab } from "@/modules/tabs";
import { leafIds, type TerminalPaneHandle } from "@/modules/terminal";
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { type TabsApi } from "./tabsApi";

type Params = {
  tabs: Tab[];
  activeId: number;
  tabsRef: RefObject<Tab[]>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | "preview" | null;
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
  setPickedRoot: Dispatch<SetStateAction<string | null>>;
  disposeTab: (id: number) => void;
} & Pick<
  TabsApi,
  | "setActiveId"
  | "newTab"
  | "newPreviewTab"
  | "setLeafCwd"
  | "splitActivePane"
  | "moveLeafToTab"
  | "closeActivePane"
>;

/**
 * Tab/pane-level user actions: open / close / cd / split / move plus the
 * close-confirmation state (`pendingCloseTab`). Moved verbatim from App with
 * identical dependency arrays. `disposeTab` is threaded in because it stays in
 * App (the dispose-effect and `handlePathDeleted` also share it).
 */
export function useTabActions({
  tabs,
  activeId,
  tabsRef,
  terminalRefs,
  activeLeafIdInTab,
  activeLeafKindCurrent,
  explorerRoot,
  inheritedCwdForNewTab,
  setPickedRoot,
  disposeTab,
  setActiveId,
  newTab,
  newPreviewTab,
  setLeafCwd,
  splitActivePane,
  moveLeafToTab,
  closeActivePane,
}: Params): {
  pendingCloseTab: number | null;
  handleClose: (id: number) => void;
  confirmClose: () => void;
  cancelClose: () => void;
  cycleTab: (delta: 1 | -1) => void;
  openNewTab: () => void;
  openNewPrivateTab: () => void;
  sendCd: (path: string) => void;
  cdInNewTab: (path: string) => void;
  openPreviewTab: (url: string) => number | null;
  splitActivePaneInActiveTab: (
    dir: "row" | "col",
    kind?: "terminal" | "editor" | "preview",
  ) => void;
  moveLeafToGroup: (leafId: number, targetTabId: number) => void;
  handleCloseTabOrPane: () => void;
} {
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);

  const handleClose = useCallback(
    (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "pane" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIdx].id);
    },
    [tabs, activeId, setActiveId],
  );

  const openNewTab = useCallback(() => {
    // Ctrl+T opens the new shell in the explorer's root so the tab matches
    // the folder being browsed.
    newTab(explorerRoot ?? inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab, explorerRoot]);

  /** Same as `openNewTab` but flags the new tab private so the AI cannot
   *  see its scrollback, cwd, or even existence in `<env>`. */
  const openNewPrivateTab = useCallback(() => {
    newTab(explorerRoot ?? inheritedCwdForNewTab(), { private: true });
  }, [newTab, inheritedCwdForNewTab, explorerRoot]);

  const sendCd = useCallback(
    (path: string) => {
      // Breadcrumb click = open this folder. Updates the workspace root so
      // the explorer, AI workspace context, and inherited cwd follow.
      // Persisted across reloads.
      const normalized = path.replace(/\\/g, "/");
      setPickedRoot(normalized);
      try {
        localStorage.setItem("tedi.workspaceRoot", normalized);
      } catch {
        // Storage unavailable. Skip persistence.
      }
      // If the active leaf is a terminal, cd it too so the shell tracks
      // the new workspace - but ONLY while it's sitting idle at a prompt.
      // Writing `cd "…"` into a busy shell (a command running, output
      // streaming, or a TUI owning the alt-screen) lands the keystrokes in
      // that program's stdin instead of changing directory, garbling
      // whatever is in flight. When busy we skip the shell write entirely;
      // the explorer / AI workspace context above still follow the click,
      // and the next breadcrumb click once the command finishes cds for
      // real. Mirrors the `run_in_terminal` isAtPrompt() guard so the AI and
      // the breadcrumb refuse to disrupt a working terminal the same way.
      // Double quotes work across pwsh/bash/zsh/cmd for paths without shell
      // metacharacters (segmentsFromCwd outputs never contain any). React
      // state updates the cwd optimistically so the breadcrumb reflects the
      // click immediately. Shells with OSC 7 reconcile after, shells without
      // it still show the target.
      if (activeLeafIdInTab !== null && activeLeafKindCurrent === "terminal") {
        const term = terminalRefs.current.get(activeLeafIdInTab);
        if (term && term.isAtPrompt()) {
          setLeafCwd(activeLeafIdInTab, normalized);
          term.write(`cd "${normalized}"\r`);
          term.focus();
        }
      }
    },
    [activeLeafIdInTab, activeLeafKindCurrent, setLeafCwd],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "pane") return;
        const leaf = activeLeaf(tab);
        if (!leaf || leaf.leafKind !== "terminal") return;
        const t = terminalRefs.current.get(leaf.id);
        if (!t) return;
        const quoted = path.includes(" ") ? `'${path.replace(/'/g, `'\\''`)}'` : path;
        t.write(`cd ${quoted}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const openPreviewTab = useCallback(
    (url: string): number | null => {
      if (url && isSelfReferenceUrl(url)) {
        toast(SELF_REFERENCE_NOTICE, { variant: "warning" });
        return null;
      }
      return newPreviewTab(url);
    },
    [newPreviewTab],
  );

  /**
   * Ctrl+D / Ctrl+Shift+D: splits the active pane in the active tab.
   * "row" puts the new pane to the right, "col" puts it below. The new
   * leaf becomes active. Capped at `MAX_PANES_PER_TAB`.
   */
  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col", kind?: "terminal" | "editor" | "preview") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return;
      // Terminal/editor splits inherit the explorer root; a browser split
      // starts blank (no cwd) so its address bar shows.
      const cwd = kind === "preview" ? undefined : (explorerRoot ?? undefined);
      splitActivePane(activeId, dir, kind, cwd);
    },
    [activeId, splitActivePane, explorerRoot],
  );

  /**
   * Moves a leaf into `targetTabId` as a horizontal split. The leaf's id
   * is preserved so its PTY / editor session survives. Resolves the
   * target title before the move so the toast can name it if the source
   * tab is dropped.
   */
  const moveLeafToGroup = useCallback(
    (leafId: number, targetTabId: number) => {
      const target = tabsRef.current.find((x) => x.id === targetTabId);
      if (!target || target.kind !== "pane") return;
      const targetTitle = target.title;
      const result = moveLeafToTab(leafId, targetTabId);
      if (result === "full") {
        toast(`Group "${targetTitle}" is full (${MAX_PANES_PER_TAB} panes max).`, {
          variant: "warning",
        });
      }
    },
    [moveLeafToTab],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    // Multi-pane tab → close just the focused pane. Single-pane tab → close
    // the whole tab.
    if (t?.kind === "pane" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  return {
    pendingCloseTab,
    handleClose,
    confirmClose,
    cancelClose,
    cycleTab,
    openNewTab,
    openNewPrivateTab,
    sendCd,
    cdInNewTab,
    openPreviewTab,
    splitActivePaneInActiveTab,
    moveLeafToGroup,
    handleCloseTabOrPane,
  };
}
