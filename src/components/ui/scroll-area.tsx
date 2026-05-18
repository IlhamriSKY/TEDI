import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      // Keep the wrapper at exactly 10px on the scroll axis so the Radix
      // thumb visually matches the native ::-webkit-scrollbar (10px) used
      // everywhere else in the app. The earlier `p-px` + transparent
      // border combo produced an 8px-wide thumb inside a 10px wrapper,
      // which read as a thinner scrollbar than native - inconsistent
      // between panels with <ScrollArea> (file explorer / source control
      // / workspaces) and panels with plain `overflow-auto`.
      className={cn(
        "flex touch-none transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-vertical:h-full data-vertical:w-2.5",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        // Match the unified scrollbar palette: `--border` idle,
        // `--muted-foreground` hover. `bg-border` resolves to the same
        // CSS variable the global `::-webkit-scrollbar-thumb` rule uses.
        className="bg-border hover:bg-muted-foreground relative flex-1 transition-colors"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
