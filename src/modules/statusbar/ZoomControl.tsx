import { IconTooltip } from "@/components/ui/icon-tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { CONTENT_ZOOM_MAX, CONTENT_ZOOM_MIN } from "@/modules/settings/store";
import { runCommand } from "@/modules/shortcuts";
import { cn } from "@/lib/utils";
import { Minus, Plus } from "lucide-react";

// Content-zoom control: [-] [100%] [+] as one segmented pill, leading the
// status bar's right cluster (just before the extension status items).
//
// Every segment runs the SAME command the keyboard does, through the shared
// command registry, so a button and its shortcut can never drift apart - the
// clamp and the 2dp rounding stay in the one handler in shortcutHandlers.ts.
//
// Always visible, unlike the indicator this replaces: hiding at 100% is fine
// for a readout, but it would make zoom-in unreachable by mouse from the
// default state.

/** Segment chrome. The pill is `h-6` / `rounded-md` / `text-[11px]`, matching the
 *  right cluster's pill language (UpdaterPill, SchedulerStatusPill) so it sits
 *  beside the extension status items as a sibling. */
const SEG =
  "flex h-full cursor-pointer items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

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
        className={cn(SEG, "first:rounded-l-md last:rounded-r-md", className)}
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
      className="border-border/60 bg-card text-muted-foreground flex h-6 shrink-0 items-center rounded-md border text-[11px] font-medium"
    >
      <Seg
        id="view.zoomOut"
        title="Zoom out"
        // `<=` not `===`: the persisted value is an arbitrary float.
        disabled={zoom <= CONTENT_ZOOM_MIN}
        className="w-6"
      >
        <Minus size={12} strokeWidth={2} className="shrink-0" />
      </Seg>
      {/* Fixed width + tabular-nums so stepping the zoom never resizes the pill
          and shifts the icon row beside it. Never disabled at 100% - dimming the
          readout in the most common state reads as broken, and the reset handler
          already no-ops there. */}
      <Seg id="view.zoomReset" title="Reset zoom" className="w-11 tabular-nums">
        {`${Math.round(zoom * 100)}%`}
      </Seg>
      <Seg id="view.zoomIn" title="Zoom in" disabled={zoom >= CONTENT_ZOOM_MAX} className="w-6">
        <Plus size={12} strokeWidth={2} className="shrink-0" />
      </Seg>
    </div>
  );
}
