import { toast } from "@/components/ui/toast";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "@/modules/browser/lib/proxy";
import { activeLeaf, MAX_PANES_PER_TAB, type Tab } from "@/modules/tabs";
import { hasLeaf, leafIds, leaves, type TerminalPaneHandle } from "@/modules/terminal";
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { type TabsApi } from "./tabsApi";

type Params = {
  tabs: Tab[];
  activeId: number;
  tabsRef: RefObject<Tab[]>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | "browser" | null;
  /** True when the active leaf is a connected SSH terminal. A breadcrumb `cd`
   *  then targets the remote shell only; it must NOT repoint the local
   *  workspace root at a remote path (which breaks the local explorer and
   *  persists across reloads). */
  activeLeafIsSsh: boolean;
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
  setPickedRoot: Dispatch<SetStateAction<string | null>>;
  disposeTab: (id: number) => void;
} & Pick<
  TabsApi,
  | "setActiveId"
  | "newTab"
  | "newBrowserTab"
  | "setLeafCwd"
  | "splitActivePane"
  | "moveLeafToTab"
  | "closePaneByLeaf"
>;

/**
 * A close pending the user's confirmation. Drives the close-confirmation
 * AlertDialog in `AppDialogs`.
 */
export type PendingClose = {
  /** What to dispose once the user confirms. */
  target: { kind: "tab"; tabId: number } | { kind: "leaf"; leafId: number };
  /** Why we're asking - drives the modal copy. */
  reason: "unsaved" | "running";
  /** Tab title for the prompt, when known. */
  title?: string;
};

/**
 * Tab/pane-level user actions: open / close / cd / split / move plus the
 * close-confirmation state (`pendingClose`). A close is confirmed first when
 * the tab/pane has unsaved editor changes or a terminal running a process;
 * otherwise it disposes immediately. `disposeTab` is threaded in because it
 * stays in App (the dispose-effect and `handlePathDeleted` also share it).
 */
export function useTabActions({
  tabs,
  activeId,
  tabsRef,
  terminalRefs,
  activeLeafIdInTab,
  activeLeafKindCurrent,
  activeLeafIsSsh,
  explorerRoot,
  inheritedCwdForNewTab,
  setPickedRoot,
  disposeTab,
  setActiveId,
  newTab,
  newBrowserTab,
  setLeafCwd,
  splitActivePane,
  moveLeafToTab,
  closePaneByLeaf,
}: Params): {
  pendingClose: PendingClose | null;
  handleClose: (id: number) => void;
  requestCloseLeaf: (leafId: number) => void;
  confirmClose: () => void;
  cancelClose: () => void;
  cycleTab: (delta: 1 | -1) => void;
  openNewTab: () => void;
  openNewPrivateTab: () => void;
  sendCd: (path: string) => void;
  cdInNewTab: (path: string) => void;
  openPreviewTab: (url: string, activate?: boolean) => number | null;
  splitActivePaneInActiveTab: (
    dir: "row" | "col",
    kind?: "terminal" | "editor" | "browser",
  ) => void;
  moveLeafToGroup: (leafId: number, targetTabId: number) => void;
  handleCloseTabOrPane: () => void;
} {
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  // A terminal leaf is "busy" only when a foreground command is genuinely
  // running - a full-screen TUI on the alt-screen, or an in-flight OSC 133
  // command (with Enter-synthesis for pwsh). This is prompt-text independent,
  // so an idle terminal (even with a custom oh-my-posh/starship prompt) never
  // triggers the confirmation. Non-terminal leaves have no handle in
  // terminalRefs, so they never read busy.
  const leafHasRunningProcess = useCallback((leafId: number): boolean => {
    const term = terminalRefs.current.get(leafId);
    return term ? term.isProcessRunning() : false;
  }, []);

  // True when any terminal pane in the tab is running a process.
  const tabHasRunningProcess = useCallback(
    (tab: Tab): boolean => {
      if (tab.kind !== "pane") return false;
      return leaves(tab.paneTree).some(
        (l) => l.leafKind === "terminal" && leafHasRunningProcess(l.id),
      );
    },
    [leafHasRunningProcess],
  );

  // Whole-tab close. Confirms first on unsaved editor changes or a running
  // terminal process; otherwise disposes immediately.
  const handleClose = useCallback(
    (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "pane" && t.dirty) {
        setPendingClose({ target: { kind: "tab", tabId: id }, reason: "unsaved", title: t.title });
        return;
      }
      if (t?.kind === "pane" && tabHasRunningProcess(t)) {
        setPendingClose({ target: { kind: "tab", tabId: id }, reason: "running", title: t.title });
        return;
      }
      disposeTab(id);
    },
    [tabs, disposeTab, tabHasRunningProcess],
  );

  // Single-pane close (tab-strip leaf X, pane-header X, Ctrl+W on a split).
  // Confirms when the pane is a terminal running a process; otherwise drops the
  // pane immediately. Editor/browser leaves always close without a prompt.
  const requestCloseLeaf = useCallback(
    (leafId: number) => {
      if (leafHasRunningProcess(leafId)) {
        const tab = tabsRef.current.find((x) => x.kind === "pane" && hasLeaf(x.paneTree, leafId));
        setPendingClose({
          target: { kind: "leaf", leafId },
          reason: "running",
          title: tab?.kind === "pane" ? tab.title : undefined,
        });
        return;
      }
      closePaneByLeaf(leafId);
    },
    [leafHasRunningProcess, closePaneByLeaf],
  );

  const confirmClose = useCallback(() => {
    if (!pendingClose) return;
    const { target } = pendingClose;
    if (target.kind === "tab") disposeTab(target.tabId);
    else closePaneByLeaf(target.leafId);
    setPendingClose(null);
  }, [pendingClose, disposeTab, closePaneByLeaf]);

  const cancelClose = useCallback(() => {
    setPendingClose(null);
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
      // Under SSH the breadcrumb path is REMOTE: pointing the local workspace
      // root at it makes the local explorer read a non-existent local path
      // ("the system cannot find the path") and persists that across reloads.
      // Skip the local-root mutation entirely; only the remote `cd` below runs.
      if (!activeLeafIsSsh) {
        setPickedRoot(normalized);
        try {
          localStorage.setItem("tedi.workspaceRoot", normalized);
        } catch {
          // Storage unavailable. Skip persistence.
        }
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
    [activeLeafIdInTab, activeLeafKindCurrent, activeLeafIsSsh, setLeafCwd, setPickedRoot],
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
    (url: string, activate = true): number | null => {
      if (url && isSelfReferenceUrl(url)) {
        toast(SELF_REFERENCE_NOTICE, { variant: "warning" });
        return null;
      }
      return newBrowserTab(url, activate);
    },
    [newBrowserTab],
  );

  /**
   * Ctrl+D / Ctrl+Shift+D: splits the active pane in the active tab.
   * "row" puts the new pane to the right, "col" puts it below. The new
   * leaf becomes active. Capped at `MAX_PANES_PER_TAB`.
   */
  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col", kind?: "terminal" | "editor" | "browser") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return;
      // Terminal/editor splits inherit the explorer root; a browser split
      // starts blank (no cwd) so its address bar shows.
      const cwd = kind === "browser" ? undefined : (explorerRoot ?? undefined);
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
    // the whole tab. Both routes confirm first when a terminal is busy.
    if (t?.kind === "pane" && leafIds(t.paneTree).length > 1) {
      requestCloseLeaf(t.activeLeafId);
      return;
    }
    handleClose(activeId);
  }, [activeId, requestCloseLeaf, handleClose]);

  return {
    pendingClose,
    handleClose,
    requestCloseLeaf,
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
