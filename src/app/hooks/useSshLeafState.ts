import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/components/ui/toast";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { registerBridge } from "@/modules/automation/bridge";
import { resolveSshContext, type SshContext } from "./sshContext";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import { foldSshBinding, type SshConnectionBinding, type SshStatus } from "@/modules/ssh/status";
import {
  toolDisplayName,
  type AiCliKind,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import { playBlockingBeep, playCompletionBeep } from "@/lib/blockingBeep";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** The agent's own logo for its toast, so "which of my six agents wants me?" is
 *  answered by the glyph rather than by reading the sentence. `createElement`
 *  because this is a .ts hook file, not JSX. */
const agentMark = (tool: AiCliKind) => createElement(CliAgentIcon, { agentId: tool, size: 14 });

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
  activeSshContext: SshContext;
  sshBindingByConnection: Map<string, SshConnectionBinding>;
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

  /**
   * Live session per SAVED CONNECTION, collapsed from the terminal leaves that
   * use one. This is the rebinding table for remote editor leaves: they persist
   * a connection id (the only handle that survives a restart) and read their
   * session from here, so a reconnect - which mints a fresh session id - is
   * picked up without the leaf ever holding a number that can go stale.
   *
   * First connected leaf in tab order wins, so two terminals on the same host
   * resolve deterministically instead of flapping. A leaf that is not connected
   * yet counts as `connecting` unless it has actually failed, which keeps a
   * restored remote file from flashing "not connected" during startup, before
   * its terminal has even emitted a status. Ad-hoc connections have no profile
   * and never appear here.
   */
  const sshBindingByConnection = useMemo(() => {
    const m = new Map<string, SshConnectionBinding>();
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal" || !l.sshConnectionId) continue;
        m.set(l.sshConnectionId, foldSshBinding(m.get(l.sshConnectionId), sshStatuses.get(l.id)));
      }
    }
    return m;
  }, [tabs, sshStatuses]);

  /**
   * Run a command on the host behind an SSH pane and return its exact output.
   *
   * The remote counterpart to `bash_run`: a channel of its own, so nothing is
   * typed into the pane and nothing is read back off the screen. Output that
   * matters as DATA has to arrive this way, because the scrollback is a fixed
   * ring of rendered rows and anything longer than it loses its beginning
   * silently.
   *
   * REGISTERED HERE because this hook owns `sshStatuses`, the only table mapping
   * a LEAF to a live session id. Tools address a pane by leafId; `ssh_exec`
   * needs the session number.
   *
   * Answers a SENTENCE on failure rather than throwing, matching every other
   * capability on the bridge: a transport reads a bare null as "this build has
   * no such capability", which is a different answer from "that pane is not
   * connected".
   */
  useEffect(() => {
    registerBridge({
      sshExec: async (leafId: number, command: string) => {
        const st = sshStatuses.get(Number(leafId));
        if (!st || st.kind !== "connected") {
          return `Leaf ${leafId} is not a connected SSH pane.`;
        }
        try {
          return await invoke<string>("ssh_exec", {
            id: st.sessionId,
            command: String(command),
          });
        } catch (e) {
          // A non-zero exit arrives here carrying the remote's stderr, which is
          // the useful half - pass it through rather than a generic failure.
          return e instanceof Error ? e.message : String(e);
        }
      },
    });
  }, [sshStatuses]);

  const handleSshStatus = useCallback((leafId: number, status: SshStatus) => {
    setSshStatuses((prev) => {
      if (prev.get(leafId) === status) return prev;
      const next = new Map(prev);
      next.set(leafId, status);
      return next;
    });
  }, []);

  /**
   * The pane tab whose focus decides which repository Source Control targets.
   *
   * `activePaneTab` is null for every tab that has no leaves - Settings, a git
   * or AI diff, and the Source Control tab itself. Reading it directly meant
   * opening any of those dropped `fromActiveLeaf` to false, which silently
   * retargeted Source Control from the remote repository the user was working
   * in back to the LOCAL one: the SSH file tree kept showing the remote while
   * the panel beside it listed local changes, and a stage or discard aimed at
   * the remote would have hit local files. Opening a diff is not "switching to
   * a local pane", so hold the last real pane tab across it.
   *
   * Held by ID and re-looked-up rather than kept as an object, so a closed tab
   * resolves to null instead of leaving a stale leaf behind.
   */
  const lastPaneTabIdRef = useRef<number | null>(null);
  if (activePaneTab) lastPaneTabIdRef.current = activePaneTab.id;
  const focusPaneTab = useMemo(() => {
    if (activePaneTab) return activePaneTab;
    const id = lastPaneTabIdRef.current;
    if (id === null) return null;
    const t = tabs.find((x) => x.id === id);
    return t && t.kind === "pane" ? t : null;
  }, [activePaneTab, tabs]);

  // SFTP panel view: prefer the focused leaf if it's a connected SSH leaf,
  // else any connected SSH leaf so the panel stays useful while the user
  // is in a local editor. Derived from tracked state, no extra IPC.
  const activeSshContext = useMemo(
    () =>
      resolveSshContext({
        sshStatuses,
        focusPaneTab,
        tabs,
        sshBindingByConnection,
        lastSessionId: lastSessionIdRef.current,
      }),
    [sshStatuses, focusPaneTab, tabs, sshBindingByConnection],
  );

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
              icon: agentMark(status.tool),
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
          status.state === "done" &&
          before?.state === "working" &&
          status.tool === before.tool &&
          Date.now() - before.since >= 1500
        ) {
          // AI finished a turn (working -> done). Skip when working lasted
          // under 1.5s to avoid spam from brief spinner flickers.
          try {
            toast(`${toolDisplayName(status.tool)} finished`, {
              variant: "success",
              durationMs: 4000,
              icon: agentMark(status.tool),
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
    sshBindingByConnection,
    hasAnySshLeaf,
  };
}
