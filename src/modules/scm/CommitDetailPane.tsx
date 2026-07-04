import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename, dirname } from "@/lib/path";
import { cn } from "@/lib/utils";
import { gitCommitDetail } from "./api";
import { STATUS_LETTER, STATUS_TONE } from "./statusMeta";
import type { CommitDetail, CommitFile, OpenDiffInput } from "./types";

type Props = {
  repoPath: string;
  sha: string;
  /** Open a per-commit file diff in a tab. When omitted, the changed-file
   *  list is shown read-only (no diff). */
  onOpenDiff?: (input: OpenDiffInput) => void;
};

function formatTime(unix: number): string {
  try {
    return new Date(unix * 1000).toLocaleString();
  } catch {
    return "";
  }
}

export function CommitDetailPane({ repoPath, sha, onOpenDiff }: Props) {
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

  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col overflow-y-auto">
      <div className="border-border/60 border-b px-3 py-2.5">
        <div className="text-foreground/90 text-[12.5px] leading-snug font-medium break-words">
          {detail.subject || "(no commit message)"}
        </div>
        {detail.body ? (
          <pre className="text-muted-foreground mt-1.5 font-sans text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {detail.body}
          </pre>
        ) : null}
        <div className="text-muted-foreground mt-2 flex flex-col gap-0.5 text-[10.5px]">
          <span>
            <span className="text-foreground/70">{detail.authorName}</span>
            {detail.authorEmail ? (
              <span className="text-muted-foreground/70"> &lt;{detail.authorEmail}&gt;</span>
            ) : null}
            {" · "}
            {formatTime(detail.authorTime)}
          </span>
          {committerDiffers ? (
            <span className="text-muted-foreground/80">
              committed by {detail.committerName}
              {" · "}
              {formatTime(detail.commitTime)}
            </span>
          ) : null}
          <span className="text-muted-foreground/70 flex items-center gap-1.5 font-mono">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="tabular-nums">{detail.shortSha}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{detail.sha}</TooltipContent>
            </Tooltip>
            {detail.parents.length > 1 ? (
              <span className="text-muted-foreground/60">
                (merge of {detail.parents.length} parents)
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <div className="text-muted-foreground/70 px-3 py-1.5 text-[10px] tracking-wide uppercase">
        {detail.files.length === 0
          ? "No file changes"
          : `${detail.files.length} file${detail.files.length === 1 ? "" : "s"} changed`}
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
        <span
          className={cn(
            "w-3 shrink-0 text-center font-mono text-[10px] font-semibold tabular-nums",
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
