import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename } from "@/lib/path";
import { cn } from "@/lib/utils";
import { ChevronRight, ReplaceAll } from "lucide-react";
import { fileIconUrl } from "../lib/iconResolver";

type GrepFileRowProps = {
  rel: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  /** Replace every match in this file. Omitted (button hidden) when the query
   *  isn't currently replaceable. */
  onReplaceFile?: () => void;
};

export function GrepFileRow({
  rel,
  count,
  isCollapsed,
  onToggle,
  onReplaceFile,
}: GrepFileRowProps) {
  const name = basename(rel);
  const url = fileIconUrl(name);
  return (
    // Relative group so the replace-all action can overlay the count badge on
    // hover without nesting a button inside the row's own <button>.
    <div className="group/file relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:bg-accent/40 flex w-full min-w-0 cursor-pointer items-center gap-1 px-2 py-1 text-left text-[11px] transition-colors"
            aria-expanded={!isCollapsed}
          >
            {/* One chevron that rotates, not two that swap: a ternary between
                two icons replaces the DOM node, so it can never animate. */}
            <ChevronRight
              size={11}
              strokeWidth={2}
              className={cn("shrink-0 transition-transform", !isCollapsed && "rotate-90")}
            />
            {url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null}
            <span className="text-foreground/80 shrink truncate">{name}</span>
            <span className="hidden min-w-0 shrink truncate text-[10px] opacity-70 @[200px]:inline">
              {rel}
            </span>
            <span className="bg-muted ml-auto shrink-0 rounded px-1 text-[10px] tabular-nums opacity-80">
              {count}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{rel}</TooltipContent>
      </Tooltip>
      {onReplaceFile ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReplaceFile();
              }}
              aria-label="Replace all in file"
              className="bg-background/90 text-muted-foreground hover:bg-accent hover:text-accent-foreground absolute top-1/2 right-1.5 hidden -translate-y-1/2 cursor-pointer items-center rounded p-0.5 shadow-sm group-hover/file:flex"
            >
              <ReplaceAll size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Replace all in file</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
