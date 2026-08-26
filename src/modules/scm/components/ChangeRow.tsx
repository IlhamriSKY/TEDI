import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { basename, dirname } from "@/lib/path";
import { cn } from "@/lib/utils";
import type { GitChange } from "../types";
import { STATUS_LETTER, STATUS_TONE } from "../statusMeta";
import { ChevronRight, CornerUpLeft } from "lucide-react";

type RowProps = {
  change: GitChange;
  /** Omitted for a read-only listing: the row then renders as plain text with
   *  no diff click target. */
  onClickDiff?: () => void;
  onDiscard?: () => void;
  /**
   * Checked means staged. The index IS the selection - there is no second
   * client-side set to keep in sync with it, and it survives a refresh, a
   * restart, and changes made from a terminal. Checking a conflicted row runs
   * the same `git add`, which is how a resolved conflict is marked resolved.
   */
  onToggleStage?: (staged: boolean) => void;
  /** Disables the checkbox while an operation on this row is in flight. */
  busy?: boolean;
  /**
   * Renders this file's hunks under the row. Absent means no expander at all,
   * which is how the read-only listing and the SSH panel opt out.
   *
   * Offered for a plain modified text file only. An untracked or deleted file
   * has no two sides to split, a binary one has no hunks, and a rename carries
   * header lines that `git apply` treats as part of the change - each of those
   * is a whole-file action, and offering a chevron that opens an empty list
   * would be worse than not offering one.
   */
  renderHunks?: (change: GitChange) => ReactNode;
};

export function ChangeRow({
  change,
  onClickDiff,
  onDiscard,
  onToggleStage,
  busy,
  renderHunks,
}: RowProps) {
  const name = basename(change.relative);
  const dir = dirname(change.relative);
  // Local, not lifted: the row's key already carries path + status + staged, so
  // staging the file re-keys the row and the expansion closes by itself, which
  // is what should happen when the file moves to the other section.
  const [expanded, setExpanded] = useState(false);
  const canExpand = Boolean(renderHunks) && change.status === "modified" && !change.binary;
  // pr-4 keeps the diff-stats / discard indicators clear of the Radix
  // ScrollArea's 10px overlay thumb. pr-3 left only ~2px, which rounds to a
  // visible overlap at some DPIs (matches the GraphRow fix).
  //
  // min-h-7 reserves the height the hover-only discard button needs (size-5
  // plus py-1). A repo-root file has no directory line, so its row is a single
  // ~14px label and the button appearing on hover used to make it taller: every
  // row below jumped, and when that pushed the next row under the cursor the
  // pointer left this one, the row shrank, and it re-entered - a row that
  // visibly oscillates as long as you hover near its edge.
  return (
    <li className="contents">
      <div
        className={cn(
          "group hover:bg-accent/40 flex min-h-7 items-center gap-1.5 py-1 pr-4 pl-2",
          onClickDiff && "cursor-pointer",
        )}
        role={onClickDiff ? "button" : undefined}
        tabIndex={onClickDiff ? 0 : undefined}
        onClick={onClickDiff}
        onKeyDown={(e) => {
          if (onClickDiff && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onClickDiff();
          }
        }}
      >
        {/* A fixed-width slot whether or not this row has an expander, so the
            checkboxes of every row still line up. */}
        {renderHunks ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {canExpand ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground cursor-pointer"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} hunks of ${change.relative}`}
              >
                <ChevronRight
                  size={11}
                  strokeWidth={2.5}
                  className={cn("transition-transform", expanded && "rotate-90")}
                />
              </button>
            ) : null}
          </span>
        ) : null}
        {onToggleStage ? (
          <span
            className="flex shrink-0 items-center"
            // The row opens a diff on click; the checkbox must not.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={change.staged}
              disabled={busy}
              onCheckedChange={(v) => onToggleStage(v === true)}
              aria-label={`${change.staged ? "Unstage" : "Stage"} ${change.relative}`}
            />
          </span>
        ) : null}
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
          {change.oldRelative ? (
            <span className="text-muted-foreground truncate text-[10px]">
              {change.oldRelative} →
            </span>
          ) : dir ? (
            <span className="text-muted-foreground truncate text-[10px]">{dir}</span>
          ) : null}
        </span>
        <DiffStats change={change} />
        {onDiscard ? (
          <span className="ml-1 hidden shrink-0 items-center group-hover:flex">
            <IconTooltip label="Discard changes" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive size-5"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard();
                }}
                aria-label={`Discard changes to ${change.relative}`}
              >
                <CornerUpLeft size={11} strokeWidth={2} />
              </Button>
            </IconTooltip>
          </span>
        ) : null}
      </div>
      {canExpand && expanded ? renderHunks!(change) : null}
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
