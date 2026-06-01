import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename } from "@/lib/path";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fileIconUrl } from "../lib/iconResolver";

type GrepFileRowProps = {
  rel: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
};

export function GrepFileRow({ rel, count, isCollapsed, onToggle }: GrepFileRowProps) {
  const name = basename(rel);
  const url = fileIconUrl(name);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          className="text-muted-foreground hover:bg-accent/40 flex w-full min-w-0 cursor-pointer items-center gap-1 px-2 py-1 text-left text-[11px]"
          aria-expanded={!isCollapsed}
        >
          <HugeiconsIcon
            icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="shrink-0"
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
  );
}
