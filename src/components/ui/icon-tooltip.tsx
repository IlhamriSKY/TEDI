import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Side = "top" | "right" | "bottom" | "left";

export function IconTooltip({
  label,
  side = "bottom",
  children,
  delayDuration,
  contentClassName,
}: {
  label: React.ReactNode;
  side?: Side;
  children: React.ReactElement;
  delayDuration?: number;
  /** Extra classes for the bubble. The default caps it at `max-w-xs`, which is
   *  right for a sentence and too narrow for a panel: a status meter's detail
   *  puts a label, a bar, a value and a countdown on one line and needs the
   *  room. Widen at the call site rather than raising the default, so a
   *  one-line tooltip keeps wrapping like a tooltip. */
  contentClassName?: string;
}) {
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className={contentClassName}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
