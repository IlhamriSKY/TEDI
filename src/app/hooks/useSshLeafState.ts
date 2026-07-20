import { toast } from "@/components/ui/toast";
import { dirname } from "@/lib/path";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { activeLeaf, type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import type { SshStatus } from "@/modules/ssh/status";
import { toolDisplayName, type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { playBlockingBeep, playCompletionBeep } from "@/lib/blockingBeep";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

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
    fromActiveLeaf: boolean;
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
  // Last session `activeSshContext` resolved to, so the no-active-SSH-leaf
  // fallback below can stay on it instead of flipping to whichever session
  // happens to come first in tab order.
  const lastSessionIdRef = useRef<number | null>(null);

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
    /** True only when the FOCUSED leaf is this SSH session, i.e. not the
     *  "any backgrounded session" fallback. Source Control keys off this: the
     *  file tree is happy to keep showing a background remote, but silently
     *  swapping the user's local repo for a remote one is not acceptable. */
    fromActiveLeaf: boolean;
  }>(() => {
    type Ctx = {
      sessionId: number | null;
      hostLabel: string | null;
      cwd: string | null;
      fromActiveLeaf: boolean;
    };
    const none: Ctx = { sessionId: null, hostLabel: null, cwd: null, fromActiveLeaf: false };
    if (sshStatuses.size === 0) return none;
    const lookupLeafSession = (leafId: number): number | null => {
      const status = sshStatuses.get(leafId);
      if (status && status.kind === "connected") return status.sessionId;
      return null;
    };
    const hostLabelForTab = (tab: Tab | undefined): string | null =>
      tab && tab.kind === "pane" ? tab.title : null;
    /** Is this russh session still connected on some leaf? Keyed by session id
     *  rather than leaf id, for consumers that hold one without its leaf. */
    const sessionIsLive = (sid: number): boolean => {
      for (const st of sshStatuses.values()) {
        if (st.kind === "connected" && st.sessionId === sid) return true;
      }
      return false;
    };

    // Active leaf if connected. A live SSH session is keyed in `sshStatuses` by
    // leaf id; that connected status (not a saved `sshConnectionId`, which an
    // ad-hoc connection lacks) is what makes a leaf drive the panel.
    if (activePaneTab) {
      const leaf = activeLeaf(activePaneTab);
      if (leaf && leaf.leafKind === "terminal") {
        const sid = lookupLeafSession(leaf.id);
        if (sid !== null) {
          return {
            sessionId: sid,
            hostLabel: hostLabelForTab(activePaneTab),
            cwd: leaf.cwd ?? null,
            fromActiveLeaf: true,
          };
        }
      } else if (
        leaf &&
        leaf.leafKind === "editor" &&
        leaf.sshSessionId !== undefined &&
        // The leaf's sshSessionId is frozen at open time and nothing rewrites it
        // on disconnect, so a remote file left open after Disconnect would keep
        // pointing Source Control at a dead session (a permanent error banner).
        sessionIsLive(leaf.sshSessionId)
      ) {
        // A remote file open in the editor counts as "focused on that remote":
        // opening one from the SSH tree used to hand Source Control straight
        // back to the LOCAL repo, which is the opposite of what the user is
        // looking at. Keyed on the leaf's own sshSessionId, so a LOCAL file
        // still correctly returns to the local repo.
        //
        // Its directory is a better repo anchor than the shell's $PWD, too:
        // the terminal usually still sits in $HOME, which is not a repo.
        return {
          sessionId: leaf.sshSessionId,
          hostLabel: leaf.sshHostLabel ?? hostLabelForTab(activePaneTab),
          cwd: dirname(leaf.path),
          fromActiveLeaf: true,
        };
      }
    }
    // Else any connected SSH leaf. Walks all pane tabs so a backgrounded
    // SSH session still drives the panel when the user is in a local tab.
    // Prefer the session we already served: with two or more SSH sessions,
    // returning the first in tab order made the remote panel jump to a
    // different host the moment the user clicked a local tab, which resets the
    // file tree's navigation and expansion state. Stickiness applies only on
    // this fallback path - a focused, connected SSH leaf still wins above.
    let first: Ctx | null = null;
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal") continue;
        const sid = lookupLeafSession(l.id);
        if (sid === null) continue;
        const cand = {
          sessionId: sid,
          hostLabel: hostLabelForTab(t),
          cwd: l.cwd ?? null,
          fromActiveLeaf: false,
        };
        if (sid === lastSessionIdRef.current) return cand;
        first ??= cand;
      }
    }
    return first ?? none;
  }, [sshStatuses, activePaneTab, tabs]);

  // Written in an effect so the memo above stays pure. It only needs the value
  // as of the next recompute, so the ref intentionally isn't a memo dep.
  useEffect(() => {
    lastSessionIdRef.current = activeSshContext.sessionId;
  }, [activeSshContext.sessionId]);

  // Render the SFTP panel only after the session opens any SSH leaf. The
  // SshFileExplorer + sftp.ts chunk then loads once.
  const hasAnySshLeaf = useMemo(() => {
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        // A saved SSH profile (sshConnectionId) OR a live session keyed in
        // sshStatuses both mark an SSH terminal, so an ad-hoc connection (no
        // saved profile) still surfaces the remote file tree section.
        if (l.leafKind === "terminal" && (l.sshConnectionId || sshStatuses.has(l.id))) {
          return true;
        }
      }
    }
    return false;
  }, [tabs, sshStatuses]);

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
            // Only beep on a genuine transition the user is present for. `before`
            // is null on a leaf's FIRST observed status, e.g. when you connect to
            // (or a remote mirror attaches to) a session that's already blocking;
            // beeping then is heard as an unwanted "connection sound". The toast
            // still shows.
            if (before) playBlockingBeep();
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
