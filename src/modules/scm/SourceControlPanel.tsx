import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/components/ui/toast";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { basename } from "@/lib/path";
import { useSshBrowseStore } from "@/modules/ssh/sshBrowseStore";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { gitStatus, gitStatusSsh, isBranchSwitch, localOps, remoteOps, type GitOps } from "./api";
import { DIFF_BYTE_CAP, fallbackCommitMessage, generateCommitMessage } from "./commitAi";
import { GitGraphView } from "./GitGraphView";
import type { CommitAction } from "./CommitDetailPane";
import { PullRequestsView } from "./PullRequestsView";
import { HunkList } from "./components/HunkList";
import { ChangeSection } from "./components/ChangeSection";
import { CommitBox, type ScmBusy, type ScmMoreAction } from "./components/CommitBox";
import { PanelHeader } from "./components/PanelHeader";
import {
  BranchOpDialog,
  CommitRefDialog,
  PublishGithubDialog,
  StashDialog,
  TagDialog,
} from "./components/RepoDialogs";
import { friendlyGhError, ghFor } from "./gh";
import type { GitChange, GitChangeStatus, GitInProgress, GitStatus, OpenDiffInput } from "./types";
import { cn } from "@/lib/utils";
import { CircleAlert, FolderGit2, X } from "lucide-react";
import { useVisibilityPoll } from "@/lib/windowResume";

type Props = {
  rootPath: string | null;
  onPathDeleted?: (path: string) => void;
  /** Open a diff in a new tab (working-tree or per-commit). */
  onOpenDiff?: (input: OpenDiffInput) => void;
  /**
   * When set, renders a close button in the header. Used when the panel is
   * hosted in the right slot so the user can dismiss it without going to
   * settings.
   */
  onClose?: () => void;
  /**
   * When set, renders an "open in a tab" button in the header. Used by the
   * sidebar / right-slot instances to promote the panel into a full
   * Source Control tab.
   */
  onOpenInTab?: () => void;
  /**
   * History-only mode for the tab host: drops the Changes/commit UI and shows
   * just the commit history graph, with commit detail floating at the cursor.
   */
  historyOnly?: boolean;
  /** Sidebar-section reorder + collapse controls, injected by the sidebar. */
  dragHandle?: React.ReactNode;
  /** When the sidebar section is minimized to its header, the body is skipped. */
  collapsed?: boolean;
  /**
   * Set only while the FOCUSED terminal leaf is a connected SSH session. The
   * panel then acts on that remote's repo instead of the local workspace, so
   * source control follows the terminal you are actually working in.
   *
   * Deliberately keyed to the focused leaf, not "any live session": silently
   * swapping a user's local repo for a remote one while they edit locally
   * would hide their real changes.
   */
  sshSessionId?: number | null;
  /** Remote directory to resolve the repository from. Prefers the folder the
   *  Remote file tree is browsing, falling back to the SSH leaf's cwd (OSC 7);
   *  empty means the remote login directory. */
  sshCwd?: string | null;
};

const STATUS_ORDER: Record<GitChangeStatus, number> = {
  conflicted: 0,
  modified: 1,
  added: 2,
  renamed: 3,
  copied: 4,
  deleted: 5,
  untracked: 6,
  ignored: 7,
};

const AUTO_REFRESH_MS = 2500;

type GitOp =
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "discard"
  | "stage"
  | "branch"
  | "stash"
  | "tag"
  | "merge"
  | "init";

/** Human name for the operation a repository is stuck in the middle of. */
const IN_PROGRESS_LABEL: Record<GitInProgress, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

/** Map raw git stderr to actionable text. Common cases get plain-language hints; unknown errors fall through unchanged. */
function friendlyGitError(e: unknown, op: GitOp): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();

  if (lower.includes("nothing to commit")) {
    return "Nothing to commit - staged tree matches HEAD.";
  }
  if (lower.includes("author identity unknown") || lower.includes("please tell me who you are")) {
    return 'Set your git identity first:\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"';
  }
  if (
    lower.includes("rejected") &&
    (lower.includes("non-fast-forward") || lower.includes("fetch first"))
  ) {
    return "Push rejected - your branch is behind the remote. Pull or rebase first.";
  }
  if (lower.includes("could not resolve host") || lower.includes("could not resolve hostname")) {
    return "Network error - couldn't reach the remote. Check your connection.";
  }
  if (
    lower.includes("permission denied") ||
    lower.includes("authentication failed") ||
    lower.includes("could not read username")
  ) {
    return "Authentication failed - check your remote credentials / SSH key.";
  }
  if (lower.includes("no tracking information") || lower.includes("there is no tracking")) {
    return "This branch has no upstream. Push it once to publish and set one.";
  }
  if (lower.includes("not a git repository")) {
    return "Not a git repository.";
  }
  if (lower.includes("index.lock") || lower.includes("unable to create")) {
    return "Another git process is running (index.lock present). Try again in a moment.";
  }
  if (
    lower.includes("your local changes") ||
    lower.includes("would be overwritten") ||
    lower.includes("please commit your changes or stash them")
  ) {
    return "Local changes would be overwritten. Commit or discard them first.";
  }
  if (lower.includes("conflict")) {
    return "Merge conflicts - resolve the conflicted files, then stage them.";
  }
  if (op === "commit" && (lower.includes("empty") || lower.includes("aborting commit"))) {
    return "Commit aborted - message or content is empty.";
  }
  return raw || `Failed to ${op}.`;
}

