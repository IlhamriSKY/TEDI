import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/** Trailing icon button styling. Only close lives here; rotate and move are in the right-click menu. */
const TRAILING_BTN_BASE =
  "inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-60";

const TRAILING_BTN_VARIANT = {
  default: "text-current hover:bg-accent hover:opacity-100",
  danger: "hover:bg-destructive/10 hover:text-destructive hover:opacity-100",
} as const;

const TRAILING_ICON_SIZE = 9;

export function TrailingIconButton({
  icon,
  label,
  onClick,
  variant = "default",
}: {
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
  variant?: keyof typeof TRAILING_BTN_VARIANT;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Stop propagation so click doesn't activate the tab or start a drag.
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.stopPropagation();
            onClick();
          }}
          className={cn(TRAILING_BTN_BASE, TRAILING_BTN_VARIANT[variant])}
        >
          <HugeiconsIcon icon={icon} size={TRAILING_ICON_SIZE} strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
