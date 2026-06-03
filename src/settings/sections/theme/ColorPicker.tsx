import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEffect, useRef, useState } from "react";
import { clamp01, HEX6_RE, hexToHsv, hsvToHex, type Hsv } from "./colorMath";

/**
 * Saturation/brightness square. Drag (or click) anywhere inside to set S (x
 * axis) and V (y axis); the hue comes from the parent so the gradient base
 * tracks the hue slider. Pointer-capture keeps tracking when the cursor leaves
 * the box. Squared corners + theme border match the rest of the app.
 */
function SaturationArea({ hsv, onChange }: { hsv: Hsv; onChange: (s: number, v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const apply = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(clamp01((clientX - r.left) / r.width), clamp01(1 - (clientY - r.top) / r.height));
  };
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Saturation and brightness"
      aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        apply(e.clientX, e.clientY);
      }}
      className="border-border/60 focus-visible:ring-ring/40 relative h-28 w-full cursor-crosshair touch-none border focus-visible:ring-2 focus-visible:outline-none"
      style={{
        backgroundColor: `hsl(${hsv.h} 100% 50%)`,
        backgroundImage:
          "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
      }}
    >
      <span
        aria-hidden
        className="ring-foreground/40 pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 border border-white shadow ring-1"
        style={{
          left: `${hsv.s * 100}%`,
          top: `${(1 - hsv.v) * 100}%`,
          backgroundColor: hsvToHex(hsv),
        }}
      />
    </div>
  );
}

/**
 * Horizontal hue bar (0-360). Same pointer-capture drag behaviour as the
 * saturation area; rainbow gradient track with a squared draggable marker.
 */
function HueSlider({ hue, onChange }: { hue: number; onChange: (h: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const apply = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(clamp01((clientX - r.left) / r.width) * 360);
  };
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Hue"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hue)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        apply(e.clientX);
      }}
      className="border-border/60 focus-visible:ring-ring/40 relative h-3 w-full cursor-ew-resize touch-none border focus-visible:ring-2 focus-visible:outline-none"
      style={{
        backgroundImage: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
      }}
    >
      <span
        aria-hidden
        className="ring-foreground/40 pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 border border-white shadow ring-1"
        style={{ left: `${(hue / 360) * 100}%`, backgroundColor: `hsl(${hue} 100% 50%)` }}
      />
    </div>
  );
}

/** HEX color button + popover picker (saturation square, hue bar, hex input). */
export function ColorSwatch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  // Defensive default: if a freshly added token is missing from a legacy
  // stored theme, surface as black instead of throwing on `HEX6_RE.test`.
  const safeValue = typeof value === "string" && value.length > 0 ? value : "#000000";
  const [draft, setDraft] = useState(safeValue);
  // Local HSV is the source of truth while the user drags the picker, so the
  // hue is preserved when S or V hit zero (a grey colour has no derivable hue).
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(safeValue));
  const inputRef = useRef<HTMLInputElement>(null);
  const isValid = HEX6_RE.test(draft);

  // Re-seed local draft + HSV when the parent value changes externally (preset
  // switch, .tedi import). Skip the draft while the hex input is focused so
  // typing isn't clobbered. The HSV is only re-derived when it actually
  // diverges from `safeValue`, so a value that round-tripped through our own
  // commit doesn't reset the hue mid-drag.
  useEffect(() => {
    if (
      document.activeElement !== inputRef.current &&
      draft.toLowerCase() !== safeValue.toLowerCase()
    )
      setDraft(safeValue);
    if (hsvToHex(hsv).toLowerCase() !== safeValue.toLowerCase()) setHsv(hexToHsv(safeValue));
    // We deliberately exclude `draft`/`hsv` from the dep array: this effect
    // should only fire when the parent value changes, not on every local edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeValue]);

  // Dragging the saturation/hue controls fires onChange continuously (~60-120
  // Hz). Coalesce to one update per frame so the cross-window store write does
  // not stall.
  const pendingRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const scheduleCommit = (next: string) => {
    pendingRef.current = next;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const v = pendingRef.current;
      pendingRef.current = null;
      if (v) onChange(v);
    });
  };
  useEffect(() => {
    return () => {
      // Read at cleanup time on purpose: cancels whichever frame is pending.
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Drive the picker: update local HSV + hex draft, then commit (coalesced).
  const commitHsv = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setDraft(hex);
    scheduleCommit(hex);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Pick color"
          className="border-border/70 hover:border-foreground/40 focus-visible:ring-ring/40 inline-flex h-7 items-center gap-2 border bg-transparent pr-2 pl-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <span
            aria-hidden
            className="border-border/60 inline-block size-5 border"
            style={{ background: safeValue }}
          />
          <span className="text-muted-foreground font-mono uppercase">{safeValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56 gap-2.5 p-2.5">
        <SaturationArea hsv={hsv} onChange={(s, v) => commitHsv({ ...hsv, s, v })} />
        <HueSlider hue={hsv.h} onChange={(h) => commitHsv({ ...hsv, h })} />
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="border-border/60 size-8 shrink-0 border"
            style={{ background: HEX6_RE.test(draft) ? draft : safeValue }}
          />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
              setDraft(v);
              if (HEX6_RE.test(v)) {
                setHsv(hexToHsv(v));
                onChange(v);
              }
            }}
            onBlur={() => {
              if (!isValid) setDraft(safeValue);
            }}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-8 px-2 font-mono text-[11.5px] uppercase"
            placeholder="#000000"
            aria-label="Hex color"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
