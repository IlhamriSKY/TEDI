import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { CloudUploadIcon, GitCommitIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { GitStatus } from "../types";

type CommitBoxProps = {
  status: GitStatus;
  message: string;
  setMessage: (value: string) => void;
  changeCount: number;
  busy: null | "commit" | "push" | "ai";
  doCommit: () => Promise<void> | void;
  doGenerate: () => Promise<void> | void;
  doPush: () => Promise<void> | void;
};

export function CommitBox({
  status,
  message,
  setMessage,
  changeCount,
  busy,
  doCommit,
  doGenerate,
  doPush,
}: CommitBoxProps) {
  return (
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
              if (message.trim() && changeCount > 0 && busy === null) {
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
              : changeCount === 0
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
            disabled={changeCount === 0 || busy !== null}
            aria-label="Generate commit message"
          >
            {busy === "ai" ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={2} />
            )}
          </Button>
        </IconTooltip>
      </div>
      <IconTooltip label={busy === "commit" ? "Committing…" : "Commit (Enter)"} side="bottom">
        <Button
          size="icon"
          className="size-7 rounded-md"
          onClick={() => void doCommit()}
          disabled={!message.trim() || changeCount === 0 || busy !== null}
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
          className={cn("h-7 rounded-md", status.ahead > 0 ? "w-auto gap-0.5 px-1.5" : "size-7")}
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
  );
}
