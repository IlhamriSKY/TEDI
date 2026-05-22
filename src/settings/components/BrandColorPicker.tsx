import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BRAND_COLOR_DEFAULT, normalizeBrandColor, setBrandColor } from "@/modules/settings/store";
import { useEffect, useMemo, useRef, useState } from "react";

/** Color in HSV. Round-trips via hex on commit. */
type HSV = { h: number; s: number; v: number };

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function hexToHsv(hex: string): HSV {
  const v = normalizeBrandColor(hex).slice(1);
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex({ h, s, v }: HSV): string {
  const c = v * s;
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hh < 1) [r1, g1, b1] = [c, x, 0];
  else if (hh < 2) [r1, g1, b1] = [x, c, 0];
  else if (hh < 3) [r1, g1, b1] = [0, c, x];
  else if (hh < 4) [r1, g1, b1] = [0, x, c];
  else if (hh < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = v - c;
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/** Pointer-driven 2D plane (saturation x value). */
function SVPlane({ hsv, onChange }: { hsv: HSV; onChange: (next: HSV) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const handle = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const s = clamp01((e.clientX - rect.left) / rect.width);
    const v = clamp01(1 - (e.clientY - rect.top) / rect.height);
    onChange({ h: hsv.h, s, v });
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        handle(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) handle(e);
      }}
      // Standard HSV plane: hue base, left-to-right saturation, bottom-to-top value.
      className="relative h-40 w-full cursor-crosshair touch-none select-none"
      style={{
        backgroundColor: `hsl(${hsv.h} 100% 50%)`,
        backgroundImage:
          "linear-gradient(to top, #000 0%, transparent 100%), linear-gradient(to right, #fff 0%, transparent 100%)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
        style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
      />
    </div>
  );
}

/** Pointer-driven 1D hue slider. */
function HueSlider({ hsv, onChange }: { hsv: HSV; onChange: (next: HSV) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const handle = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const h = clamp01((e.clientX - rect.left) / rect.width) * 360;
    onChange({ h, s: hsv.s, v: hsv.v });
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        handle(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) handle(e);
      }}
      className="relative h-3 w-full cursor-pointer touch-none select-none"
      style={{
        backgroundImage:
          "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
        style={{ left: `${(hsv.h / 360) * 100}%` }}
      />
    </div>
  );
}

export function BrandColorPicker() {
  const brandColor = usePreferencesStore((s) => s.brandColor);
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(brandColor));
  const [draftHex, setDraftHex] = useState(brandColor);
  // Last committed value. Lets external pref updates re-seed local state without looping.
  const lastSync = useRef(brandColor);

  // Re-seed local HSV/draft when the persisted color changes externally.
  useEffect(() => {
    if (brandColor.toLowerCase() !== lastSync.current.toLowerCase()) {
      lastSync.current = brandColor;
      setHsv(hexToHsv(brandColor));
      setDraftHex(brandColor);
    }
  }, [brandColor]);

  const commitHsv = (next: HSV) => {
    setHsv(next);
    const hex = hsvToHex(next);
    lastSync.current = hex;
    setDraftHex(hex);
    void setBrandColor(hex);
  };

  const onHexChange = (raw: string) => {
    const next = raw.startsWith("#") ? raw : `#${raw}`;
    if (!/^#[0-9a-fA-F]{0,6}$/.test(next)) return;
    setDraftHex(next);
    if (/^#[0-9a-fA-F]{6}$/.test(next)) {
      const normalized = normalizeBrandColor(next);
      lastSync.current = normalized;
      setHsv(hexToHsv(normalized));
      void setBrandColor(normalized);
    }
  };

  const swatchStyle = useMemo(() => ({ background: brandColor }), [brandColor]);
  const isDefault = brandColor.toLowerCase() === BRAND_COLOR_DEFAULT.toLowerCase();

  const reset = () => {
    lastSync.current = BRAND_COLOR_DEFAULT;
    setHsv(hexToHsv(BRAND_COLOR_DEFAULT));
    setDraftHex(BRAND_COLOR_DEFAULT);
    void setBrandColor(BRAND_COLOR_DEFAULT);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Pick main color"
          className="border-border/70 hover:border-foreground/40 focus-visible:ring-ring/40 inline-flex h-7 items-center gap-2 border bg-transparent pr-2 pl-1 text-[11.5px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <span aria-hidden className="border-border/60 inline-block size-5 border" style={swatchStyle} />
          <span className="text-muted-foreground font-mono uppercase">{brandColor}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 gap-2.5 p-2.5">
        <SVPlane hsv={hsv} onChange={commitHsv} />
        <HueSlider hsv={hsv} onChange={commitHsv} />
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="border-border/60 inline-block size-9 shrink-0 border"
            style={swatchStyle}
          />
          <Input
            value={draftHex}
            onChange={(e) => onHexChange(e.target.value)}
            onBlur={() => {
              if (!/^#[0-9a-fA-F]{6}$/.test(draftHex)) setDraftHex(lastSync.current);
            }}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-9 px-2 font-mono text-[12px] uppercase"
            placeholder="#0057fe"
            aria-label="Hex color"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 shrink-0 px-2 text-[11px]"
            onClick={reset}
            disabled={isDefault}
            aria-label="Reset to default main color"
          >
            Reset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
