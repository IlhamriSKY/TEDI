import { cn } from "@/lib/utils";

/**
 * "Something is working", drawn as pixels.
 *
 * TEDI already has one vocabulary for small quantities: 4 px square cells with
 * a 2 px gap, lit against a dim track - the status-bar meters draw it, the
 * process monitor's memory chart draws it, and the extension tooltips draw it.
 * A bouncing dot-trio and a spinning circle were a second and a third, in the
 * one place the pixel grid is most visible: right beside the meters.
 *
 * So the same grid, animated instead of measured. The light sweeps DIAGONALLY:
 * a cell's delay comes from `x + y`, so the wave crosses the block corner to
 * corner. Row-major would have read as a snake and a single row as a blink;
 * a diagonal is the one that reads as motion at 22 px without reading as noise.
 *
 * It is CSS keyframes with a per-cell delay rather than N animated components,
 * because the whole point is that a cell is a cell - discrete, identical, and
 * cheap enough to leave running for a turn that lasts minutes.
 *
 * `bg-current` on purpose: the block inherits whatever colour it is dropped
 * into, so it reads as amber in a warning pill and muted in a chat header
 * without a single prop.
 */
export function PixelActivity({
  rows = 4,
  cols = 4,
  className,
  label = "Working",
  variant = "default",
}: {
  /** Grid height in cells. `1` gives the single-row strip an icon slot wants. */
  rows?: number;
  cols?: number;
  className?: string;
  /** Announced to screen readers; the cells themselves are decorative. */
  label?: string;
  /**
   * `max` swaps `currentColor` for the max-effort foil palette, so a turn
   * running at max reads as max wherever it is shown - the same ink as the
   * word in the reasoning picker and the brain icon beside it.
   */
  variant?: "default" | "max";
}) {
  // One full cycle is spread across the longest diagonal, so the last cell lights
  // exactly as the first one comes round again and the loop has no seam.
  const span = Math.max(1, rows + cols - 2);
  // 4px cell + 2px gap. The `max` variant needs it in JS because each cell has
  // to shift the shared foil back by its own position in the block.
  const PITCH = 6;
  return (
    <span
      className={cn("inline-grid shrink-0 gap-[2px]", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, 4px)` }}
      role="status"
      aria-label={label}
    >
      {Array.from({ length: rows * cols }).map((_, i) => {
        const x = i % cols;
        const y = Math.floor(i / cols);
        // How far along the diagonal this cell sits, 0 at the top-left corner
        // and 1 at the bottom-right.
        const frac = (x + y) / span;
        // NEGATIVE, so each cell starts already part-way through its cycle: a
        // positive delay leaves a cell at its pre-animation opacity until the
        // delay elapses, so the block would flash fully lit for the first
        // second of every run - exactly when you are looking at it.
        const chase = `-${(frac * 0.9).toFixed(2)}s`;
        return (
          <span
            key={i}
            aria-hidden
            className={cn(
              "size-1",
              // At max the cell is a WINDOW onto the foil, not a coloured
              // square, so it takes the sheet instead of `bg-current`.
              variant === "max" ? "tedi-foil pixel-chase-max" : "pixel-chase bg-current",
            )}
            style={
              variant === "max"
                ? {
                    // Where this cell sits in the block, negated: the sheet is
                    // anchored to each cell's own box, so shifting it back by
                    // the cell's offset makes all of them sample ONE continuous
                    // foil. Without this every cell shows the same 4px crop,
                    // which at that size is a flat colour.
                    ["--fx" as string]: `${-x * PITCH}px`,
                    ["--fy" as string]: `${-y * PITCH}px`,
                    // Two animations, two delays. The chase is offset per cell
                    // so the light travels; the foil gets NO offset, because a
                    // sheet whose cells are out of phase is not a sheet.
                    animationDelay: `${chase}, 0s`,
                  }
                : { animationDelay: chase }
            }
          />
        );
      })}
    </span>
  );
}
