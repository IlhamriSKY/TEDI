import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

/**
 * A bento gutter, not a divider. The handle paints nothing at all: it simply IS
 * the gap between two cards, which is why the groups carry no `gap` of their
 * own - one 6px gutter here, the same 6px the tray pads its edges with, so every
 * seam in the app is the same width. Resizing is grabbing that gutter at the
 * card's edge; the library inflates the hit region around this element to
 * `resizeTargetMinimumSize` (10px mouse / 20px touch) and swaps in a resize
 * cursor, which is the whole affordance a gutter needs.
 *
 * It stays a real element rather than being dropped entirely (v4 also resizes on
 * a bare gap between two panels) because arrow-key resizing is bound per
 * separator, and that is the only keyboard path to a pane size.
 */
function ResizableHandle({ className, ...props }: ResizablePrimitive.SeparatorProps) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "w-1.5 outline-hidden aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full",
        // Keyboard focus is the one moment a gutter has to show itself; a
        // pointer drag has the cursor to say it.
        "focus-visible:outline-primary/70 focus-visible:outline-2 focus-visible:-outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
