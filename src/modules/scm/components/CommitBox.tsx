import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { GitStatus } from "../types";
import {
  ChevronDown,
  CloudDownload,
  CloudUpload,
  GitCommitHorizontal,
  RefreshCw,
  Sparkles,
} from "lucide-react";

export type ScmBusy = null | "commit" | "push" | "pull" | "fetch" | "ai" | "stage" | "branch";

type CommitBoxProps = {
  status: GitStatus;
  message: string;
  setMessage: (value: string) => void;
  changeCount: number;
  /** Rows currently in the index. Zero means Commit stages everything first,
   *  the way VSCode's commit-with-nothing-staged does. */
  stagedCount: number;
  busy: ScmBusy;
  doCommit: (amend?: boolean) => Promise<void> | void;
  doGenerate: () => Promise<void> | void;
  doPush: (force?: boolean) => Promise<void> | void;
  doPull: () => Promise<void> | void;
  doFetch: () => Promise<void> | void;
};

export function CommitBox({
  status,
  message,
  setMessage,
  changeCount,
  stagedCount,
  busy,
  doCommit,
  doGenerate,
  doPush,
  doPull,
  doFetch,
}: CommitBoxProps) {
  const commitAll = stagedCount === 0;
  const canCommit = message.trim().length > 0 && changeCount > 0 && busy === null;
  return (
    <div
      className="border-border/60 flex shrink-0 flex-col gap-1.5 border-b px-2 py-2"
      aria-busy={busy !== null}
    >
      <div className="relative">
        <Textarea
          placeholder={
            commitAll ? "Message (commits all changes)" : `Message (commits ${stagedCount} staged)`
          }
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter, not bare Enter: the box takes a multi-line message
            // (subject, blank line, body) the way git and VSCode expect.
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (canCommit) void doCommit();
            }
          }}
          rows={2}
          className="max-h-40 min-h-[3.25rem] w-full resize-y rounded-md py-1.5 pr-7 pl-2 text-[11.5px]"
          disabled={busy !== null}
        />
        <IconTooltip
          label={
            busy === "ai"
              ? "Generating…"
              : changeCount === 0
                ? "No changes to summarize"
                : "Generate commit message with AI"
          }
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground absolute top-1 right-0.5 size-6 rounded-md"
            onClick={() => void doGenerate()}
            disabled={changeCount === 0 || busy !== null}
            aria-label="Generate commit message"
          >
            {busy === "ai" ? (
              <Spinner className="size-3" />
            ) : (
              <Sparkles size={12} strokeWidth={2} />
            )}
          </Button>
        </IconTooltip>
      </div>

      <div className="flex items-center gap-1">
        <IconTooltip
          label={
            busy === "commit"
              ? "Committing…"
              : commitAll
                ? "Commit all changes (Ctrl+Enter)"
                : `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"} (Ctrl+Enter)`
          }
          side="bottom"
        >
          <Button
            size="sm"
            className="h-7 min-w-0 flex-1 gap-1 rounded-md text-[11.5px]"
            onClick={() => void doCommit()}
            disabled={!canCommit}
            aria-label={commitAll ? "Commit all changes" : "Commit staged changes"}
          >
            {busy === "commit" ? (
              <Spinner className="size-3" />
            ) : (
              <GitCommitHorizontal size={13} strokeWidth={2} />
            )}
            <span className="truncate">{commitAll ? "Commit all" : `Commit ${stagedCount}`}</span>
          </Button>
        </IconTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              className="size-7 shrink-0 rounded-md"
              disabled={busy !== null}
              aria-label="More source control actions"
            >
              <ChevronDown size={12} strokeWidth={2.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              disabled={!message.trim() || busy !== null}
              onSelect={() => void doCommit(true)}
            >
              <GitCommitHorizontal size={12} strokeWidth={2} />
              Amend last commit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy !== null} onSelect={() => void doPull()}>
              <CloudDownload size={12} strokeWidth={2} />
              Pull
              {status.behind > 0 ? (
                <span className="text-muted-foreground ml-auto tabular-nums">{status.behind}</span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy !== null} onSelect={() => void doPush()}>
              <CloudUpload size={12} strokeWidth={2} />
              {status.upstream ? "Push" : "Publish branch"}
              {status.ahead > 0 ? (
                <span className="text-muted-foreground ml-auto tabular-nums">{status.ahead}</span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy !== null || !status.upstream}
              onSelect={() => void doPush(true)}
            >
              <CloudUpload size={12} strokeWidth={2} />
              Force push (with lease)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy !== null} onSelect={() => void doFetch()}>
              <RefreshCw size={12} strokeWidth={2} />
              Fetch (prune)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconTooltip
          label={busy === "pull" ? "Pulling…" : `Pull from ${status.upstream ?? "origin"}`}
          side="bottom"
        >
          <Button
            variant="outline"
            size="icon"
            className={cn("h-7 rounded-md", status.behind > 0 ? "w-auto gap-0.5 px-1.5" : "size-7")}
            onClick={() => void doPull()}
            disabled={busy !== null}
            aria-label="Pull"
          >
            {busy === "pull" ? (
              <Spinner className="size-3" />
            ) : (
              <CloudDownload size={12} strokeWidth={2} />
            )}
            {status.behind > 0 ? (
              <span className="text-[10.5px] tabular-nums">{status.behind}</span>
            ) : null}
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
            className={cn("h-7 rounded-md", status.ahead > 0 ? "w-auto gap-0.5 px-1.5" : "size-7")}
            onClick={() => void doPush()}
            disabled={busy !== null}
            aria-label="Push"
          >
            {busy === "push" ? (
              <Spinner className="size-3" />
            ) : (
              <CloudUpload size={12} strokeWidth={2} />
            )}
            {status.ahead > 0 ? (
              <span className="text-[10.5px] tabular-nums">{status.ahead}</span>
            ) : null}
          </Button>
        </IconTooltip>
      </div>
    </div>
  );
}
