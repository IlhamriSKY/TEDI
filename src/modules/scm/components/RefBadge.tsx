import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { RefChip } from "../historyMeta";

/** The one pill shape across the history: ref chips on a graph row, the
 *  merge/root markers in the hover peek and in the commit card. */
export function MetaPill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        // No fixed micro-height + `leading-none`: the labels have no descenders,
        // so that combo parks the glyphs at the top of the line box (empty
        // descender space below) and reads as "stuck to the top". Size to content
        // with symmetric vertical padding + a balanced line-height so the text
        // sits optically centered in the pill.
        // `min-w-0` so a clamped label can shrink the pill instead of forcing
        // it wider than the space its row actually has.
        "inline-flex min-w-0 items-center gap-1 rounded-sm border px-1 py-px text-[9.5px] leading-[1.35] font-medium",
        tone,
      )}
    >
      {children}
    </span>
  );
}

/** `maxW` clamps the label to one ellipsised line, which is what a graph row
 *  needs: a 40-char branch name used to wrap inside the pill and push the row
 *  past the fixed height its lane lines are drawn at. The hover peek and the
 *  commit card pass nothing and let a long name wrap across their width. */
export function RefBadge({ chip, maxW }: { chip: RefChip; maxW?: string }) {
  const tone =
    chip.kind === "head"
      ? "bg-diff-added/15 text-diff-added border-diff-added/30"
      : chip.kind === "tag"
        ? "bg-icon-working/15 text-icon-working border-icon-working/30"
        : chip.kind === "remote"
          ? "bg-info/15 text-info border-info/30"
          : "bg-primary/15 text-primary border-primary/30";
  return (
    <MetaPill tone={tone}>
      {/* No `title`: the row is already a Radix tooltip trigger that lists
          every chip in full, and a native tooltip on top of it is two bubbles
          for the same text. */}
      <span className={cn(maxW && "truncate", maxW)}>{chip.label}</span>
    </MetaPill>
  );
}
