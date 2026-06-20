import { setAppContext } from "@/modules/extensions/appBridge";
import type { AppContextSnapshot } from "@/modules/extensions/host";
import { activeLeaf, type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import type { SshStatus } from "@/modules/ssh/status";
import { countSavedTerminalLeaves, useWorkspacesStore } from "@/modules/workspaces";
import { useEffect, useMemo } from "react";

type Workspace = ReturnType<typeof useWorkspacesStore.getState>["workspaces"][number];

type Params = {
  activePaneTab: Tab | null;
  activeTab: Tab | undefined;
  tabs: Tab[];
  wsList: Workspace[];
  wsActiveId: string | null;
  explorerRoot: string | null;
  /** Live SSH status per leaf (kind/sessionId). Lets us publish SSH tab numbers
   *  keyed by the runtime SSH session id so a mirror labels SSH tabs correctly. */
  sshStatuses: Map<number, SshStatus>;
};

/**
 * Snapshot of "what the user is doing now", pushed to extensions via
 * `setAppContext`. Extensions subscribe via `tedi.app.onContextChange`. Core
 * code stays free of integration-specific hooks. All four memos feed only the
 * `setAppContext` effect, so this hook returns nothing.
 */
export function useAppContextBridge({
  activePaneTab,
  activeTab,
  tabs,
  wsList,
  wsActiveId,
  explorerRoot,
  sshStatuses,
}: Params): void {
  // Snapshot of "what the user is doing now", pushed to extensions via
  // `setAppContext`. Extensions subscribe via `tedi.app.onContextChange`.
  // Core code stays free of integration-specific hooks.
  const activeFileName = useMemo(() => {
    if (!activePaneTab) return null;
    const leaf = activeLeaf(activePaneTab);
    if (!leaf || leaf.leafKind !== "editor") return null;
    const parts = leaf.path.split(/[\\/]/);
    return parts[parts.length - 1] || null;
  }, [activePaneTab]);
  const terminalCount = useMemo(() => {
    let n = 0;
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal") n += 1;
      }
    }
    return n;
  }, [tabs]);
  // Total terminals across every workspace. Active workspace contributes
  // its live tab tree (so newly opened terminals count immediately); other
  // workspaces use their last-saved tabs from the workspace store.
  const terminalCountAll = useMemo(() => {
    let n = terminalCount;
    for (const w of wsList) {
      if (w.id === wsActiveId) continue;
      for (const t of w.tabs) {
        if (t.kind !== "pane") continue;
        n += countSavedTerminalLeaves(t.paneTree);
      }
    }
    return n;
  }, [terminalCount, wsList, wsActiveId]);
  // Map of daemon ptyId -> the tab's FIFO number (terminalOrdinal) for the
  // active workspace's live terminals. Lets a mirror label tabs with the same
  // number the desktop shows. Only terminals already bound to a daemon session
  // (ptyId set) are included.
  const terminals = useMemo<AppContextSnapshot["terminals"]>(() => {
    const out: AppContextSnapshot["terminals"] = [];
    const seen = new Set<string>();
    const add = (key: string, ordinal: number) => {
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ptyId: key, ordinal });
    };
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal" || typeof l.terminalOrdinal !== "number") continue;
        if (l.ptyId) {
          // Local terminal: key by daemon ptyId (the mirror's session id).
          add(l.ptyId, l.terminalOrdinal);
        } else {
          // SSH leaf has no daemon ptyId. Key by its live SSH session id as
          // `ssh:<id>` - the exact id the browser mirror uses for SSH tabs - so
          // the web labels SSH tabs with the same number the desktop shows.
          const st = sshStatuses.get(l.id);
          if (st && st.kind === "connected") add(`ssh:${st.sessionId}`, l.terminalOrdinal);
        }
      }
    }
    return out;
  }, [tabs, sshStatuses]);
  const workspaceCount = wsList.length;
  const activeTabKind = useMemo<AppContextSnapshot["activeTabKind"]>(() => {
    if (!activeTab) return null;
    if (activeTab.kind === "ai-diff" || activeTab.kind === "git-diff") return "diff";
    if (activeTab.kind === "ext") return "ext";
    if (activeTab.kind === "pane") {
      const leaf = activeLeaf(activeTab);
      if (!leaf) return null;
      if (leaf.leafKind === "editor") return "editor";
      if (leaf.leafKind === "browser") return "browser";
      // SSH leaves are marked by `sshConnectionId` at create time. The kind
      // only reflects how the leaf was opened, not its current status.
      if (leaf.leafKind === "terminal") {
        return leaf.sshConnectionId ? "ssh" : "terminal";
      }
    }
    return null;
  }, [activeTab]);
  useEffect(() => {
    setAppContext({
      workspaceCwd: explorerRoot,
      activeFileName,
      terminalCount,
      activeTabKind,
      workspaceCount,
      terminalCountAll,
      terminals,
    });
  }, [
    explorerRoot,
    activeFileName,
    terminalCount,
    activeTabKind,
    workspaceCount,
    terminalCountAll,
    terminals,
  ]);
}
