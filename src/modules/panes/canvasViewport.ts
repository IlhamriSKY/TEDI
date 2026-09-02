/**
 * Canvas viewport geometry: the pure maths behind panning, zooming, culling and
 * the minimap. No React, no DOM, so it is testable on its own - which matters
 * because one of these rules is what stops terminals vanishing.
 *
 * ONE mapping underpins all of it. The window layer is box-sized and drawn as
 * `translate(x%, y%) scale(zoom)` with a top-left origin, so a point at canvas
 * coordinate `p` lands at box-percentage `x + p * zoom`. Invert that and the
 * visible slice of canvas is `(-x/zoom)` wide by `(100/zoom)`.
 *
 * Coordinates are percentages of the box at zoom 1, and the space is UNBOUNDED:
 * a window may sit at -300 or 900. Nothing here clamps to 0..100.
 */

/** Where the canvas is being looked at from. */
export type Viewport = { zoom: number; x: number; y: number };

/** An axis-aligned box in canvas coordinates. */
export type Box = { x: number; y: number; w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The slice of canvas currently on screen. */
export function viewportBox(view: Viewport): Box {
  return {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    w: 100 / view.zoom,
    h: 100 / view.zoom,
  };
}

/** Bounding box of everything placed, or one screenful when nothing is. */
export function contentBounds(rects: readonly Box[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * Should this window stay LIVE?
 *
 * The reason this exists, and why it is tested: a terminal holds a WebGL context
 * only while its pane is visible, and Chromium caps live contexts at about 16.
 * Tabs view shows one tab at a time; a canvas showing every pane in the
 * workspace at once blew past that cap, and an evicted context paints BLANK -
 * "the terminal sometimes disappears". Culling to the viewport puts the number
 * of live contexts back under what is actually on screen.
 *
 * Half a viewport of margin on every side, so panning never blinks a pane off
 * and on at the edge and one just out of sight is already warm on arrival.
 */
export function isNearViewport(rect: Box, view: Viewport): boolean {
  const v = viewportBox(view);
  const mx = v.w * 0.5;
  const my = v.h * 0.5;
  return (
    rect.x < v.x + v.w + mx &&
    rect.x + rect.w > v.x - mx &&
    rect.y < v.y + v.h + my &&
    rect.y + rect.h > v.y - my
  );
}

/**
 * Keep the viewport overlapping the content, with half a screen of overscroll on
 * each side so a window can always be dragged out past the current edge.
 * Clamped against the CONTENT, never a fixed frame: the canvas has no edges.
 */
export function clampPan(
  x: number,
  y: number,
  zoom: number,
  bounds: Box,
): { x: number; y: number } {
  const vw = 100 / zoom;
  const vh = 100 / zoom;
  return {
    x: clamp(x, -zoom * (bounds.x + bounds.w + vw / 2), zoom * (1.5 * vw - bounds.x)),
    y: clamp(y, -zoom * (bounds.y + bounds.h + vh / 2), zoom * (1.5 * vh - bounds.y)),
  };
}

/** Zoom about a point given in box percentages, keeping whatever is under it
 *  fixed. Callers pass the CURRENT view, never a captured one. */
export function zoomAbout(
  view: Viewport,
  nextZoom: number,
  atX: number,
  atY: number,
  bounds: Box,
  min: number,
  max: number,
): Viewport {
  const z = clamp(Math.round(nextZoom * 100) / 100, min, max);
  if (z === view.zoom) return view;
  const px = (atX - view.x) / view.zoom;
  const py = (atY - view.y) / view.zoom;
  return { zoom: z, ...clampPan(atX - px * z, atY - py * z, z, bounds) };
}

/** Frame everything with a margin. The "where did my panes go" of a canvas with
 *  no edges; on an untouched one it lands back at 100%. */
export function fitView(bounds: Box, min: number, max: number): Viewport {
  const zoom = clamp(Math.round(Math.min(100 / bounds.w, 100 / bounds.h) * 90) / 100, min, max);
  return {
    zoom,
    x: 50 - (bounds.x + bounds.w / 2) * zoom,
    y: 50 - (bounds.y + bounds.h / 2) * zoom,
  };
}

/**
 * The region a minimap should frame: content plus viewport, padded, then
 * LETTERBOXED to the map's aspect. Without the letterbox a wide, short
 * arrangement is stretched to fill the box and the map stops looking like the
 * canvas, which is the only thing a map is for.
 */
export function mapRegion(content: Box, view: Viewport, aspect: number): Box {
  const v = viewportBox(view);
  const x0 = Math.min(content.x, v.x);
  const y0 = Math.min(content.y, v.y);
  const x1 = Math.max(content.x + content.w, v.x + v.w);
  const y1 = Math.max(content.y + content.h, v.y + v.h);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04;
  let w = Math.max(1, x1 - x0 + pad * 2);
  let h = Math.max(1, y1 - y0 + pad * 2);
  let x = x0 - pad;
  let y = y0 - pad;
  if (w / h > aspect) {
    const want = w / aspect;
    y -= (want - h) / 2;
    h = want;
  } else {
    const want = h * aspect;
    x -= (want - w) / 2;
    w = want;
  }
  return { x, y, w, h };
}
