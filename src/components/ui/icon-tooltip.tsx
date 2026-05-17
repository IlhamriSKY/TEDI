import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Side = "top" | "right" | "bottom" | "left";

export function IconTooltip({
  label,
  side = "bottom",
  children,
  delayDuration,
}: {
  label: React.ReactNode;
  side?: Side;
  children: React.ReactElement;
  delayDuration?: number;
}) {
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
