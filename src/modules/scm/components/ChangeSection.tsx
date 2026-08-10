import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import type { GitChange } from "../types";
import { ChangeRow } from "./ChangeRow";
import { ChevronRight, CornerUpLeft } from "lucide-react";

type Props = {
  title: string;
  changes: GitChange[];
  /** Collapsed sections keep their header (and its count) visible. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Absent in a read-only listing, which drops every action on the section. */
  onSetStaged?: (changes: GitChange[], staged: boolean) => void;
  onDiscard?: (changes: GitChange[]) => void;
  onClickDiff?: (change: GitChange) => void;
  onDiscardOne?: (change: GitChange) => void;
  busy?: boolean;
};

/**
 * One list of changes under a header that acts on the whole group: the header
 * checkbox stages or unstages every row at once, matching what VSCode's
 * section-level +/- do.
 */
export function ChangeSection({
  title,
  changes,
  collapsed,
  onToggleCollapse,
  onSetStaged,
  onDiscard,
  onClickDiff,
  onDiscardOne,
  busy,
}: Props) {
  if (changes.length === 0) return null;
  const stagedCount = changes.filter((c) => c.staged).length;
  const allStaged = stagedCount === changes.length;
  const headerState = allStaged ? true : stagedCount > 0 ? "indeterminate" : false;

  return (
    <div className="flex flex-col">
      {/* Opaque, not translucent + blurred: a sticky header has rows sliding
          underneath it, and letting them show through reads as the header
          itself shimmering. It also drops a compositing layer WebView2 would
          otherwise repaint on every scroll frame. min-h-7 matches ChangeRow so
          the header never resizes when its hover-only buttons fade in. */}
      <div className="text-muted-foreground group/sec bg-background sticky top-0 z-1 flex min-h-7 items-center gap-1.5 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
        {onSetStaged ? (
          <Checkbox
            checked={headerState}
            disabled={busy}
            onCheckedChange={() => onSetStaged(changes, !allStaged)}
            aria-label={`${allStaged ? "Unstage" : "Stage"} all ${title.toLowerCase()}`}
          />
        ) : null}
        <button
          type="button"
          className="hover:text-foreground flex min-w-0 flex-1 items-center gap-0.5 text-left uppercase transition-colors"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
        >
          {/* One chevron that rotates, not two that swap: a ternary between two
              icons replaces the DOM node, so it can never animate. */}
          <ChevronRight
            size={11}
            strokeWidth={2.5}
            className={cn("transition-transform", !collapsed && "rotate-90")}
          />
          <span className="truncate">{title}</span>
          <span className="ml-1 tabular-nums">({changes.length})</span>
        </button>
        {onSetStaged ? (
          <IconTooltip label={allStaged ? "Unstage all" : "Stage all"} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              // `transition-[color,opacity]` rather than the Button's own
              // `transition-colors`, which does not cover opacity - without it
              // the row-hover reveal pops in. Deliberately not plain
              // `transition`, which would also drag out the `active:` press.
              className="hover:text-foreground size-5 opacity-0 transition-[color,opacity] group-hover/sec:opacity-100 focus-visible:opacity-100"
              onClick={() => onSetStaged(changes, !allStaged)}
              disabled={busy}
              aria-label={allStaged ? "Unstage all" : "Stage all"}
            >
              {/* Plus losing its vertical bar to become a Minus. Both glyphs
                  share the horizontal stroke, so animating only the stroke that
                  differs reads as one motion where an icon swap reads as a
                  flicker. Geometry is lucide's at size 11 / strokeWidth 2.5:
                  bar 14/24 long, stroke 2.5/24 thick. */}
              <span className="grid size-[11px] place-items-center">
                <span className="col-start-1 row-start-1 h-[1.15px] w-[6.4px] rounded-full bg-current" />
                <span
                  className={cn(
                    "col-start-1 row-start-1 h-[6.4px] w-[1.15px] rounded-full bg-current transition-[scale] duration-200 ease-out motion-reduce:transition-none",
                    allStaged && "scale-y-0",
                  )}
                />
              </span>
            </Button>
          </IconTooltip>
        ) : null}
        {onDiscard ? (
          <IconTooltip label={`Discard all ${title.toLowerCase()}`} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="hover:text-destructive size-5 opacity-0 transition-[color,opacity] group-hover/sec:opacity-100 focus-visible:opacity-100"
              onClick={() => onDiscard(changes)}
              disabled={busy}
              aria-label={`Discard all ${title.toLowerCase()}`}
            >
              <CornerUpLeft size={11} strokeWidth={2.5} />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      <ul className={cn("pb-0.5", collapsed && "hidden")}>
        {changes.map((c) => (
          <ChangeRow
            key={c.relative + ":" + c.status + ":" + (c.staged ? "s" : "w")}
            change={c}
            busy={busy}
            onClickDiff={onClickDiff ? () => onClickDiff(c) : undefined}
            onDiscard={onDiscardOne ? () => onDiscardOne(c) : undefined}
            onToggleStage={onSetStaged ? (staged) => onSetStaged([c], staged) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}
