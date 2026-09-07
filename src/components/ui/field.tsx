import type { ReactNode } from "react";

/** Muted 11px caption above a form control. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}

/**
 * Labelled form row: caption over control.
 *
 * One copy on purpose. This exact pair used to be written out three times - in
 * the SSH dialog, in the SCM form controls, and as the settings `Label` - each
 * with its own copy of the caption's class string, and each free to drift from
 * the other two. Every dialog and settings row in the app stacks its fields
 * through here now, so "the same" is enforced rather than noticed.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
