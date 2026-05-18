import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "bg-input/50 placeholder:text-muted-foreground focus-visible:border-ring aria-invalid:border-destructive dark:aria-invalid:border-destructive/60 flex field-sizing-content min-h-16 w-full resize-none rounded-2xl border border-transparent px-3 py-3 text-base transition-[color,background-color] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
