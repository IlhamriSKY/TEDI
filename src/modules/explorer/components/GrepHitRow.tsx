import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { Replace } from "lucide-react";
import { HighlightLine } from "./HighlightLine";
import { type GrepHit } from "./grepUtils";

type GrepHitRowProps = {
  hit: GrepHit;
  hitIdx: number;
  isActive: boolean;
  needle: string;
  useRegex: boolean;
  caseInsensitive: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  /** Replace this line's match(es). Omitted (button hidden) when the query
   *  isn't currently replaceable. */
  onReplace?: () => void;
};

export function GrepHitRow({
  hit,
  hitIdx,
  isActive,
  needle,
  useRegex,
  caseInsensitive,
  onMouseEnter,
  onClick,
  onReplace,
}: GrepHitRowProps) {
  return (
    // Relative group so the replace action can overlay the row on hover: the
    // row itself is a <button>, so a nested button would be invalid HTML.
    <div className="group/hit relative" onMouseEnter={onMouseEnter}>
      <IconTooltip label={`${hit.rel}:${hit.line}`} side="right">
        <button
          type="button"
          data-hit-idx={hitIdx}
          onClick={onClick}
          className={cn(
            "flex w-full cursor-pointer items-start gap-2 px-2 py-0.5 pl-7 text-left text-xs",
            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
          )}
        >
          <span className="text-muted-foreground w-8 shrink-0 pt-[1px] text-right text-[10px] leading-relaxed tabular-nums">
            {hit.line}
          </span>
          <span className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            <HighlightLine
              text={hit.text}
              needle={needle}
              useRegex={useRegex}
              caseInsensitive={caseInsensitive}
            />
          </span>
        </button>
      </IconTooltip>
      {onReplace ? (
        <IconTooltip label="Replace" side="bottom">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReplace();
            }}
            aria-label="Replace this match"
            className="bg-background/90 text-muted-foreground hover:bg-accent hover:text-accent-foreground absolute top-1/2 right-1 hidden -translate-y-1/2 cursor-pointer items-center rounded p-0.5 shadow-sm group-hover/hit:flex"
          >
            <Replace size={11} strokeWidth={2} />
          </button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
