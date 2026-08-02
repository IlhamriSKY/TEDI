import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type RefChip = { label: string; kind: "head" | "branch" | "remote" | "tag" };

/**
 * Map git's raw `%D` entries into displayable chips. "HEAD -> main" becomes
 * a "HEAD" chip plus a "main" branch chip so both render distinctly.
 */
export function parseRefs(refs: string[]): RefChip[] {
  const out: RefChip[] = [];
  for (const r of refs) {
    if (r.startsWith("HEAD -> ")) {
      out.push({ label: "HEAD", kind: "head" });
      out.push({ label: r.slice("HEAD -> ".length), kind: "branch" });
    } else if (r === "HEAD") {
      out.push({ label: "HEAD", kind: "head" });
    } else if (r.startsWith("tag: ")) {
      out.push({ label: r.slice("tag: ".length), kind: "tag" });
    } else if (r.includes("/")) {
      out.push({ label: r, kind: "remote" });
    } else {
      out.push({ label: r, kind: "branch" });
    }
  }
  return out;
}

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
        "inline-flex items-center gap-1 rounded-sm border px-1 py-px text-[9.5px] leading-[1.35] font-medium",
        tone,
      )}
    >
      {children}
    </span>
  );
}

export function RefBadge({ chip }: { chip: RefChip }) {
  const tone =
    chip.kind === "head"
      ? "bg-diff-added/15 text-diff-added border-diff-added/30"
      : chip.kind === "tag"
        ? "bg-icon-working/15 text-icon-working border-icon-working/30"
        : chip.kind === "remote"
          ? "bg-info/15 text-info border-info/30"
          : "bg-primary/15 text-primary border-primary/30";
  return <MetaPill tone={tone}>{chip.label}</MetaPill>;
}
