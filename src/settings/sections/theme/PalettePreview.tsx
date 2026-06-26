/**
 * Small palette swatch chip: a colored background plus a strip of accent dots.
 * Shared by the terminal preset cards and the app theme preset cards so both
 * pickers look consistent. Callers pass the representative background and the
 * dot colors (e.g. ANSI hues or theme accents).
 */
export function PalettePreview({
  background,
  dots,
  width = 64,
  height = 28,
}: {
  background: string;
  dots: string[];
  width?: number;
  height?: number;
}) {
  return (
    <div
      aria-hidden
      className="border-border/40 flex shrink-0 items-center gap-[3px] overflow-hidden rounded-[3px] border px-1.5"
      style={{ width, height, background }}
    >
      {dots.map((c, i) => (
        <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
      ))}
    </div>
  );
}
