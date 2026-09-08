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
 * So the same grid, animated instead of measured - and animated DIFFERENTLY per
 * step, because one shared sweep for every tool made the block decorative. The
 * gait is the readout: a file read scans line by line, a grep darts about, a
 * shell command flashes the whole strip at once, a fetch alternates two fields.
 * You can tell what the turn is doing from the corner of your eye, which is the
 * only thing a 22x10 strip beside a clock is good for.
 *
 * It is CSS keyframes with a per-cell delay rather than N animated components,
 * because the whole point is that a cell is a cell - discrete, identical, and
 * cheap enough to leave running for a turn that lasts minutes. A motion is a
 * per-cell PHASE plus a duration plus which of the two keyframes to run, so a
 * new one costs a row in the table below and no new CSS.
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

/** What the block is doing, not which tool is doing it: `stepMotion` in
 *  `modules/ai/lib/stepMotion.ts` maps the step label onto one of these. */
export type PixelMotion =
  | "think"
  | "read"
  | "search"
  | "edit"
  | "write"
  | "delete"
  | "run"
  | "net"
  | "spawn"
  | "plan"
  | "wait";

type Motion = {
  /** WHEN this cell lights, as a fraction of one cycle, 0 = first. Values are
   *  taken mod 1, so a motion whose far corner lands on exactly 1 wraps onto
   *  the near one and the loop has no seam. */
  phase: (x: number, y: number) => number;
  /** One full cycle, seconds. Speed is half of what makes two motions read
   *  apart: a shell command at 0.55s is urgent, a backoff at 1.9s is not. */
  secs: number;
  /** `chase` fades in and out, `blink` snaps - mechanical for the motions that
   *  stand for a discrete act (a keystroke, a command, a deletion). */
  frame: "pixel-chase" | "pixel-blink";
};

/** A fixed permutation, not `Math.random()`: the point of `search` is that
 *  consecutive cells are far apart, and a per-render shuffle would also restart
 *  every cell's animation on every render. Order of lighting is
 *  (0,0) (0,1) (2,0) (2,1) (1,1) (1,0) (3,1) (3,0). */
const SCATTER = [0, 5, 2, 7, 1, 4, 3, 6];

const MOTIONS: Record<PixelMotion, Motion> = {
  // The original sweep, kept for "thinking" and for any tool without a gait of
  // its own: a diagonal is the one that reads as motion at this size without
  // reading as noise.
  think: { phase: (x, y) => (x + y) / 4, secs: 0.9, frame: "pixel-chase" },
  // Row-major, top line then bottom line. Reads as a snake for anything else,
  // which is exactly right for reading two lines of text.
  read: { phase: (x, y) => (y * COLS + x) / 8, secs: 1.05, frame: "pixel-chase" },
  // Darting: a lookup does not travel, it jumps.
  search: { phase: (x, y) => SCATTER[y * COLS + x]! / 8, secs: 0.7, frame: "pixel-chase" },
  // A caret stepping left to right, both rows together and hard-edged.
  edit: { phase: (x) => x / 4, secs: 0.8, frame: "pixel-blink" },
  // The same direction as `edit` but smooth and slower: filling, not typing.
  write: { phase: (x) => x / 4, secs: 1.0, frame: "pixel-chase" },
  // `edit` run backwards. The mirror is the point - it reads as undoing.
  delete: { phase: (x) => (COLS - 1 - x) / 4, secs: 0.75, frame: "pixel-blink" },
  // No phase at all: the whole strip flashes as one, fast. A command either is
  // running or is not.
  run: { phase: () => 0, secs: 0.55, frame: "pixel-blink" },
  // Checkerboard, two fields alternating: traffic, not a head travelling.
  net: { phase: (x, y) => ((x + y) % 2) / 2, secs: 0.6, frame: "pixel-chase" },
  // Out from the centre, so it reads as one thing becoming several.
  spawn: { phase: (x) => Math.abs(x - (COLS - 1) / 2) / 2, secs: 0.9, frame: "pixel-chase" },
  // Row by row, the two rows ticking alternately, like items in a list.
  plan: { phase: (_x, y) => y / 2, secs: 0.85, frame: "pixel-blink" },
  // The whole strip breathing, slowly. Nothing is happening here on purpose:
  // this is the provider's turn, or a backoff.
  wait: { phase: () => 0, secs: 1.9, frame: "pixel-chase" },
};

export function PixelActivity({
  className,
  label = "Working",
  variant = "default",
  motion = "think",
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
  /** Which gait to run. Orthogonal to `variant`: the foil says how hard the
   *  model is thinking, the motion says what it is doing. */
  motion?: PixelMotion;
}) {
  const { phase, secs, frame } = MOTIONS[motion];
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
        // NEGATIVE, so each cell starts already part-way through its cycle: a
        // positive delay leaves a cell at its pre-animation opacity until the
        // delay elapses, so the block would flash fully lit for the first
        // second of every run - exactly when you are looking at it.
        //
        // And the COMPLEMENT of the phase, because a negative delay runs a cell
        // AHEAD: the cell furthest along its cycle is the one that lit most
        // recently, so `1 - phase` is what makes phase 0 the cell you see light
        // first rather than last. Without it every motion runs backwards, which
        // is how the one sweep this replaces travelled right to left while its
        // comment claimed left to right.
        const delay = `${(-(((1 - phase(x, y)) % 1) * secs)).toFixed(3)}s`;
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
            // Name and duration inline, over the class: the class carries what
            // every motion shares (timing function, iteration count, and for
            // `max` the foil layer beside it), and these three are the only
            // things a motion changes. Reduced motion still wins - the global
            // reset clamps `animation-duration` with `!important`.
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
                    // Two animations, two of everything. The gait is offset per
                    // cell so the light travels; the foil gets NO offset and
                    // keeps its own 14s, because a sheet whose cells are out of
                    // phase is not a sheet.
                    animationName: `${frame}, tedi-max-pixel-foil`,
                    animationDuration: `${secs}s, 14s`,
                    animationDelay: `${delay}, 0s`,
                  }
                : { animationName: frame, animationDuration: `${secs}s`, animationDelay: delay }
            }
          />
        );
      })}
    </span>
  );
}
