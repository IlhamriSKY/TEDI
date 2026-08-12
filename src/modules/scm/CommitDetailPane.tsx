import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename, dirname } from "@/lib/path";
import { cn } from "@/lib/utils";
import {
  Cherry,
  Clock,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Hash,
  Tag,
  Undo2,
  User,
  UserCheck,
} from "lucide-react";
import { gitCommitDetail } from "./api";
import { MetaPill, RefBadge } from "./components/RefBadge";
import { parseRefs } from "./historyMeta";
import { STATUS_LETTER, STATUS_TONE } from "./statusMeta";
import type { CommitDetail, CommitFile, OpenDiffInput } from "./types";

/** What the card can do TO the commit it is showing. */
export type CommitAction =
  "revert" | "cherry-pick" | "branch" | "tag" | "reset-soft" | "reset-mixed" | "reset-hard";

type Props = {
  repoPath: string;
  sha: string;
  /** Open a per-commit file diff in a tab. When omitted, the changed-file
   *  list is shown read-only (no diff). */
  onOpenDiff?: (input: OpenDiffInput) => void;
  /** Enables the actions row. Omitted in read-only hosts (a remote repo, or
   *  the history-only tab where there is no panel to refresh afterwards). */
  onAction?: (action: CommitAction, sha: string, shortSha: string) => void;
};

function formatTime(unix: number): string {
  try {
    return new Date(unix * 1000).toLocaleString();
  } catch {
    return "";
  }
}

