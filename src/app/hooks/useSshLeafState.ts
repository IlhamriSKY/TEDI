import { toast } from "@/components/ui/toast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { activeLeaf, type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import type { SshStatus } from "@/modules/ssh/status";
import { toolDisplayName, type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { playBlockingBeep, playCompletionBeep } from "@/lib/blockingBeep";
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

type Params = {
  activePaneTab: Tab | null;
  tabs: Tab[];
};

/**
 * Per-leaf SSH status + per-leaf AI CLI status state and their derived
 * memos. `sshStatuses` drives the TabBar dot and StatusBar pill;
 * `aiCliStatuses` drives the tab dot and the toast/beep on transition to
 * "blocking". Both maps are pruned by the dispose effect in App, which reads
 * the setters returned here.
 */
export function useSshLeafState({ activePaneTab, tabs }: Params): {
  sshStatuses: Map<number, SshStatus>;
  setSshStatuses: Dispatch<SetStateAction<Map<number, SshStatus>>>;
  aiCliStatuses: Map<number, AiCliStatus>;
  setAiCliStatuses: Dispatch<SetStateAction<Map<number, AiCliStatus>>>;
  handleSshStatus: (leafId: number, status: SshStatus) => void;
  handleAiCliStatus: (leafId: number, status: AiCliStatus) => void;
  activeSshContext: {
    sessionId: number | null;
    hostLabel: string | null;
    cwd: string | null;
  };
  hasAnySshLeaf: boolean;
} {
  // Per-leaf SSH status. React state so TabBar dot and StatusBar pill
  // rerender on transitions. Keyed by leafId; pruned with dead terminal
  // handles below.
  const [sshStatuses, setSshStatuses] = useState<Map<number, SshStatus>>(() => new Map());
  // Per-leaf AI CLI status (claude, codex, opencode, copilot, pi). Drives
  // the tab dot and the toast/beep on transition to "blocking". Pruned
  // with `sshStatuses`.
  const [aiCliStatuses, setAiCliStatuses] = useState<Map<number, AiCliStatus>>(() => new Map());

  const handleSshStatus = useCallback((leafId: number, status: SshStatus) => {
    setSshStatuses((prev) => {
      if (prev.get(leafId) === status) return prev;
      const next = new Map(prev);
      next.set(leafId, status);
      return next;
    });
  }, []);

  // SFTP panel view: prefer the active leaf if it's a connected SSH leaf,
  // else any connected SSH leaf so the panel stays useful while the user
  // is in a local editor. Derived from tracked state, no extra IPC.
  const activeSshContext = useMemo<{
    sessionId: number | null;
    hostLabel: string | null;
    /** Active SSH leaf's last-known cwd from OSC 7. If set, the SSH file tree roots here instead of $HOME. */
    cwd: string | null;
  }>(() => {
    if (sshStatuses.size === 0) return { sessionId: null, hostLabel: null, cwd: null };
    const lookupLeafSession = (leafId: number): number | null => {
      const status = sshStatuses.get(leafId);
      if (status && status.kind === "connected") return status.sessionId;
      return null;
    };
    const hostLabelForTab = (tab: Tab | undefined): string | null =>
      tab && tab.kind === "pane" ? tab.title : null;

    // Active leaf if connected.
    if (activePaneTab) {
      const leaf = activeLeaf(activePaneTab);
      if (leaf && leaf.leafKind === "terminal" && leaf.sshConnectionId) {
        const sid = lookupLeafSession(leaf.id);
        if (sid !== null) {
          return {
            sessionId: sid,
            hostLabel: hostLabelForTab(activePaneTab),
            cwd: leaf.cwd ?? null,
          };
        }
      }
    }
    // Else any connected SSH leaf. Walks all pane tabs so a backgrounded
    // SSH session still drives the panel when the user is in a local tab.
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal" || !l.sshConnectionId) continue;
        const sid = lookupLeafSession(l.id);
        if (sid !== null)
          return { sessionId: sid, hostLabel: hostLabelForTab(t), cwd: l.cwd ?? null };
      }
    }
    return { sessionId: null, hostLabel: null, cwd: null };
  }, [sshStatuses, activePaneTab, tabs]);

  // Render the SFTP panel only after the session opens any SSH leaf. The
  // SshFileExplorer + sftp.ts chunk then loads once.
  const hasAnySshLeaf = useMemo(() => {
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal" && l.sshConnectionId) return true;
      }
    }
    return false;
  }, [tabs]);

  const handleAiCliStatus = useCallback((leafId: number, status: AiCliStatus) => {
    setAiCliStatuses((prev) => {
      try {
        const before = prev.get(leafId) ?? null;
        const sameTool = before?.tool === status?.tool;
        const sameState = before?.state === status?.state;
        if (sameTool && sameState) return prev;
        // Toast and beep gated by user preference. Tab badge updates either
        // way: the preference disables attention-grabbing feedback only.
        const notify = usePreferencesStore.getState().aiNotificationsEnabled;
        // Toast and beep on transition into blocking.
        if (notify && status && status.state === "blocking" && before?.state !== "blocking") {
          try {
            toast(`${toolDisplayName(status.tool)} needs your approval`, {
              variant: "warning",
              durationMs: 6000,
            });
            playBlockingBeep();
          } catch {
            // Notification failures are non-critical.
          }
        } else if (
          notify &&
          status &&
          status.state === "idle" &&
          before?.state === "working" &&
          status.tool === before.tool &&
          Date.now() - before.since >= 1500
        ) {
          // AI returned to idle after working. Skip when working lasted
          // under 1.5s to avoid spam from brief spinner flickers.
          try {
            toast(`${toolDisplayName(status.tool)} finished`, {
              variant: "success",
              durationMs: 4000,
            });
            playCompletionBeep();
          } catch {
            // Notification failures are non-critical.
          }
        }
        const next = new Map(prev);
        if (status) next.set(leafId, status);
        else next.delete(leafId);
        return next;
      } catch {
        return prev;
      }
    });
  }, []);

  return {
    sshStatuses,
    setSshStatuses,
    aiCliStatuses,
    setAiCliStatuses,
    handleSshStatus,
    handleAiCliStatus,
    activeSshContext,
    hasAnySshLeaf,
  };
}
