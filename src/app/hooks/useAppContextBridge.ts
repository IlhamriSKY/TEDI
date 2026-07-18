import { setAppContext } from "@/modules/extensions/appBridge";
import type { AppContextSnapshot } from "@/modules/extensions/host";
import { activeLeaf, type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
import type { SshStatus } from "@/modules/ssh/status";
import { countSavedTerminalLeaves, useWorkspacesStore } from "@/modules/workspaces";
import { basename } from "@/lib/path";
import { useEffect, useMemo, type RefObject } from "react";

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
  /** Cached live Tab[] per NON-active workspace (leaf ids intact, PTYs still
   *  attached). Lets us publish terminals for every visited workspace, not just
   *  the active one, so a mirror can group tabs by workspace. */
  liveTabsByWorkspace: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
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
  liveTabsByWorkspace,
}: Params): void {
  // Snapshot of "what the user is doing now", pushed to extensions via
  // `setAppContext`. Extensions subscribe via `tedi.app.onContextChange`.
  // Core code stays free of integration-specific hooks.
  const activeFileName = useMemo(() => {
    if (!activePaneTab) return null;
    const leaf = activeLeaf(activePaneTab);
    if (!leaf || leaf.leafKind !== "editor") return null;
    return basename(leaf.path) || null;
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
  // Live per-leaf AI-CLI status (idle/working/blocking), so the tabmeta a mirror
  // receives carries the SAME working indicator the desktop shows, on every tab.
  const aiStatuses = useAiCliStatuses((s) => s.statuses);
  // Host-captured, glyph-stripped OSC 0/2 window title per leaf. Carried over the
  // bridge so a mirror shows the SAME title the desktop does instead of a stale /
  // blank second capture off the mirrored byte stream.
  const titles = useTerminalTitles((s) => s.titles);
  // Per-terminal metadata (daemon ptyId -> FIFO number + AI-CLI state + owning
  // workspace) for EVERY live workspace, so a mirror labels tabs with the same
  // number the desktop shows AND groups them into the same workspaces. The
  // active workspace uses the live `tabs`; other visited workspaces use their
  // cached live tabs (their PTYs stay attached across a switch, so they're still
  // mirrored). Only terminals bound to a daemon session (ptyId) or a connected
  // SSH session are included; the first occurrence of an id wins (dedup).
  const terminals = useMemo<AppContextSnapshot["terminals"]>(() => {
    const out: AppContextSnapshot["terminals"] = [];
    const seen = new Set<string>();
    const walk = (wsTabs: Tab[], wsId: string, wsName: string, wsActive: boolean) => {
      for (const t of wsTabs) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind !== "terminal" || typeof l.terminalOrdinal !== "number") continue;
          let key: string | null = null;
          if (l.ptyId) {
            // Local terminal: key by daemon ptyId (the mirror's session id).
            key = l.ptyId;
          } else {
            // SSH leaf has no daemon ptyId. Key by its live SSH session id as
            // `ssh:<id>` - the exact id the browser mirror uses for SSH tabs.
            const st = sshStatuses.get(l.id);
            if (st && st.kind === "connected") key = `ssh:${st.sessionId}`;
          }
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push({
            ptyId: key,
            ordinal: l.terminalOrdinal,
            state: aiStatuses[l.id]?.state,
            title: titles[l.id],
            wsId,
            wsName,
            wsActive,
          });
        }
      }
    };
    for (const w of wsList) {
      const isActive = w.id === wsActiveId;
      const wsTabs = isActive ? tabs : (liveTabsByWorkspace.current?.get(w.id)?.tabs ?? []);
      walk(wsTabs, w.id, w.name, isActive);
    }
    return out;
  }, [tabs, sshStatuses, aiStatuses, titles, wsList, wsActiveId, liveTabsByWorkspace]);
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
