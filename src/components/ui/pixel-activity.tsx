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
 * a diagonal is the one that reads as motion at this size without reading as
 * noise.
 *
 * It is CSS keyframes with a per-cell delay rather than N animated components,
 * because the whole point is that a cell is a cell - discrete, identical, and
 * cheap enough to leave running for a turn that lasts minutes.
 *
 * `bg-current` on purpose: the block inherits whatever colour it is dropped
 * into, so it takes the reasoning level's own ink from a class on the caller
 * without a prop, and reads as muted where no level is set.
 */

/** 2 rows by 4 columns: a 22x10 strip, not a square.
 *
 * Both indicators that draw this sit on one line of text - the status pill is
 * 24 px tall including its border, and the chat's running row is a single
 * 11.5 px line - so a 4x4 block at 22 px touched both edges of each of them. A
 * strip is the height the 12 px glyphs in the pill's other states occupy, which
 * is what makes the running state sit on the same baseline as the rest.
 *
 * Fixed rather than props: both call sites want the same strip, and a knob with
 * one setting is a knob to keep in sync for nothing. */
const ROWS = 2;
const COLS = 4;
/** 4px cell + 2px gap. The `max` variant needs it in JS because each cell has
 *  to shift the shared foil back by its own position in the block. */
const PITCH = 6;
/** One full cycle is spread across the longest diagonal, so the last cell lights
 *  exactly as the first one comes round again and the loop has no seam. On a
 *  2x4 that is 4 steps, and the wave reads as a head travelling left to right
 *  with a one-row lean rather than as a corner-to-corner sweep. */
const SPAN = ROWS + COLS - 2;

export function PixelActivity({
  className,
  label = "Working",
  variant = "default",
}: {
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
  return (
    <span
      className={cn("inline-grid shrink-0 gap-[2px]", className)}
      style={{
        gridTemplateColumns: `repeat(${COLS}, 4px)`,
        // The block's own size, for `.pixel-chase-max` to size the foil's
        // repeating layers to. Left at their default they take the CELL's box,
        // which is 4px - smaller than every period in the sheet, so the cells
        // tile one flat crop instead of sampling a prism. Inherited, so the
        // cells read it without eight more inline properties.
        ["--fw" as string]: `${COLS * PITCH - 2}px`,
        ["--fh" as string]: `${ROWS * PITCH - 2}px`,
      }}
      role="status"
      aria-label={label}
    >
      {Array.from({ length: ROWS * COLS }).map((_, i) => {
        const x = i % COLS;
        const y = Math.floor(i / COLS);
        // How far along the diagonal this cell sits, 0 at the top-left corner
        // and 1 at the bottom-right.
        const frac = (x + y) / SPAN;
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
