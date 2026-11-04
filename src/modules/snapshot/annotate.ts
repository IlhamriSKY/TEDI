/**
 * Numbered marks drawn onto a screenshot, so "number 2" means one exact spot to
 * whoever reads the image, an AI included. They are burned into the pixels because
 * that is the one form every drop target (a terminal CLI, the composer, another app)
 * passes along intact.
 *
 * Coordinates are fractions of the image, so the on-screen canvas and any size it is
 * scaled to agree. The number is the mark's place in the list, so undoing one can
 * never leave a gap.
 */
export type Mark =
  | { kind: "point"; x: number; y: number }
  | { kind: "box"; x: number; y: number; w: number; h: number }
  /** From its numbered tail at (x, y) to its head at (x2, y2). */
  | { kind: "arrow"; x: number; y: number; x2: number; y2: number };

/** What a drag draws. A click is always a number. */
export type DragShape = "box" | "arrow";

export type Fraction = { x: number; y: number };

/** On-screen travel under this is a click, which places a number. */
const DRAG_MIN_PX = 6;
const COLOR = "#ef4444";
const HALO = "#ffffff";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** What a press at `a` released at `b` makes. `shown` is the size on screen, in px. */
export function markFromDrag(
  a: Fraction,
  b: Fraction,
  shown: { w: number; h: number },
  shape: DragShape = "box",
): Mark {
  const x0 = clamp01(a.x);
  const y0 = clamp01(a.y);
  const x1 = clamp01(b.x);
  const y1 = clamp01(b.y);
  const travel = Math.hypot((x1 - x0) * shown.w, (y1 - y0) * shown.h);
  if (travel < DRAG_MIN_PX) return { kind: "point", x: x0, y: y0 };
  if (shape === "arrow") return { kind: "arrow", x: x0, y: y0, x2: x1, y2: y1 };
  return {
    kind: "box",
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** Grows with the image so a number stays readable on a 4K capture and fits a small one. */
export function badgeRadius(w: number, h: number): number {
  return Math.min(28, Math.max(11, Math.max(w, h) * 0.014));
}

type MarkContext = Pick<
  CanvasRenderingContext2D,
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "arc"
  | "fill"
  | "stroke"
  | "strokeRect"
  | "fillText"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "font"
  | "textAlign"
  | "textBaseline"
>;

/** Draws every mark over an image `w` by `h` px. */
export function drawMarks(ctx: MarkContext, w: number, h: number, marks: Mark[]): void {
  const r = badgeRadius(w, h);
  const line = Math.max(2, r * 0.22);
  marks.forEach((m, i) => {
    if (m.kind === "box") {
      const [bx, by, bw, bh] = [m.x * w, m.y * h, m.w * w, m.h * h];
      // White under red, so the box reads on any screenshot, a red one included.
      ctx.strokeStyle = HALO;
      ctx.lineWidth = line + 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.strokeStyle = COLOR;
      ctx.lineWidth = line;
      ctx.strokeRect(bx, by, bw, bh);
    }
    if (m.kind === "arrow") {
      const [ax, ay, tipX, tipY] = [m.x * w, m.y * h, m.x2 * w, m.y2 * h];
      const angle = Math.atan2(tipY - ay, tipX - ax);
      const head = r * 1.3;
      // The shaft stops inside the head, or its square end pokes through the tip.
      const baseX = tipX - Math.cos(angle) * head * 0.8;
      const baseY = tipY - Math.sin(angle) * head * 0.8;
      for (const [color, width] of [
        [HALO, line + 2],
        [COLOR, line],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(baseX, baseY);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      for (const side of [-0.45, 0.45]) {
        ctx.lineTo(tipX - Math.cos(angle + side) * head, tipY - Math.sin(angle + side) * head);
      }
      ctx.closePath();
      ctx.fillStyle = COLOR;
      ctx.fill();
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Kept whole inside the image, or a mark at the edge would lose its number.
    const cx = Math.min(w - r - 1, Math.max(r + 1, m.x * w));
    const cy = Math.min(h - r - 1, Math.max(r + 1, m.y * h));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLOR;
    ctx.fill();
    ctx.strokeStyle = HALO;
    ctx.lineWidth = Math.max(1.5, r * 0.14);
    ctx.stroke();
    ctx.fillStyle = HALO;
    ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), cx, cy);
  });
}
