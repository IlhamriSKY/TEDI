import { Slider } from "@/components/ui/slider";
import { useEffect, useRef, useState } from "react";

/**
 * Slider that only persists on release. While dragging, the value lives
 * in local React state and a cheap `onPreview` callback applies the new
 * value directly to the DOM (CSS variable, inline style, ...). On
 * commit, `onCommit` writes the final value to the store - one IPC
 * round-trip per drag instead of one per pixel.
 */
function LiveSlider({
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onPreview: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  const safe = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
  const [local, setLocal] = useState<number>(() => safe(value));
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(safe(value));
    // safe() is stable per render and depends only on min/max which are
    // bound at the call-site as literals; intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Slider
      className="w-full"
      min={min}
      max={max}
      step={step}
      value={[local]}
      onValueChange={(v) => {
        const n = v[0];
        if (typeof n !== "number") return;
        dragging.current = true;
        setLocal(n);
        onPreview(n);
      }}
      onValueCommit={(v) => {
        const n = v[0];
        dragging.current = false;
        if (typeof n === "number") onCommit(n);
      }}
    />
  );
}

/**
 * Inline-row variant of `LiveSlider`: label + value chip + slider on a
 * single row. Used for the wallpaper adjustments (blur / opacity / darken)
 * which previously took 3 separate full-card `SettingRow` blocks.
 */
export function CompactSliderRow({
  label,
  valueLabel,
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
}: {
  label: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onPreview: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-foreground w-32 shrink-0 text-[11.5px]">{label}</span>
      <div className="flex-1">
        <LiveSlider
          value={value}
          min={min}
          max={max}
          step={step}
          onPreview={onPreview}
          onCommit={onCommit}
        />
      </div>
      <span className="text-muted-foreground w-12 shrink-0 text-right font-mono text-[10.5px]">
        {valueLabel}
      </span>
    </div>
  );
}
