import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type SearchOptionToggleProps = {
  /** Glyph shown inside the button (e.g. "Aa", "ab", ".*"). */
  label: string;
  pressed: boolean;
  onToggle: () => void;
  tooltip: string;
  ariaLabel: string;
};

/** The Aa / ab / .* search-option toggle shared by the editor find/replace bar,
 *  the markdown find bar, and the grep search bar. Pure presentation. */
export function SearchOptionToggle({
  label,
  pressed,
  onToggle,
  tooltip,
  ariaLabel,
}: SearchOptionToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={ariaLabel}
          aria-pressed={pressed}
          className={cn(
            "cursor-pointer rounded px-1 py-0.5 font-mono text-[10px] transition-colors",
            pressed
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
