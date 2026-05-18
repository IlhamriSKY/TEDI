import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "bg-input/50 file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring aria-invalid:border-destructive dark:aria-invalid:border-destructive/60 h-9 w-full min-w-0 rounded-3xl border border-transparent px-3 py-1 text-base transition-[color,background-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
