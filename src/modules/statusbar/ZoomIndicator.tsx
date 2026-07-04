import { IconTooltip } from "@/components/ui/icon-tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { CONTENT_ZOOM_DEFAULT, setContentZoom } from "@/modules/settings/store";
import { ZoomIn } from "lucide-react";

export function ZoomIndicator() {
  const zoom = usePreferencesStore((s) => s.contentZoom);
  if (Math.abs(zoom - CONTENT_ZOOM_DEFAULT) < 0.001) return null;

  const label = formatZoom(zoom);
  return (
    <IconTooltip label={`Zoom ${label} · click to reset`} side="top">
      <button
        type="button"
        onClick={() => void setContentZoom(CONTENT_ZOOM_DEFAULT)}
        aria-label={`Content zoom ${label}. Click to reset to 100%.`}
        className="border-border/60 bg-card text-muted-foreground hover:border-border hover:bg-accent hover:text-accent-foreground flex h-6 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs transition-colors"
      >
        <ZoomIn size={12} strokeWidth={1.75} className="shrink-0" />
        <span>{label}</span>
      </button>
    </IconTooltip>
  );
}

function formatZoom(zoom: number): string {
  const rounded = Math.round(zoom * 100) / 100;
  const trimmed = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${trimmed}×`;
}
