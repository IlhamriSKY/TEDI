import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Check, Minus } from "lucide-react";

/**
 * Tri-state checkbox. `checked="indeterminate"` renders the dash a group header
 * needs when only some of its rows are selected.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-input focus-visible:border-ring focus-visible:ring-ring/40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground size-3.5 shrink-0 rounded-[3px] border transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {/* Radix mounts the indicator only once the box is checked, so the mark
          arrived with no animation at all. `animate-in` is a keyframe on mount,
          which is the only hook available here - a transition cannot run on an
          element that did not exist a frame ago. The dash/tick swap below stays
          instant on purpose: both states keep the indicator mounted, and a bar
          morphing into a tick is not legible at 10px. */}
      <CheckboxPrimitive.Indicator className="animate-in zoom-in-75 flex items-center justify-center text-current">
        {props.checked === "indeterminate" ? (
          <Minus size={10} strokeWidth={3} />
        ) : (
          <Check size={10} strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
