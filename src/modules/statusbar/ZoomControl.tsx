import { IconTooltip } from "@/components/ui/icon-tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { CONTENT_ZOOM_MAX, CONTENT_ZOOM_MIN } from "@/modules/settings/store";
import { runCommand } from "@/modules/shortcuts";
import { cn } from "@/lib/utils";
import { Minus, Plus } from "lucide-react";

// Content-zoom control: [-] [100%] [+] as one segmented pill, leading the
// status bar's left cluster.
//
// Every segment runs the SAME command the keyboard does, through the shared
// command registry, so a button and its shortcut can never drift apart - the
// clamp and the 2dp rounding stay in the one handler in shortcutHandlers.ts.
//
// Always visible, unlike the indicator this replaces: hiding at 100% is fine
// for a readout, but it would make zoom-in unreachable by mouse from the
// default state.

/** Segment chrome. `h-5` / `rounded-full` / `text-[11px]` is the LEFT cluster's
 *  badge language (OsBadge, and the breadcrumb segments) - the right cluster's
 *  `size-6 rounded-md` glyphs would read as a transplant here. */
const SEG =
  "flex h-full cursor-pointer items-center justify-center transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

function Seg({
  id,
  title,
  disabled = false,
  className,
  children,
}: {
  id: Parameters<typeof runCommand>[0];
  title: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <IconTooltip label={title} side="top">
      <button
        type="button"
        onClick={() => runCommand(id)}
        disabled={disabled}
        aria-label={title}
        className={cn(SEG, "first:rounded-l-full last:rounded-r-full", className)}
      >
        {children}
      </button>
    </IconTooltip>
  );
}

export function ZoomControl() {
  const zoom = usePreferencesStore((s) => s.contentZoom);

  return (
    <div
      role="group"
      aria-label="Content zoom"
      // shrink-0: the left cluster is `min-w-0 flex-1 truncate`, so without it
      // the pill would be squeezed instead of the breadcrumb.
      className="border-border bg-muted/40 text-muted-foreground flex h-5 shrink-0 items-center rounded-full border text-[11px] font-medium"
    >
      <Seg
        id="view.zoomOut"
        title="Zoom out"
        // `<=` not `===`: the persisted value is an arbitrary float.
        disabled={zoom <= CONTENT_ZOOM_MIN}
        className="w-5"
      >
        <Minus size={11} strokeWidth={2.25} className="shrink-0" />
      </Seg>
      {/* Fixed width + tabular-nums: this sits left of the breadcrumb, so a
          label that changed width per step would shove the whole path sideways.
          Never disabled at 100% - dimming the readout in the most common state
          reads as broken, and the reset handler already no-ops there. */}
      <Seg id="view.zoomReset" title="Reset zoom" className="w-9 tabular-nums">
        {`${Math.round(zoom * 100)}%`}
      </Seg>
      <Seg id="view.zoomIn" title="Zoom in" disabled={zoom >= CONTENT_ZOOM_MAX} className="w-5">
        <Plus size={11} strokeWidth={2.25} className="shrink-0" />
      </Seg>
    </div>
  );
}