/** Both sides of a rename, so a discard restores the source instead of leaving
 *  it deleted while the destination is removed. */
function discardPaths(changes: GitChange[]): string[] {
  const out = new Set<string>();
  for (const c of changes) {
    out.add(c.relative);
    if (c.oldRelative) out.add(c.oldRelative);
  }
  return [...out];
}

export function SourceControlPanel({
  rootPath,
  onPathDeleted,
  onOpenDiff,
  onClose,
  onOpenInTab,
  historyOnly = false,
  dragHandle,
  collapsed = false,
  sshSessionId = null,
  sshCwd = null,
}: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  /**
   * Which repository `status` describes, set in the same update as `status`.
   * Empty until one resolves.
   *
   * Derived from the RESOLVED root rather than read from a ref when it is
   * needed: focusing another terminal updates `sshSessionId` / `sshCwd` a full
   * render before that session's status arrives, so anything reading the live
   * value would pair the new repository's key with the old repository's branch.
   * The transport has to be in the key too - two hosts can both have
   * /home/u/app checked out - and the root rather than the browse anchor keeps
   * it stable while the user `cd`s around inside one repo.
   */
  const [statusKey, setStatusKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<GitChange[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ScmBusy>(null);
  const [tab, setTab] = useState<"changes" | "graph" | "prs">("changes");
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  // Bumped after commit/push and on manual refresh so the Graph tab refetches
  // without us wiring a direct ref into the child.
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
  const bumpGraph = useCallback(() => setGraphRefreshToken((n) => n + 1), []);

  // Remote mode: read AND write the SSH session's repo. Every operation below
  // goes through `ops`, which routes to `ssh_git` in this mode, so a remote
  // repository is never touched by the local git binary.
  const remote = sshSessionId != null;
  // Anchor on the folder the Remote tree last showed, not the shell's $PWD.
  // See sshBrowseStore for why; the session-id guard there means a root from
  // another host is never applied.
  const browseRoot = useSshBrowseStore((s) => (s.sessionId === sshSessionId ? s.root : null));
  const sshAnchor = browseRoot ?? sshCwd;
  const inFlightRef = useRef(false);
  const rootRef = useRef(rootPath);
  const sshRef = useRef<{ sessionId: number | null; cwd: string | null }>({
    sessionId: sshSessionId,
    cwd: sshAnchor,
  });
  sshRef.current = { sessionId: sshSessionId, cwd: sshAnchor };
  // What the in-flight fetch was for, so a slow response that lands after the
  // user switched repo or session is dropped. Two remotes both have a null
  // rootPath, so the session id has to be part of the key.
  const targetRef = useRef("");
  useEffect(() => {
    rootRef.current = rootPath;
  }, [rootPath]);

  // Last (repository, branch) pair seen, so an external HEAD switch toasts but
  // merely looking at a different repository does not.
  const prevBranchRef = useRef<{ key: string; branch: string } | null>(null);
  useEffect(() => {
    const next = { key: statusKey, branch: status?.branch ?? null };
    const switched = isBranchSwitch(prevBranchRef.current, next);
    prevBranchRef.current = next.branch && next.key ? { key: next.key, branch: next.branch } : null;
    // Keep the in-progress commit message. Switching branches shouldn't drop the draft.
    if (switched) toast(`Switched to branch ${next.branch}`, { variant: "info" });
  }, [statusKey, status?.branch]);

  /**
   * Which repository the panel is acting on, read live rather than from render
   * state. A write that finishes after the user opened another folder or
   * focused another SSH session must not clear that repo's draft message or
   * report its result.
   */
  const identity = useCallback(
    () =>
      sshRef.current.sessionId !== null
        ? `ssh:${sshRef.current.sessionId}`
        : `local:${rootRef.current}`,
    [],
  );

  const ops: GitOps | null = useMemo(() => {
    const root = status?.root;
    if (!root || !status?.isRepo) return null;
    return remote && sshSessionId != null ? remoteOps(sshSessionId, root) : localOps(root);
  }, [status?.root, status?.isRepo, remote, sshSessionId]);

  const openDiff = useCallback(
    (c: GitChange) => {
      // Reading a blob and rendering the diff both run local git, so a remote
      // repository has no diff tab to open yet.
      if (!status?.root || remote) return;
      onOpenDiff?.({
        path: c.path,
        relative: c.relative,
        repoPath: status.root,
        changeStatus: c.status,
      });
    },
    [status, onOpenDiff, remote],
  );

  const fetchStatus = useCallback(async (silent = false) => {
    const cur = rootRef.current;
    const { sessionId, cwd } = sshRef.current;
    const isRemote = sessionId !== null;
    if (!isRemote && !cur) {
      setStatus(null);
      setStatusKey("");
      return;
    }
    // The anchor is part of the key, not just the session: browsing to another
    // folder or focusing a different remote file changes the target while the
    // session id stays the same, and a slow reply for the old folder must not
    // overwrite the new one.
    const target = isRemote ? `ssh:${sessionId}:${cwd ?? ""}` : `local:${cur}`;
    targetRef.current = target;
    if (silent && inFlightRef.current) return;
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const s = isRemote ? await gitStatusSsh(sessionId, cwd ?? "") : await gitStatus(cur!);
      if (targetRef.current === target) {
        setStatus(s);
        setStatusKey(
          s.isRepo && s.root ? `${isRemote ? `ssh:${sessionId}` : "local"}:${s.root}` : "",
        );
        setError(null);
      }
    } catch (e) {
      if (targetRef.current === target) {
        // Show every failure. This used to swallow "no session" / "session is
        // closed" to avoid a flickering banner, but those are exactly the two
        // strings a wrong or stale session id produces, so the panel sat silent
        // instead of saying why. A genuine disconnect flips the leaf out of
        // `connected` within a tick, which clears `remote` and unmounts the
        // banner anyway.
        setError(String(e));
        setStatus(null);
        setStatusKey("");
      }
    } finally {
      inFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    bumpGraph();
    return fetchStatus(false);
  }, [fetchStatus, bumpGraph]);

  useEffect(() => {
    if (collapsed) return;
    void fetchStatus(false);
  }, [fetchStatus, rootPath, collapsed, sshSessionId]);

  // The anchor moved - a `cd` in the remote terminal, or a different folder
  // opened in the Remote tree - and that can be a different repo. Refetch
  // silently: OSC 7 fires on every prompt, so a spinner here would flash
  // constantly while the user just types.
  useEffect(() => {
    if (collapsed || sshSessionId === null) return;
    void fetchStatus(true);
  }, [fetchStatus, collapsed, sshSessionId, sshAnchor]);

  // Collapsed to its header: the change list / graph aren't rendered, so don't
  // poll git status (subprocess spawn every 2.5s) for an unseen view.
  useVisibilityPoll(
    () => void fetchStatus(true),
    AUTO_REFRESH_MS,
    (Boolean(rootPath) || Boolean(remote)) && !collapsed,
  );

  const sorted = useMemo(() => {
    if (!status) return [] as GitChange[];
    return [...status.changes].sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) return so;
      return a.relative.localeCompare(b.relative);
    });
  }, [status]);

  // Three lists, the same split VSCode shows. A partially-staged file appears
  // in two of them because git tracks its index and worktree states separately.
  const conflicts = useMemo(() => sorted.filter((c) => c.status === "conflicted"), [sorted]);
  const staged = useMemo(
    () => sorted.filter((c) => c.staged && c.status !== "conflicted"),
    [sorted],
  );
  const unstaged = useMemo(
    () => sorted.filter((c) => !c.staged && c.status !== "conflicted"),
    [sorted],
  );

  /**
   * Run one write and refresh. Captures the repo root up front so a slow
   * operation that finishes after the user switched folders doesn't clear the
   * new folder's commit message or claim its result.
   */
  const runOp = useCallback(
    async (
      op: GitOp,
      kind: ScmBusy,
      fn: (ops: GitOps) => Promise<void>,
      onDone?: () => void,
    ): Promise<boolean> => {
      if (busy !== null) return false;
      if (!ops || !status?.isRepo || !status.root) {
        toast("Not a git repository.", { variant: "warning" });
        return false;
      }
      const startId = identity();
      setBusy(kind);
      try {
        await fn(ops);
        if (identity() !== startId) return false;
        onDone?.();
        await fetchStatus(true);
        bumpGraph();
        return true;
      } catch (e) {
        if (identity() === startId) toast(friendlyGitError(e, op), { variant: "error" });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy, ops, status, identity, fetchStatus, bumpGraph],
  );

  const setStaged = useCallback(
    (changes: GitChange[], stage: boolean) => {
      const paths = discardPaths(changes);
      void runOp("stage", "stage", (o) => (stage ? o.stage(paths) : o.unstage(paths)));
    },
    [runOp],
  );

  const doDiscard = useCallback(
    (changes: GitChange[]) => {
      const gone = changes.filter((c) => c.status === "untracked" || c.status === "added");
      void runOp(
        "discard",
        "stage",
        (o) => o.discard(discardPaths(changes)),
        () => {
          for (const c of gone) onPathDeleted?.(c.path);
        },
      );
    },
    [runOp, onPathDeleted],
  );

  const doDiscardAll = useCallback(() => {
    const gone = sorted.filter((c) => c.status === "untracked" || c.status === "added");
    void runOp(
      "discard",
      "stage",
      (o) => o.discardAll(),
      () => {
        for (const c of gone) onPathDeleted?.(c.path);
      },
    );
  }, [runOp, sorted, onPathDeleted]);

  const doCommit = useCallback(
    async (amend = false) => {
      const msg = message.trim();
      if (!msg) {
        toast("Enter a commit message first.", { variant: "warning" });
        return;
      }
      if (sorted.length === 0 && !amend) {
        toast("Nothing to commit - make changes first.", { variant: "warning" });
        return;
      }
      if (conflicts.length > 0) {
        // With nothing staged, Commit stages everything first - which on a
        // conflicted file is `git add`, i.e. "I resolved this", and would
        // commit the conflict markers verbatim. Git refuses this on its own
        // only when the path is still unmerged, which the staging step has
        // already undone by then.
        toast(
          `Resolve ${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"} first, then check them off.`,
          { variant: "warning" },
        );
        return;
      }
      const branch = status?.branch;
      const stageFirst = staged.length === 0 && sorted.length > 0;
      const ok = await runOp(
        "commit",
        "commit",
        async (o) => {
          // Nothing staged: commit everything, matching what the button says
          // and what VSCode does when its staged list is empty.
          if (stageFirst) await o.stage(discardPaths(sorted));
          await o.commit(msg, amend);
        },
        () => setMessage(""),
      );
      if (ok) {
        toast(amend ? `Amended ${branch ?? "HEAD"}` : `Committed to ${branch ?? "HEAD"}`, {
          variant: "success",
        });
      }
    },
    [message, sorted, staged.length, conflicts.length, status?.branch, runOp],
  );

  const doPush = useCallback(
    async (force = false) => {
      if (!force && status?.ahead === 0 && status.upstream) {
        toast("Nothing to push - branch is up to date.", { variant: "warning" });
        return;
      }
      const branch = status?.branch ?? null;
      const upstream = status?.upstream;
      const ok = await runOp("push", "push", (o) => o.push(branch, force));
      if (ok) {
        toast(
          upstream ? `Pushed ${branch ?? "HEAD"} → ${upstream}` : `Published ${branch ?? "HEAD"}`,
          { variant: "success" },
        );
      }
    },
    [status, runOp],
  );

  const doPull = useCallback(async () => {
    const ok = await runOp("pull", "pull", (o) => o.pull());
    if (ok) toast("Pulled from the remote.", { variant: "success" });
  }, [runOp]);

  const doFetch = useCallback(async () => {
    const ok = await runOp("fetch", "fetch", (o) => o.fetch());
    if (ok) toast("Fetched from the remote.", { variant: "success" });
  }, [runOp]);

  const doCheckout = useCallback(
    async (name: string, create?: boolean) => {
      const ok = await runOp("branch", "branch", (o) => o.checkout(name, create));
      if (ok)
        toast(create ? `Created branch ${name}` : `Switched to ${name}`, { variant: "success" });
    },
    [runOp],
  );

  const doDeleteBranch = useCallback(
    async (name: string, force?: boolean) => {
      // Rethrows so the dialog can offer a force delete on the "not fully
      // merged" refusal instead of silently swallowing it into a toast.
      if (!ops) throw new Error("Not a git repository.");
      await ops.deleteBranch(name, force);
      toast(`Deleted branch ${name}`, { variant: "success" });
      await fetchStatus(true);
      bumpGraph();
    },
    [ops, fetchStatus, bumpGraph],
  );

  const doRenameBranch = useCallback(
    async (from: string, to: string) => {
      const ok = await runOp("branch", "branch", (o) => o.renameBranch(from, to));
      if (ok) toast(`Renamed ${from} to ${to}`, { variant: "success" });
    },
    [runOp],
  );

  const loadBranches = useCallback(async () => (ops ? ops.branches() : []), [ops]);

  // Which repo dialog is open. One piece of state rather than four booleans:
  // they are mutually exclusive, all opened from the same menu.
  const [dialog, setDialog] = useState<ScmMoreAction | null>(null);
  const inProgress = status?.inProgress ?? null;

  const doSync = useCallback(async () => {
    const ok = await runOp("push", "push", (o) => o.sync(status?.branch ?? null));
    if (ok) toast("Synced with the remote.", { variant: "success" });
  }, [runOp, status?.branch]);

  const doUndoCommit = useCallback(async () => {
    const ok = await runOp("commit", "commit", (o) => o.undoLastCommit());
    // Says where the work went: `--soft` puts it back in the index, so the
    // user sees their files reappear staged rather than think they vanished.
    if (ok) toast("Undid the last commit. Its changes are staged again.", { variant: "success" });
  }, [runOp]);

  const doMergeOrRebase = useCallback(
    async (mode: "merge" | "rebase", name: string) => {
      setDialog(null);
      const ok = await runOp("merge", "branch", (o) =>
        mode === "merge" ? o.merge(name) : o.rebase(name),
      );
      if (ok) {
        toast(mode === "merge" ? `Merged ${name}.` : `Rebased onto ${name}.`, {
          variant: "success",
        });
      }
    },
    [runOp],
  );

  const doResolve = useCallback(
    async (op: GitInProgress, action: "abort" | "continue") => {
      const ok = await runOp("merge", "branch", (o) =>
        action === "abort" ? o.abort(op) : o.continueOp(op),
      );
      if (ok) {
        toast(
          action === "abort"
            ? `${IN_PROGRESS_LABEL[op]} aborted.`
            : `${IN_PROGRESS_LABEL[op]} continued.`,
          { variant: "success" },
        );
      }
    },
    [runOp],
  );

  const doInit = useCallback(async () => {
    // Not through `runOp`: that refuses when `status.isRepo` is false, which is
    // the only situation in which init makes any sense at all.
    const root = rootPath;
    if (!root) return;
    setBusy("branch");
    try {
      await localOps(root).init();
      toast("Initialized an empty repository.", { variant: "success" });
      await fetchStatus(true);
      bumpGraph();
    } catch (e) {
      toast(friendlyGitError(e, "init"), { variant: "error" });
    } finally {
      setBusy(null);
    }
  }, [rootPath, fetchStatus, bumpGraph]);

  const doPublishGithub = useCallback(
    async (name: string, isPrivate: boolean, description: string) => {
      setDialog(null);
      if (!status?.root) return;
      setBusy("push");
      try {
        const url = await ghFor(status.root).createRepo(name, isPrivate, description);
        toast(`Published ${name} to GitHub.`, { variant: "success" });
        if (url) void openUrl(url);
        await fetchStatus(true);
      } catch (e) {
        toast(friendlyGhError(e), { variant: "error" });
      } finally {
        setBusy(null);
      }
    },
    [status?.root, fetchStatus],
  );

  /** Branch/tag name being asked for, and the commit it will point at. */
  const [commitPrompt, setCommitPrompt] = useState<{
    kind: "branch" | "tag";
    sha: string;
    shortSha: string;
  } | null>(null);
  const [commitPromptName, setCommitPromptName] = useState("");
  /** A hard reset destroys uncommitted work, so it asks first. */
  const [confirmReset, setConfirmReset] = useState<{ sha: string; shortSha: string } | null>(null);

  const onCommitAction = useCallback(
    (action: CommitAction, sha: string, shortSha: string) => {
      if (action === "branch" || action === "tag") {
        setCommitPromptName("");
        setCommitPrompt({ kind: action, sha, shortSha });
        return;
      }
      if (action === "reset-hard") {
        setConfirmReset({ sha, shortSha });
        return;
      }
      void (async () => {
        const ok = await runOp("merge", "branch", (o) => {
          if (action === "revert") return o.revert(sha);
          if (action === "cherry-pick") return o.cherryPick(sha);
          return o.resetTo(sha, action === "reset-soft" ? "soft" : "mixed");
        });
        if (!ok) return;
        toast(
          action === "revert"
            ? `Reverted ${shortSha}.`
            : action === "cherry-pick"
              ? `Cherry-picked ${shortSha}.`
              : `Reset to ${shortSha}.`,
          { variant: "success" },
        );
      })();
    },
    [runOp],
  );

  const onMore = useCallback(
    (action: ScmMoreAction) => {
      if (action === "sync") return void doSync();
      if (action === "undo") return void doUndoCommit();
      setDialog(action);
    },
    [doSync, doUndoCommit],
  );

  /**
   * Publish `name` so a pull request can be opened for it. Rethrows rather
   * than toasting: the PR flow needs to stop before calling gh if the branch
   * never reached the remote. `ops.push` already handles a branch with no
   * upstream, so this is the same publish the header button performs.
   */
  const publishBranch = useCallback(
    async (name: string) => {
      if (!ops) throw new Error("Not a git repository.");
      await ops.push(name);
      await fetchStatus(true);
    },
    [ops, fetchStatus],
  );

  const doGenerate = useCallback(async () => {
    if (busy !== null) return;
    if (!ops || !status?.isRepo || !status.root) {
      toast("Not a git repository.", { variant: "warning" });
      return;
    }
    if (sorted.length === 0) {
      toast("No changes to summarize.", { variant: "warning" });
      return;
    }
    const startRoot = status.root;
    const startId = identity();
    setBusy("ai");
    try {
      let diff = "";
      try {
        diff = await ops.diff(DIFF_BYTE_CAP);
      } catch (e) {
        // Diff read failed. Fall back to a deterministic message so the user can still commit.
        if (identity() !== startId) return;
        setMessage(fallbackCommitMessage(sorted));
        toast(`Couldn't read diff: ${String(e)} - used a default message`, { variant: "warning" });
        return;
      }
      const res = await generateCommitMessage({ repoPath: startRoot, diff, changes: sorted });
      if (identity() !== startId) return;
      setMessage(res.message);
      if (res.fallback) {
        toast(
          `Used a default message (${res.reason ?? "AI unavailable"})${
            res.modelLabel ? ` - tried ${res.modelLabel}` : ""
          }`,
          { variant: "warning" },
        );
      } else if (res.modelLabel) {
        toast(`Generated with ${res.modelLabel}`, { variant: "success" });
      }
    } catch (e) {
      // generateCommitMessage isn't supposed to throw, but catch anyway so the panel doesn't crash.
      if (identity() !== startId) return;
      setMessage(fallbackCommitMessage(sorted));
      toast(`AI generation failed: ${String(e)} - used a default message`, { variant: "warning" });
    } finally {
      setBusy(null);
    }
  }, [busy, ops, status, sorted, identity]);

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((s) => ({ ...s, [key]: !s[key] }));
  }, []);

  /**
   * Per-file hunk list, shown when a row is expanded.
   *
   * Local repositories only: applying part of a file feeds the patch to
   * `git apply` on stdin, and the SSH transport has no stdin. Keyed off
   * `graphRefreshToken`, which `refresh()` bumps after a write and the 2.5s
   * poll does not - a hunk is addressed by its index, so it must be re-read
   * when the file changes and left alone when it has not.
   *
   * Declared with the other hooks and ABOVE the "no folder open" early return:
   * a hook after that `return` is skipped whenever the panel has no folder, and
   * React throws "Rendered fewer hooks than expected" the moment one is opened.
   */
  const renderHunks = useCallback(
    (c: GitChange) =>
      ops ? (
        <HunkList
          ops={ops}
          change={c}
          reloadKey={graphRefreshToken}
          onApplied={() => void refresh()}
          busy={busy !== null}
        />
      ) : null,
    [ops, graphRefreshToken, refresh, busy],
  );

  if (!rootPath && !remote) {
    return (
      <div className="relative flex h-full flex-col">
        {/* Keep the header row whenever the sidebar injected a drag grip, not
            only when there's a close button: without it the section loses its
            reorder handle and collapse chevron and reads as broken. */}
        {dragHandle || onClose ? (
          <div className="tedi-panel-header">
            {dragHandle}
            <span className="text-foreground/80 min-w-0 flex-1 truncate text-xs font-medium">
              Source Control
            </span>
            {onClose ? (
              <IconTooltip label="Close panel" side="bottom">
                <Button
                  variant="ghost"
                  size="icon"
                  className={DESTRUCTIVE_ACTION + " size-6"}
                  onClick={onClose}
                  aria-label="Close Source Control panel"
                >
                  <X size={12} strokeWidth={2} />
                </Button>
              </IconTooltip>
            ) : null}
          </div>
        ) : null}
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-3 text-center text-[11px]">
          Open a folder to use source control.
        </div>
      </div>
    );
  }

  const sections =
    sorted.length === 0 ? (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px]">
        No changes.
      </div>
    ) : (
      <ScrollArea className="min-h-0 flex-1">
        {status?.truncated ? (
          // Listing every row of a repository with a huge working tree - a
          // `git init` left in a home directory makes every file under it
          // untracked - froze the window, so the backend caps the list. Say so:
          // an unannounced cap reads as "these are all my changes".
          <div className="text-muted-foreground border-border/60 border-b px-3 py-1.5 text-[11px]">
            Too many changes to list them all. Showing {sorted.length}.
          </div>
        ) : null}
        <ChangeSection
          title="Merge Changes"
          changes={conflicts}
          collapsed={!!collapsedSections.conflicts}
          onToggleCollapse={() => toggleSection("conflicts")}
          busy={busy !== null}
          // Checking a conflict stages it, which is exactly how git records
          // "I resolved this". Without it the panel could show a conflict but
          // never let the user finish the merge.
          onSetStaged={setStaged}
          onClickDiff={remote ? undefined : openDiff}
          onDiscardOne={(c) => setConfirmDiscard([c])}
          // A conflicted row can never expand (its diff is a COMBINED diff, not
          // a patch), but passing this keeps its chevron column reserved so the
          // three sections line up with each other.
          renderHunks={remote ? undefined : renderHunks}
        />
        <ChangeSection
          title="Staged Changes"
          changes={staged}
          collapsed={!!collapsedSections.staged}
          onToggleCollapse={() => toggleSection("staged")}
          busy={busy !== null}
          onSetStaged={setStaged}
          onDiscard={(cs) => setConfirmDiscard(cs)}
          onClickDiff={remote ? undefined : openDiff}
          onDiscardOne={(c) => setConfirmDiscard([c])}
          renderHunks={remote ? undefined : renderHunks}
        />
        <ChangeSection
          title="Changes"
          changes={unstaged}
          collapsed={!!collapsedSections.unstaged}
          onToggleCollapse={() => toggleSection("unstaged")}
          busy={busy !== null}
          onSetStaged={setStaged}
          onDiscard={(cs) => setConfirmDiscard(cs)}
          onClickDiff={remote ? undefined : openDiff}
          onDiscardOne={(c) => setConfirmDiscard([c])}
          renderHunks={remote ? undefined : renderHunks}
        />
      </ScrollArea>
    );

  return (
    <div className="flex h-full min-h-0 flex-col outline-none">
      <PanelHeader
        status={status}
        changeCount={sorted.length}
        historyOnly={historyOnly}
        loading={loading}
        refresh={refresh}
        onDiscardAll={() => setConfirmAll(true)}
        onOpenInTab={onOpenInTab}
        onClose={onClose}
        dragHandle={dragHandle}
        loadBranches={loadBranches}
        onCheckout={doCheckout}
        onDeleteBranch={doDeleteBranch}
        onRenameBranch={doRenameBranch}
        busy={busy !== null}
      />

      {collapsed ? null : (
        <>
          {error ? <div className="text-destructive px-3 py-2 text-[11px]">{error}</div> : null}

          {/* A half-finished merge or rebase is the one state where the normal
              controls are all wrong: git refuses almost everything until it is
              resolved, so the way out gets its own strip above the file list
              instead of hiding in a menu. */}
          {inProgress ? (
            <div className="border-border/60 bg-muted/40 flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
              <CircleAlert size={13} strokeWidth={2} className="text-icon-working shrink-0" />
              <span className="min-w-0 flex-1 text-[11px]">
                {IN_PROGRESS_LABEL[inProgress]} in progress
                {conflicts.length > 0
                  ? ` - ${conflicts.length} conflicted`
                  : " - nothing conflicted"}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={busy !== null || conflicts.length > 0}
                onClick={() => void doResolve(inProgress, "continue")}
                aria-label={`Continue the ${inProgress}`}
              >
                Continue
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn(DESTRUCTIVE_ACTION, "h-6 px-2 text-[11px]")}
                disabled={busy !== null}
                onClick={() => void doResolve(inProgress, "abort")}
                aria-label={`Abort the ${inProgress}`}
              >
                Abort
              </Button>
            </div>
          ) : null}

          {!status?.isRepo ? (
            <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3 text-center text-[11px]">
              <p>
                {!remote
                  ? "This folder is not a git repository."
                  : error
                    ? "Could not read the remote repository."
                    : "Not a git repository on the remote."}
              </p>
              {/* The dead end this used to be. Initializing is the one thing a
                  user wants here, and it is a local-only operation. */}
              {!remote && rootPath ? (
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={doInit}>
                  <FolderGit2 size={12} strokeWidth={2} />
                  Initialize repository
                </Button>
              ) : null}
            </div>
          ) : historyOnly ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <GitGraphView
                rootPath={status.root}
                isRepo={status.isRepo}
                refreshToken={graphRefreshToken}
                anchorMode="mouse"
                onOpenDiff={onOpenDiff}
                onCommitAction={onCommitAction}
              />
            </div>
          ) : remote ? (
            /* History reads blobs through local git, so a remote repo gets the
               Changes view alone rather than a tab that would query the wrong
               repository. */
            <div className="flex min-h-0 flex-1 flex-col">
              <CommitBox
                status={status}
                message={message}
                setMessage={setMessage}
                changeCount={sorted.length}
                stagedCount={staged.length}
                busy={busy}
                doCommit={doCommit}
                doGenerate={doGenerate}
                doPush={doPush}
                doPull={doPull}
                doFetch={doFetch}
                onMore={onMore}
                canUseGithub={!remote}
              />
              {sections}
            </div>
          ) : (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "changes" | "graph" | "prs")}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              <TabsList className="bg-muted/40 mx-2 mt-2 mb-1 h-7 w-auto px-1">
                <TabsTrigger value="changes" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                  Changes
                </TabsTrigger>
                <TabsTrigger value="graph" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                  History
                </TabsTrigger>
                {/* "PRs" rather than "Pull Requests": three full words do not
                    fit this row at sidebar width, and a truncated tab label is
                    worse than the abbreviation GitHub itself uses. */}
                <TabsTrigger value="prs" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                  PRs
                </TabsTrigger>
              </TabsList>

              <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
                <CommitBox
                  status={status}
                  message={message}
                  setMessage={setMessage}
                  changeCount={sorted.length}
                  stagedCount={staged.length}
                  busy={busy}
                  doCommit={doCommit}
                  doGenerate={doGenerate}
                  doPush={doPush}
                  doPull={doPull}
                  doFetch={doFetch}
                  onMore={onMore}
                  canUseGithub={!remote}
                />
                {sections}
              </TabsContent>

              <TabsContent value="graph" className="flex min-h-0 flex-1 flex-col">
                <GitGraphView
                  rootPath={status.root}
                  isRepo={status.isRepo}
                  refreshToken={graphRefreshToken}
                  anchorMode="row"
                  onOpenDiff={onOpenDiff}
                  onCommitAction={onCommitAction}
                />
              </TabsContent>

              {/* Mounted only while selected. Every gh call is a subprocess and
                  a network round trip, so the tab must not load itself behind
                  the Changes view the user is actually looking at. */}
              <TabsContent value="prs" className="flex min-h-0 flex-1 flex-col">
                {tab === "prs" && status.root ? (
                  <PullRequestsView
                    repoPath={status.root}
                    branch={status.branch}
                    onPublish={publishBranch}
                    onRefresh={refresh}
                    loadBranches={loadBranches}
                    busy={busy !== null}
                  />
                ) : null}
              </TabsContent>
            </Tabs>
          )}
        </>
      )}

      {/* Every repo dialog reads and writes through `ops`, so they work
          identically against a local repository and an SSH one. */}
      <StashDialog
        open={dialog === "stashes"}
        onOpenChange={(o) => setDialog(o ? "stashes" : null)}
        changeCount={sorted.length}
        stagedCount={staged.length}
        load={async () => (ops ? ops.stashes() : [])}
        onStash={async (msg, stagedOnly) => {
          await runOp("stash", "stage", (o) => o.stash(msg, stagedOnly));
        }}
        onApply={async (ref, pop) => {
          await runOp("stash", "stage", (o) => o.stashApply(ref, pop));
        }}
        onDrop={async (ref) => {
          await runOp("stash", "stage", (o) => o.stashDrop(ref));
        }}
      />

      <TagDialog
        open={dialog === "tags"}
        onOpenChange={(o) => setDialog(o ? "tags" : null)}
        branch={status?.branch ?? null}
        load={async () => (ops ? ops.tags() : [])}
        onCreate={async (name, msg) => {
          await runOp("tag", "branch", (o) => o.createTag(name, msg));
        }}
        onDelete={async (name) => {
          await runOp("tag", "branch", (o) => o.deleteTag(name));
        }}
        onPush={async (name) => {
          const ok = await runOp("push", "push", (o) => o.pushTag(name));
          if (ok) toast(`Pushed tag ${name}.`, { variant: "success" });
        }}
      />

      <BranchOpDialog
        mode={dialog === "merge" ? "merge" : dialog === "rebase" ? "rebase" : null}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
        branch={status?.branch ?? null}
        loadBranches={loadBranches}
        onSubmit={(name) => void doMergeOrRebase(dialog === "rebase" ? "rebase" : "merge", name)}
      />

      <PublishGithubDialog
        open={dialog === "publishGithub"}
        onOpenChange={(o) => setDialog(o ? "publishGithub" : null)}
        suggestedName={status?.root ? basename(status.root) : ""}
        loadExisting={async () => (status?.root ? ghFor(status.root).repoInfo() : null)}
        onPublish={(name, isPrivate, description) =>
          void doPublishGithub(name, isPrivate, description)
        }
        onOpenExisting={(url) => {
          setDialog(null);
          void openUrl(url);
        }}
      />

      <CommitRefDialog
        prompt={commitPrompt}
        name={commitPromptName}
        setName={setCommitPromptName}
        onClose={() => setCommitPrompt(null)}
        onSubmit={(kind, sha, shortSha, name) => {
          setCommitPrompt(null);
          void (async () => {
            const ok = await runOp(kind === "branch" ? "branch" : "tag", "branch", (o) =>
              // A branch AT a commit is `checkout -b <name> <sha>`, which
              // `ops.checkout` cannot express - it only ever branches from
              // HEAD - so this goes through the primitives directly.
              kind === "branch" ? o.branchAt(name, sha) : o.tagAt(name, sha),
            );
            if (ok) {
              toast(
                kind === "branch"
                  ? `Created branch ${name} at ${shortSha}`
                  : `Tagged ${shortSha} as ${name}`,
                { variant: "success" },
              );
            }
          })();
        }}
      />

      <AlertDialog
        open={confirmReset !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmReset(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hard reset to {confirmReset?.shortSha}?</AlertDialogTitle>
            <AlertDialogDescription>
              Moves {status?.branch ?? "HEAD"} to this commit and throws away every change after it,
              staged or not. Commits stay reachable through the reflog for a while; uncommitted work
              does not. This cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = confirmReset;
                setConfirmReset(null);
                if (!target) return;
                void (async () => {
                  const ok = await runOp("merge", "branch", (o) => o.resetTo(target.sha, "hard"));
                  if (ok) toast(`Hard reset to ${target.shortSha}.`, { variant: "success" });
                })();
              }}
            >
              Reset and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard all changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently revert every modified file to its last committed state and
              delete every untracked file{remote ? " on the remote machine" : ""}. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doDiscardAll}>
              Discard all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmDiscard !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDiscard(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDiscard?.length === 1
                ? `Discard changes to ${basename(confirmDiscard[0].relative)}?`
                : `Discard changes to ${confirmDiscard?.length ?? 0} files?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDiscard?.every((c) => c.status === "untracked" || c.status === "added")
                ? "This will delete the files from disk. This cannot be undone."
                : "This will unstage the selection and revert it to its last committed state, deleting anything that was never committed. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmDiscard) doDiscard(confirmDiscard);
                setConfirmDiscard(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
