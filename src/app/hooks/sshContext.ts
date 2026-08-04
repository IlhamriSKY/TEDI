/**
 * Which SSH session the Remote file tree and Source Control act on.
 *
 * Extracted from `useSshLeafState` as a plain function so
 * `scripts/ssh-context-verify.ts` can exercise it: the `fromActiveLeaf` flag it
 * returns decides whether Source Control targets a REMOTE repository or the
 * local one, and getting that wrong is not cosmetic - a stage or a discard
 * lands on whichever repo the panel resolved to.
 */
import { dirname } from "@/lib/path";
import { activeLeaf, type Tab } from "@/modules/tabs";
// Deep import rather than the `@/modules/terminal` barrel: that barrel pulls in
// xterm, which cannot load under plain node, and this file has to stay
// runnable by scripts/ssh-context-verify.ts.
import { isRemoteEditorLeaf, leaves } from "@/modules/terminal/lib/panes";
import type { SshConnectionBinding, SshStatus } from "@/modules/ssh/status";

export type SshContext = {
  sessionId: number | null;
  hostLabel: string | null;
  /** Active SSH leaf's last-known cwd from OSC 7. If set, the SSH file tree roots here instead of $HOME. */
  cwd: string | null;
  /**
   * True when the session came from the FOCUSED pane, not from the "any
   * backgrounded session" fallback. Source Control keys off this: the file tree
   * is happy to keep showing a background remote, but silently swapping the
   * user's local repo for a remote one is not acceptable.
   *
   * `focusPaneTab` is the LAST pane tab, not necessarily the active one - see
   * the note on it in `useSshLeafState`. A tab with no leaves (Settings, a
   * diff, the Source Control tab) must not count as "switched to a local pane".
   */
  fromActiveLeaf: boolean;
};

export const NO_SSH_CONTEXT: SshContext = {
  sessionId: null,
  hostLabel: null,
  cwd: null,
  fromActiveLeaf: false,
};

export function resolveSshContext(params: {
  sshStatuses: Map<number, SshStatus>;
  /** The pane tab whose focus decides the answer. */
  focusPaneTab: Tab | null;
  tabs: Tab[];
  sshBindingByConnection: Map<string, SshConnectionBinding>;
  /** Session last served, so the fallback stays put instead of flapping. */
  lastSessionId: number | null;
}): SshContext {
  const { sshStatuses, focusPaneTab, tabs, sshBindingByConnection, lastSessionId } = params;
  if (sshStatuses.size === 0) return NO_SSH_CONTEXT;

  const lookupLeafSession = (leafId: number): number | null => {
    const status = sshStatuses.get(leafId);
    if (status && status.kind === "connected") return status.sessionId;
    return null;
  };
  const hostLabelForTab = (tab: Tab | undefined | null): string | null =>
    tab && tab.kind === "pane" ? tab.title : null;
  /** Is this russh session still connected on some leaf? Keyed by session id
   *  rather than leaf id, for consumers that hold one without its leaf. */
  const sessionIsLive = (sid: number): boolean => {
    for (const st of sshStatuses.values()) {
      if (st.kind === "connected" && st.sessionId === sid) return true;
    }
    return false;
  };

  // Focused leaf if connected. A live SSH session is keyed in `sshStatuses` by
  // leaf id; that connected status (not a saved `sshConnectionId`, which an
  // ad-hoc connection lacks) is what makes a leaf drive the panel.
  if (focusPaneTab) {
    const leaf = activeLeaf(focusPaneTab);
    if (leaf && leaf.leafKind === "terminal") {
      const sid = lookupLeafSession(leaf.id);
      if (sid !== null) {
        return {
          sessionId: sid,
          hostLabel: hostLabelForTab(focusPaneTab),
          cwd: leaf.cwd ?? null,
          fromActiveLeaf: true,
        };
      }
    } else if (leaf && leaf.leafKind === "editor" && isRemoteEditorLeaf(leaf)) {
      // Resolve the profile to whatever session is live now; an ad-hoc leaf
      // falls back to its frozen id. Either way the session must still be
      // connected: a remote file left open after Disconnect would otherwise
      // point Source Control at a dead session (a permanent error banner).
      const sid = leaf.sshConnectionId
        ? sshBindingByConnection.get(leaf.sshConnectionId)?.sessionId
        : leaf.sshSessionId;
      if (sid === undefined || !sessionIsLive(sid)) return NO_SSH_CONTEXT;
      // A remote file open in the editor counts as "focused on that remote":
      // opening one from the SSH tree used to hand Source Control straight
      // back to the LOCAL repo, which is the opposite of what the user is
      // looking at. Keyed on the leaf's own sshSessionId, so a LOCAL file
      // still correctly returns to the local repo.
      //
      // Its directory is a better repo anchor than the shell's $PWD, too:
      // the terminal usually still sits in $HOME, which is not a repo.
      return {
        sessionId: sid,
        hostLabel: leaf.sshHostLabel ?? hostLabelForTab(focusPaneTab),
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
  let first: SshContext | null = null;
  for (const t of tabs) {
    if (t.kind !== "pane") continue;
    for (const l of leaves(t.paneTree)) {
      if (l.leafKind !== "terminal") continue;
      const sid = lookupLeafSession(l.id);
      if (sid === null) continue;
      const cand: SshContext = {
        sessionId: sid,
        hostLabel: hostLabelForTab(t),
        cwd: l.cwd ?? null,
        fromActiveLeaf: false,
      };
      if (sid === lastSessionId) return cand;
      first ??= cand;
    }
  }
  return first ?? NO_SSH_CONTEXT;
}
