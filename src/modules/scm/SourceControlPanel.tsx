import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  ArrowTurnBackwardIcon,
  GitBranchIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import {
  gitDiscardAll,
  gitDiscardFile,
  gitStatus,
} from "./api";
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

export function SourceControlPanel({
  rootPath,
  onPathDeleted,
  onOpenDiff,
}: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmOne, setConfirmOne] = useState<GitChange | null>(null);

  const inFlightRef = useRef(false);
  const rootRef = useRef(rootPath);
  useEffect(() => {
    rootRef.current = rootPath;
  }, [rootPath]);

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

  if (!rootPath) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
        Open a folder to use source control.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <HugeiconsIcon
          icon={GitBranchIcon}
          size={13}
          strokeWidth={2}
          className="shrink-0 text-muted-foreground"
        />
        {status?.branch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex-1 truncate text-xs font-medium text-foreground/80">
                {status.isRepo ? (status.branch ?? "HEAD") : "Source Control"}
                {status.isRepo && sorted.length > 0 ? (
                  <span className="ml-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                    ({sorted.length})
                  </span>
                ) : null}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{status.branch}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="flex-1 truncate text-xs font-medium text-foreground/80">
            {status?.isRepo
              ? (status.branch ?? "HEAD")
              : "Source Control"}
            {status?.isRepo && sorted.length > 0 ? (
              <span className="ml-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                ({sorted.length})
              </span>
            ) : null}
          </span>
        )}
        {status?.isRepo && sorted.length > 0 ? (
          <IconTooltip label="Discard all changes" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmAll(true)}
              aria-label="Discard all changes"
            >
              <HugeiconsIcon
                icon={ArrowTurnBackwardIcon}
                size={13}
                strokeWidth={2}
              />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label="Refresh" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => void refresh()}
            aria-label="Refresh"
            disabled={loading}
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </div>

      {error ? (
        <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>
      ) : null}

      {!status?.isRepo ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
          Not a git repository.
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
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
              This will permanently revert every modified file to its last
              committed state and delete every untracked file. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void doDiscardAll()}
            >
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
              {confirmOne?.status === "untracked" ||
              confirmOne?.status === "added"
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <li
          className="group flex cursor-pointer items-center gap-1.5 px-2 py-1 hover:bg-accent/40"
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
            {dir ? (
              <span className="truncate text-[10px] text-muted-foreground">
                {dir}
              </span>
            ) : null}
          </span>
          <span className="ml-1 flex shrink-0 items-center opacity-0 group-hover:opacity-100">
            <IconTooltip label="Discard" side="left">
              <Button
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard();
                }}
                aria-label="Discard file"
              >
                <HugeiconsIcon
                  icon={ArrowTurnBackwardIcon}
                  size={11}
                  strokeWidth={2}
                />
              </Button>
            </IconTooltip>
          </span>
        </li>
      </TooltipTrigger>
      <TooltipContent side="right">{`${change.relative} (${change.status})`}</TooltipContent>
    </Tooltip>
  );
}
