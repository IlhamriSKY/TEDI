import type { ReactNode } from "react";

/** Muted 11px caption shown above a settings control. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}
