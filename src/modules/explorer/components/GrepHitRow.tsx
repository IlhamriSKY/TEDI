import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
}: GrepHitRowProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-hit-idx={hitIdx}
          onMouseEnter={onMouseEnter}
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
      </TooltipTrigger>
      <TooltipContent side="right">{`${hit.rel}:${hit.line}`}</TooltipContent>
    </Tooltip>
  );
}
