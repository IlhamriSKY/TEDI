import { Button } from "@/components/ui/button";
import { basename, dirname } from "@/lib/path";
import { cn } from "@/lib/utils";
import type { GitChange } from "../types";
import { STATUS_LETTER, STATUS_TONE } from "../statusMeta";
import { CornerUpLeft } from "lucide-react";

type RowProps = {
  change: GitChange;
  onClickDiff: () => void;
  onDiscard: () => void;
};

export function ChangeRow({ change, onClickDiff, onDiscard }: RowProps) {
  const name = basename(change.relative);
  const dir = dirname(change.relative);
  // pr-4 keeps the diff-stats / discard indicators clear of the Radix
  // ScrollArea's 10px overlay thumb. pr-3 left only ~2px, which rounds to a
  // visible overlap at some DPIs (matches the GraphRow fix).
  return (
    <li className="contents">
      <div
        className="group hover:bg-accent/40 flex cursor-pointer items-center gap-1.5 py-1 pr-4 pl-2"
        role="button"
        tabIndex={0}
        onClick={onClickDiff}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClickDiff();
          }
        }}
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
            <CornerUpLeft size={11} strokeWidth={2} />
          </Button>
        </span>
      </div>
    </li>
  );
}

// Compact `+N -M` chip after the file name. Hidden on hover so the discard
// button has room. Binary entries show "bin"; rows with no stats render nothing.
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
      {change.added > 0 ? <span className="text-diff-added">+{change.added}</span> : null}
      {change.removed > 0 ? <span className="text-diff-removed">−{change.removed}</span> : null}
    </span>
  );
}