export function CommitDetailPane({ repoPath, sha, onOpenDiff, onAction }: Props) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    gitCommitDetail(repoPath, sha)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, sha]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 px-3 py-8 text-center text-[11px]">
        <Spinner className="size-3" />
        Loading commit…
      </div>
    );
  }
  if (error) {
    return <div className="text-destructive px-3 py-2 text-[11px]">{error}</div>;
  }
  if (!detail) return null;

  const baseRev = detail.parents[0] ?? null;
  const committerDiffers =
    detail.committerName !== detail.authorName || detail.committerEmail !== detail.authorEmail;

  const openFile = onOpenDiff
    ? (f: CommitFile) => {
        onOpenDiff({
          // Reconstruct an absolute-ish path so the diff pane can pick a
          // language by extension and title the tab. Forward-slash matches
          // gitStatus.root.
          path: `${repoPath}/${f.path}`,
          relative: f.path,
          repoPath,
          changeStatus: f.status,
          commitSha: detail.sha,
          baseRev,
          oldRelative: f.oldPath,
          commitLabel: detail.shortSha,
        });
      }
    : undefined;

  const refChips = parseRefs(detail.refs);
  const isMerge = detail.parents.length > 1;
  const isRoot = detail.parents.length === 0;
  const TitleIcon = isMerge ? GitMerge : GitCommitHorizontal;
  const totalAdded = detail.files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = detail.files.reduce((n, f) => n + f.removed, 0);

  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col overflow-y-auto">
      {/* Header sits on its own tinted band so the message reads as the
          headline of the card rather than the first line of a list. */}
      <div className="bg-muted/40 border-border/60 border-b px-3 py-2.5">
        {refChips.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            {refChips.map((chip, i) => (
              <RefBadge key={`${chip.kind}-${chip.label}-${i}`} chip={chip} />
            ))}
          </div>
        ) : null}
        <div className="flex items-start gap-2">
          {/* The icon says what KIND of commit this is before the text does:
              a merge and an ordinary commit no longer look identical. */}
          <TitleIcon
            size={14}
            strokeWidth={2}
            className={cn(
              "mt-[3px] shrink-0",
              isMerge ? "text-info" : isRoot ? "text-diff-added" : "text-primary",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-foreground text-[13px] leading-snug font-semibold break-words">
              {detail.subject || "(no commit message)"}
            </div>
            {detail.body ? (
              <pre className="text-muted-foreground mt-1.5 font-sans text-[11px] leading-relaxed break-words whitespace-pre-wrap">
                {detail.body}
              </pre>
            ) : null}
          </div>
        </div>
        {/* Acts on this commit. Lives on the card rather than a right-click
            menu because the card is already the thing you open to decide, and
            the graph row's trigger is spoken for by the popover and tooltip. */}
        {onAction ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10.5px]"
              onClick={() => onAction("revert", detail.sha, detail.shortSha)}
            >
              <Undo2 size={11} strokeWidth={2} />
              Revert
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10.5px]"
              onClick={() => onAction("cherry-pick", detail.sha, detail.shortSha)}
            >
              <Cherry size={11} strokeWidth={2} />
              Cherry-pick
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10.5px]"
              onClick={() => onAction("branch", detail.sha, detail.shortSha)}
            >
              <GitBranch size={11} strokeWidth={2} />
              Branch
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10.5px]"
              onClick={() => onAction("tag", detail.sha, detail.shortSha)}
            >
              <Tag size={11} strokeWidth={2} />
              Tag
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10.5px]"
                  aria-label="Reset this branch to this commit"
                >
                  Reset…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem
                  onSelect={() => onAction("reset-soft", detail.sha, detail.shortSha)}
                >
                  Soft
                  <span className="text-muted-foreground ml-auto">keeps changes staged</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => onAction("reset-mixed", detail.sha, detail.shortSha)}
                >
                  Mixed
                  <span className="text-muted-foreground ml-auto">keeps changes unstaged</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onAction("reset-hard", detail.sha, detail.shortSha)}
                >
                  Hard
                  <span className="ml-auto">discards changes</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
        <div className="mt-2 flex flex-col gap-1 text-[10.5px]">
          <span className="flex min-w-0 items-center gap-1.5">
            <User size={11} strokeWidth={2} className="text-info shrink-0" />
            <span className="min-w-0 truncate">
              {detail.authorName}
              {detail.authorEmail ? (
                <span className="text-muted-foreground"> {detail.authorEmail}</span>
              ) : null}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Clock size={11} strokeWidth={2} className="text-icon-working shrink-0" />
            <span>{formatTime(detail.authorTime)}</span>
          </span>
          {committerDiffers ? (
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
              <UserCheck size={11} strokeWidth={2} className="shrink-0" />
              <span className="min-w-0 truncate">
                committed by {detail.committerName} · {formatTime(detail.commitTime)}
              </span>
            </span>
          ) : null}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground inline-flex cursor-default items-center gap-1 font-mono tabular-nums">
                  <Hash size={11} strokeWidth={2} className="shrink-0" />
                  {detail.shortSha}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{detail.sha}</TooltipContent>
            </Tooltip>
            {isMerge ? (
              <MetaPill tone="bg-info/15 text-info border-info/30">
                <GitMerge size={9} strokeWidth={2.25} className="shrink-0" />
                Merge of {detail.parents.length} parents
              </MetaPill>
            ) : isRoot ? (
              <MetaPill tone="bg-diff-added/15 text-diff-added border-diff-added/30">
                <GitCommitHorizontal size={9} strokeWidth={2.25} className="shrink-0" />
                Root commit
              </MetaPill>
            ) : null}
          </span>
        </div>
      </div>

      {/* File count on the left, the commit's total churn on the right in the
          same green/red the per-file rows use. */}
      <div className="border-border/60 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-muted-foreground/80 text-[10px] tracking-wide uppercase">
          {detail.files.length === 0
            ? "No file changes"
            : `${detail.files.length} file${detail.files.length === 1 ? "" : "s"} changed`}
        </span>
        {totalAdded > 0 || totalRemoved > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium tabular-nums">
            {totalAdded > 0 ? <span className="text-diff-added">+{totalAdded}</span> : null}
            {totalRemoved > 0 ? <span className="text-diff-removed">−{totalRemoved}</span> : null}
          </span>
        ) : null}
      </div>

      <ul className="pb-1">
        {detail.files.map((f) => (
          <FileRow
            key={`${f.path}:${f.status}`}
            file={f}
            onClick={openFile ? () => openFile(f) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({ file, onClick }: { file: CommitFile; onClick?: () => void }) {
  const name = basename(file.path);
  const dir = dirname(file.path);
  const interactive = !!onClick;
  return (
    <li className="contents">
      <div
        className={cn(
          "group flex items-center gap-1.5 py-1 pr-3 pl-2",
          interactive && "hover:bg-accent/40 cursor-pointer",
        )}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={onClick}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick?.();
                }
              }
            : undefined
        }
      >
        {/* The status letter as a tinted chip: `current` derives the fill and
            border from STATUS_TONE, so a new status only ever needs its text
            colour defined in one place. */}
        <span
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center border border-current/25 bg-current/10 font-mono text-[9.5px] font-semibold",
            STATUS_TONE[file.status],
          )}
        >
          {STATUS_LETTER[file.status]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span
            className={cn(
              "truncate text-[11.5px]",
              file.status === "deleted" && "line-through opacity-70",
            )}
          >
            {name}
          </span>
          {file.oldPath && file.oldPath !== file.path ? (
            <span className="text-muted-foreground truncate text-[10px]">← {file.oldPath}</span>
          ) : dir ? (
            <span className="text-muted-foreground truncate text-[10px]">{dir}</span>
          ) : null}
        </span>
        <FileStats file={file} />
      </div>
    </li>
  );
}

function FileStats({ file }: { file: CommitFile }) {
  if (file.binary) {
    return <span className="text-muted-foreground ml-1 shrink-0 text-[10px]">bin</span>;
  }
  if (file.added === 0 && file.removed === 0) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
      {file.added > 0 ? <span className="text-diff-added">+{file.added}</span> : null}
      {file.removed > 0 ? <span className="text-diff-removed">−{file.removed}</span> : null}
    </span>
  );
}
