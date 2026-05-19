import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import {
  ArrowDown01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  Refresh01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { gitCommit, gitDiffFull, gitDiscardAll, gitDiscardFile, gitPush, gitStatus } from "./api";
import { DIFF_BYTE_CAP, fallbackCommitMessage, generateCommitMessage } from "./commitAi";
import type { GitChange, GitChangeStatus, GitStatus } from "./types";

type Props = {
  rootPath: string | null;
  onPathDeleted?: (path: string) => void;
  /** Open a git diff in a new editor tab. */
  onOpenDiff?: (input: {
    path: string;
    relative: string;
    repoPath: string;
    changeStatus: GitChangeStatus;
  }) => void;
};

const STATUS_LETTER: Record<GitChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
  ignored: "I",
};

const STATUS_TONE: Record<GitChangeStatus, string> = {
  modified: "text-amber-500",
  added: "text-emerald-500",
  deleted: "text-rose-500",
  renamed: "text-sky-500",
  copied: "text-sky-500",
  untracked: "text-emerald-400",
  conflicted: "text-rose-600",
  ignored: "text-muted-foreground",
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

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

/** Translate the raw stderr from `git.exe` into something a user can act on.
 *  We keep the original text as a fallback so we never swallow an unfamiliar
 *  error - but the common cases get plain-language hints. */
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
    // Shouldn't surface - backend already retries with `-u origin <branch>` -
    // but if it does, give the user a clear next step.
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

export function SourceControlPanel({ rootPath, onPathDeleted, onOpenDiff }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmOne, setConfirmOne] = useState<GitChange | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "push" | "ai">(null);

  const inFlightRef = useRef(false);
  const rootRef = useRef(rootPath);
  // Tracks the last branch we saw for the current repo so we can fire a toast
  // when an external action (terminal, another tool) switches HEAD. Reset on
  // rootPath change so we don't false-fire across folders.
  const prevBranchRef = useRef<string | null>(null);
  useEffect(() => {
    rootRef.current = rootPath;
    prevBranchRef.current = null;
  }, [rootPath]);

  useEffect(() => {
    const cur = status?.branch ?? null;
    const prev = prevBranchRef.current;
    if (cur && prev && cur !== prev) {
      // Preserve the in-progress commit message on purpose - switching
      // branches shouldn't drop the user's draft.
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

  const refresh = useCallback(() => fetchStatus(false), [fetchStatus]);

  useEffect(() => {
    void fetchStatus(false);
  }, [fetchStatus, rootPath]);

  useEffect(() => {
    if (!rootPath) return;
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
  }, [rootPath, fetchStatus]);

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
    // Capture identity at start of the async op - if the user opens a
    // different folder mid-flight, we skip the state mutations that would
    // otherwise leak into the new repo's UI (clearing draft, refresh, etc.).
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
        // Diff read itself failed - fall back to a deterministic message so
        // the user can still commit instead of being stuck.
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
      // Belt-and-braces: generateCommitMessage is meant to never throw, but
      // if a bug or future refactor lets one escape, surface it cleanly
      // instead of crashing the panel.
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
      <div className="text-muted-foreground flex h-full items-center justify-center px-3 text-center text-[11px]">
        Open a folder to use source control.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <HugeiconsIcon
          icon={GitBranchIcon}
          size={13}
          strokeWidth={2}
          className="text-muted-foreground shrink-0"
        />
        {status?.branch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
                {status.isRepo ? (status.branch ?? "HEAD") : "Source Control"}
                {status.isRepo && sorted.length > 0 ? (
                  <span className="text-muted-foreground ml-1.5 text-[10.5px] tabular-nums">
                    ({sorted.length})
                  </span>
                ) : null}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{status.branch}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
            {status?.isRepo ? (status.branch ?? "HEAD") : "Source Control"}
            {status?.isRepo && sorted.length > 0 ? (
              <span className="text-muted-foreground ml-1.5 text-[10.5px] tabular-nums">
                ({sorted.length})
              </span>
            ) : null}
          </span>
        )}
        {status?.isRepo && status.ahead > 0 ? (
          <span className="text-muted-foreground inline-flex items-center gap-0.5 text-[10.5px] tabular-nums">
            <HugeiconsIcon icon={ArrowUp01Icon} size={10} strokeWidth={2.25} />
            {status.ahead}
          </span>
        ) : null}
        {status?.isRepo && status.behind > 0 ? (
          <span className="text-muted-foreground inline-flex items-center gap-0.5 text-[10.5px] tabular-nums">
            <HugeiconsIcon icon={ArrowDown01Icon} size={10} strokeWidth={2.25} />
            {status.behind}
          </span>
        ) : null}
        <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
        {status?.isRepo && sorted.length > 0 ? (
          <IconTooltip label="Discard all changes" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive size-6"
              onClick={() => setConfirmAll(true)}
              aria-label="Discard all changes"
            >
              <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label="Refresh" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => void refresh()}
            aria-label="Refresh"
            disabled={loading}
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </div>

      {error ? <div className="text-destructive px-3 py-2 text-[11px]">{error}</div> : null}

      {status?.isRepo ? <Separator className="bg-border" /> : null}

      {status?.isRepo ? (
        <div
          className="border-border/60 flex shrink-0 items-center gap-1 border-b px-2 py-2.5"
          aria-busy={busy !== null}
        >
          <div className="relative flex-1">
            <Input
              placeholder="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (message.trim() && sorted.length > 0 && busy === null) {
                    void doCommit();
                  }
                }
              }}
              className="h-7 w-full rounded-md pr-7 pl-2 text-[11.5px]"
              disabled={busy !== null}
            />
            <IconTooltip
              label={
                busy === "ai"
                  ? "Generating…"
                  : sorted.length === 0
                    ? "No changes to summarize"
                    : "Generate commit message with AI"
              }
              side="bottom"
            >
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-0.5 size-6 -translate-y-1/2 rounded-md active:-translate-y-1/2!"
                onClick={() => void doGenerate()}
                disabled={sorted.length === 0 || busy !== null}
                aria-label="Generate commit message"
              >
                <HugeiconsIcon
                  icon={SparklesIcon}
                  size={12}
                  strokeWidth={2}
                  className={busy === "ai" ? "animate-pulse" : undefined}
                />
              </Button>
            </IconTooltip>
          </div>
          <IconTooltip label={busy === "commit" ? "Committing…" : "Commit (Enter)"} side="bottom">
            <Button
              size="icon"
              className="size-7 rounded-md"
              onClick={() => void doCommit()}
              disabled={!message.trim() || sorted.length === 0 || busy !== null}
              aria-label="Commit"
            >
              <HugeiconsIcon icon={GitCommitIcon} size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
          <IconTooltip
            label={
              busy === "push"
                ? "Pushing…"
                : status.upstream
                  ? `Push to ${status.upstream}` +
                    (status.behind > 0 ? ` (${status.behind} behind)` : "")
                  : `Publish ${status.branch ?? "HEAD"} to origin`
            }
            side="bottom"
          >
            <Button
              variant="outline"
              size="icon"
              className={cn(
                "h-7 rounded-md",
                status.ahead > 0 ? "w-auto gap-0.5 px-1.5" : "size-7",
              )}
              onClick={() => void doPush()}
              disabled={busy !== null}
              aria-label="Push"
            >
              <HugeiconsIcon icon={CloudUploadIcon} size={12} strokeWidth={2} />
              {status.ahead > 0 ? (
                <span className="text-[10.5px] tabular-nums">{status.ahead}</span>
              ) : null}
            </Button>
          </IconTooltip>
        </div>
      ) : null}

      {!status?.isRepo ? (
        <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px]">
          Not a git repository.
        </div>
      ) : sorted.length === 0 ? (
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

type RowProps = {
  change: GitChange;
  onClickDiff: () => void;
  onDiscard: () => void;
};

function ChangeRow({ change, onClickDiff, onDiscard }: RowProps) {
  const name = basename(change.relative);
  const dir = dirname(change.relative);
  // pr-3 keeps content clear of the Radix ScrollArea's 10px scrollbar overlay.
  return (
    <li
      className="group hover:bg-accent/40 flex cursor-pointer items-center gap-1.5 py-1 pr-3 pl-2"
      onClick={onClickDiff}
    >
      <span
        className={cn(
          "w-3 shrink-0 text-center font-mono text-[10px] font-semibold tabular-nums",
          STATUS_TONE[change.status],
        )}
      >
        {STATUS_LETTER[change.status]}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span
          className={cn(
            "truncate text-[11.5px]",
            change.status === "deleted" && "line-through opacity-70",
          )}
        >
          {name}
        </span>
        {dir ? <span className="text-muted-foreground truncate text-[10px]">{dir}</span> : null}
      </span>
      <DiffStats change={change} />
      <span className="ml-1 hidden shrink-0 items-center group-hover:flex">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive size-5"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard();
          }}
          aria-label="Discard file"
        >
          <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={11} strokeWidth={2} />
        </Button>
      </span>
    </li>
  );
}

// Compact `+N −M` chip rendered to the right of the file name. Yields its
// slot to the discard button on row hover (`group-hover:hidden`) so the row
// never gets visually crowded. Binary entries show a muted "bin" tag instead
// of misleading line counts; rows with no meaningful stats render nothing.
function DiffStats({ change }: { change: GitChange }) {
  if (change.binary) {
    return (
      <span className="text-muted-foreground ml-1 shrink-0 text-[10px] group-hover:hidden">
        bin
      </span>
    );
  }
  if (change.added === 0 && change.removed === 0) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1 text-[10px] tabular-nums group-hover:hidden">
      {change.added > 0 ? (
        <span className="text-emerald-500 dark:text-emerald-400">+{change.added}</span>
      ) : null}
      {change.removed > 0 ? (
        <span className="text-rose-500 dark:text-rose-400">−{change.removed}</span>
      ) : null}
    </span>
  );
}
