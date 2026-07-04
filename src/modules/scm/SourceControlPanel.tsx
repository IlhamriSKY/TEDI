import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
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
import { basename } from "@/lib/path";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { gitCommit, gitDiffFull, gitDiscardAll, gitDiscardFile, gitPush, gitStatus } from "./api";
import { DIFF_BYTE_CAP, fallbackCommitMessage, generateCommitMessage } from "./commitAi";
import { GitGraphView } from "./GitGraphView";
import { ChangeRow } from "./components/ChangeRow";
import { CommitBox } from "./components/CommitBox";
import { PanelHeader } from "./components/PanelHeader";
import type { GitChange, GitChangeStatus, GitStatus, OpenDiffInput } from "./types";
import { X } from "lucide-react";

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

/** Map raw git stderr to actionable text. Common cases get plain-language hints; unknown errors fall through unchanged. */
function friendlyGitError(e: unknown, op: "commit" | "push" | "discard"): string {
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
  if (lower.includes("no upstream branch")) {
    // Rare: backend retries with `-u origin <branch>`. Show next step anyway.
    return "No upstream configured. Run `git push -u origin <branch>` from a terminal.";
  }
  if (lower.includes("not a git repository")) {
    return "Not a git repository.";
  }
  if (lower.includes("index.lock") || lower.includes("unable to create")) {
    return "Another git process is running (index.lock present). Try again in a moment.";
  }
  if (op === "commit" && (lower.includes("empty") || lower.includes("aborting commit"))) {
    return "Commit aborted - message or content is empty.";
  }
  return raw || `Failed to ${op}.`;
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
}: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmOne, setConfirmOne] = useState<GitChange | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "push" | "ai">(null);
  const [tab, setTab] = useState<"changes" | "graph">("changes");
  // Bumped after commit/push and on manual refresh so the Graph tab refetches
  // without us wiring a direct ref into the child.
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
  const bumpGraph = useCallback(() => setGraphRefreshToken((n) => n + 1), []);

  const inFlightRef = useRef(false);
  const rootRef = useRef(rootPath);
  // Last branch seen for the current repo. Lets us toast on external HEAD
  // switches. Reset on rootPath change to avoid false-firing across folders.
  const prevBranchRef = useRef<string | null>(null);
  useEffect(() => {
    rootRef.current = rootPath;
    prevBranchRef.current = null;
  }, [rootPath]);

  useEffect(() => {
    const cur = status?.branch ?? null;
    const prev = prevBranchRef.current;
    if (cur && prev && cur !== prev) {
      // Keep the in-progress commit message. Switching branches shouldn't drop the draft.
      toast(`Switched to branch ${cur}`, { variant: "info" });
    }
    prevBranchRef.current = cur;
  }, [status?.branch]);

  const openDiff = useCallback(
    (c: GitChange) => {
      if (!status?.root) return;
      onOpenDiff?.({
        path: c.path,
        relative: c.relative,
        repoPath: status.root,
        changeStatus: c.status,
      });
    },
    [status, onOpenDiff],
  );

  const fetchStatus = useCallback(async (silent = false) => {
    const cur = rootRef.current;
    if (!cur) {
      setStatus(null);
      return;
    }
    if (silent && inFlightRef.current) return;
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const s = await gitStatus(cur);
      if (rootRef.current === cur) {
        setStatus(s);
        setError(null);
      }
    } catch (e) {
      if (rootRef.current === cur) {
        setError(String(e));
        setStatus(null);
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
  }, [fetchStatus, rootPath, collapsed]);

  useEffect(() => {
    // Collapsed to its header: the change list / graph aren't rendered, so
    // don't poll git status (subprocess spawn every 2.5s) for an unseen view.
    if (!rootPath || collapsed) return;
    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (document.visibilityState === "visible") void fetchStatus(true);
      }, AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchStatus(true);
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => {
      void fetchStatus(true);
      start();
    };
    const onBlur = () => stop();

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [rootPath, fetchStatus, collapsed]);

  const sorted = useMemo(() => {
    if (!status) return [] as GitChange[];
    return [...status.changes].sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) return so;
      return a.relative.localeCompare(b.relative);
    });
  }, [status]);

  const doDiscardOne = useCallback(
    async (change: GitChange) => {
      if (!status?.root) return;
      try {
        await gitDiscardFile(status.root, change.relative);
        if (change.status === "untracked" || change.status === "added") {
          onPathDeleted?.(change.path);
        }
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [status, refresh, onPathDeleted],
  );

  const doDiscardAll = useCallback(async () => {
    if (!status?.root) return;
    try {
      const untracked = status.changes.filter(
        (c) => c.status === "untracked" || c.status === "added",
      );
      await gitDiscardAll(status.root);
      for (const u of untracked) onPathDeleted?.(u.path);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [status, refresh, onPathDeleted]);

  const doCommit = useCallback(async () => {
    if (busy !== null) return;
    if (!status?.isRepo || !status.root) {
      toast("Not a git repository.", { variant: "warning" });
      return;
    }
    if (sorted.length === 0) {
      toast("Nothing to commit - make changes first.", { variant: "warning" });
      return;
    }
    const msg = message.trim();
    if (!msg) {
      toast("Enter a commit message first.", { variant: "warning" });
      return;
    }
    // Capture repo identity before await. If the user opens a different
    // folder mid-flight, skip state mutations so they don't leak.
    const startRoot = status.root;
    const startBranch = status.branch;
    setBusy("commit");
    try {
      await gitCommit(startRoot, msg);
      if (rootRef.current === startRoot) {
        setMessage("");
        toast(`Committed to ${startBranch ?? "HEAD"}`, { variant: "success" });
        await refresh();
      }
    } catch (e) {
      toast(friendlyGitError(e, "commit"), { variant: "error" });
    } finally {
      setBusy(null);
    }
  }, [busy, status, sorted.length, message, refresh]);

  const doPush = useCallback(async () => {
    if (busy !== null) return;
    if (!status?.isRepo || !status.root) {
      toast("Not a git repository.", { variant: "warning" });
      return;
    }
    if (status.ahead === 0 && status.upstream) {
      toast("Nothing to push - branch is up to date.", { variant: "warning" });
      return;
    }
    const startRoot = status.root;
    const startBranch = status.branch;
    const startUpstream = status.upstream;
    setBusy("push");
    try {
      await gitPush(startRoot);
      if (rootRef.current === startRoot) {
        toast(
          startUpstream
            ? `Pushed ${startBranch ?? "HEAD"} → ${startUpstream}`
            : `Pushed ${startBranch ?? "HEAD"}`,
          { variant: "success" },
        );
        await refresh();
      }
    } catch (e) {
      toast(friendlyGitError(e, "push"), { variant: "error" });
    } finally {
      setBusy(null);
    }
  }, [busy, status, refresh]);

  const doGenerate = useCallback(async () => {
    if (busy !== null) return;
    if (!status?.isRepo || !status.root) {
      toast("Not a git repository.", { variant: "warning" });
      return;
    }
    if (sorted.length === 0) {
      toast("No changes to summarize.", { variant: "warning" });
      return;
    }
    const startRoot = status.root;
    setBusy("ai");
    try {
      let diff = "";
      try {
        diff = await gitDiffFull(startRoot, DIFF_BYTE_CAP);
      } catch (e) {
        // Diff read failed. Fall back to a deterministic message so the user can still commit.
        if (rootRef.current === startRoot) {
          setMessage(fallbackCommitMessage(sorted));
          toast(`Couldn't read diff: ${String(e)} - used a default message`, {
            variant: "warning",
          });
        }
        return;
      }
      const res = await generateCommitMessage({
        repoPath: startRoot,
        diff,
        changes: sorted,
      });
      if (rootRef.current !== startRoot) return;
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
      if (rootRef.current === startRoot) {
        setMessage(fallbackCommitMessage(sorted));
        toast(`AI generation failed: ${String(e)} - used a default message`, {
          variant: "warning",
        });
      }
    } finally {
      setBusy(null);
    }
  }, [busy, status, sorted]);

  if (!rootPath) {
    return (
      <div className="relative flex h-full flex-col">
        {onClose ? (
          <div className="flex h-8 shrink-0 items-center justify-end px-2">
            <IconTooltip label="Close panel" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="hover:bg-destructive/10 hover:text-destructive text-muted-foreground size-6"
                onClick={onClose}
                aria-label="Close Source Control panel"
              >
                <X size={12} strokeWidth={2} />
              </Button>
            </IconTooltip>
          </div>
        ) : null}
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-3 text-center text-[11px]">
          Open a folder to use source control.
        </div>
      </div>
    );
  }

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
      />

      {collapsed ? null : (
        <>
          {error ? <div className="text-destructive px-3 py-2 text-[11px]">{error}</div> : null}

          <Separator className="bg-border" />

          {!status?.isRepo ? (
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px]">
              Not a git repository.
            </div>
          ) : historyOnly ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <GitGraphView
                rootPath={status.root}
                isRepo={status.isRepo}
                refreshToken={graphRefreshToken}
                anchorMode="mouse"
                onOpenDiff={onOpenDiff}
              />
            </div>
          ) : (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "changes" | "graph")}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              <TabsList className="bg-muted/40 mx-2 mt-2 mb-1 h-7 w-auto px-1">
                <TabsTrigger value="changes" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                  Changes
                </TabsTrigger>
                <TabsTrigger value="graph" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                  History
                </TabsTrigger>
              </TabsList>

              <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
                <CommitBox
                  status={status}
                  message={message}
                  setMessage={setMessage}
                  changeCount={sorted.length}
                  busy={busy}
                  doCommit={doCommit}
                  doGenerate={doGenerate}
                  doPush={doPush}
                />

                {sorted.length === 0 ? (
                  <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px]">
                    No changes.
                  </div>
                ) : (
                  <ScrollArea className="min-h-0 flex-1">
                    <ul className="py-0.5">
                      {sorted.map((c) => (
                        <ChangeRow
                          key={c.relative + ":" + c.status}
                          change={c}
                          onClickDiff={() => openDiff(c)}
                          onDiscard={() => setConfirmOne(c)}
                        />
                      ))}
                    </ul>
                  </ScrollArea>
                )}
              </TabsContent>

              <TabsContent value="graph" className="flex min-h-0 flex-1 flex-col">
                <GitGraphView
                  rootPath={status.root}
                  isRepo={status.isRepo}
                  refreshToken={graphRefreshToken}
                  anchorMode="row"
                  onOpenDiff={onOpenDiff}
                />
              </TabsContent>
            </Tabs>
          )}
        </>
      )}

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard all changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently revert every modified file to its last committed state and
              delete every untracked file. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void doDiscardAll()}>
              Discard all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmOne !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmOne(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard changes to {confirmOne ? basename(confirmOne.relative) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmOne?.status === "untracked" || confirmOne?.status === "added"
                ? "This will delete the untracked file from disk. This cannot be undone."
                : "This will revert the file to its last committed state. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmOne) void doDiscardOne(confirmOne);
                setConfirmOne(null);
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
