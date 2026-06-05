import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The floating drag ghost shown while dragging a tab or a pane. One component
 * for every surface so a dragged item reads identically wherever it comes from:
 * a crisp, solid, squared chip carrying the leaf icon + name.
 *
 * Solid `bg-accent` (no translucency/blur) plus a thin ring keep it sharply
 * defined; the global squarify rule keeps the corners square to match the app's
 * boxed theme. The icon is passed in (EntryIcon for the tab strip, LeafIcon for
 * the pane tree) so this owns only the box, the label, and the optional
 * unsaved-edits dot.
 */
export function DragChip({
  icon,
  label,
  className,
  italic = false,
  isPrivate = false,
  dirty = false,
}: {
  icon: ReactNode;
  label: string;
  /** Per-surface extras, e.g. a max-width (the tab strip is narrower than a pane). */
  className?: string;
  /** Transient/preview leaf: italic label. */
  italic?: boolean;
  /** Private leaf (AI can't read it): label turns red. */
  isPrivate?: boolean;
  /** Editor leaf with unsaved edits: trailing dot. */
  dirty?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-accent text-accent-foreground ring-border flex h-7 cursor-grabbing items-center gap-1.5 px-2 text-xs font-medium shadow-lg ring-1",
        className,
      )}
    >
      {icon}
      <span className={cn("truncate", italic && "italic", isPrivate && "text-destructive")}>
        {label}
      </span>
      {dirty && <span className="bg-icon-working size-1.5 shrink-0 rounded-full" />}
    </div>
  );
}
