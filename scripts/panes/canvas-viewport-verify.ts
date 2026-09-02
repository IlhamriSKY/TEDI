/**
 * Canvas viewport geometry. One of these rules is a bug fix, not a nicety:
 *
 * A terminal holds a WebGL context only while its pane is visible, and Chromium
 * caps live contexts at about 16. Tabs view shows one tab at a time, but canvas
 * view shows EVERY pane in the workspace at once - which blew past that cap, and
 * an evicted context paints blank. That is what "the terminal sometimes
 * disappears" was. `isNearViewport` is the cull that puts the number of live
 * contexts back under what is actually on screen, so it earns a test: if it ever
 * starts answering `true` for everything, the bug comes back silently and only
 * on a busy canvas.
 *
 * Run: `npx tsx scripts/panes/canvas-viewport-verify.ts`.
 */
import {
  clampPan,
  contentBounds,
  fitView,
  isNearViewport,
  mapRegion,
  viewportBox,
  zoomAbout,
} from "../../src/modules/panes/canvasViewport";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
    failures++;
  }
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

const HOME = { zoom: 1, x: 0, y: 0 };

console.log("\n[viewport] the one mapping: a point p sits at x + p * zoom");

check("at home the viewport is the unit box", viewportBox(HOME), { x: 0, y: 0, w: 100, h: 100 });
check("zoomed out it covers more canvas", viewportBox({ zoom: 0.5, x: 0, y: 0 }), {
  x: 0,
  y: 0,
  w: 200,
  h: 200,
});
check("panning right moves the slice LEFT", viewportBox({ zoom: 1, x: 30, y: 0 }).x, -30);

console.log("\n[cull] only what is on screen stays live (the WebGL context fix)");

check(
  "a pane in view is live",
  isNearViewport({ x: 10, y: 10, w: 40, h: 40 }, HOME),
  true,
);
check(
  "a pane just past the edge is still warm (half a screen of margin)",
  isNearViewport({ x: 120, y: 10, w: 40, h: 40 }, HOME),
  true,
);
check(
  "a pane far to the right is culled",
  isNearViewport({ x: 400, y: 10, w: 40, h: 40 }, HOME),
  false,
);
check(
  "and far above",
  isNearViewport({ x: 10, y: -400, w: 40, h: 40 }, HOME),
  false,
);
// The whole point: zooming out must bring panes BACK, or the cull would hide
// the very panes an overview exists to show.
check(
  "zooming out brings a distant pane back",
  isNearViewport({ x: 400, y: 10, w: 40, h: 40 }, { zoom: 0.25, x: 0, y: 0 }),
  true,
);
// ...and zooming in must drop the ones that left, or nothing is reclaimed.
check(
  "zooming in drops what left the screen",
  isNearViewport({ x: 80, y: 10, w: 40, h: 40 }, { zoom: 2, x: 0, y: 0 }),
  false,
);

console.log("\n[bounds] an edgeless canvas is framed by its content, not 0..100");

check("negative and far coordinates are included", contentBounds([
  { x: -120, y: -60, w: 40, h: 30 },
  { x: 200, y: 150, w: 40, h: 30 },
]), { x: -120, y: -60, w: 360, h: 240 });
check("nothing placed falls back to one screenful", contentBounds([]), {
  x: 0,
  y: 0,
  w: 100,
  h: 100,
});

console.log("\n[zoom] the point under the cursor stays put");

{
  const b = contentBounds([{ x: 0, y: 0, w: 100, h: 100 }]);
  // The canvas point under box-percentage 25 before must still be there after.
  const before = (25 - HOME.x) / HOME.zoom;
  const after = zoomAbout(HOME, 2, 25, 25, b, 0.25, 2);
  check("anchor holds through a zoom in", near((25 - after.x) / after.zoom, before), true);
  check("and the zoom actually moved", after.zoom, 2);
  check("a no-op zoom returns the same view", zoomAbout(HOME, 1, 50, 50, b, 0.25, 2), HOME);
}

console.log("\n[pan] free, but never off into nowhere");

{
  const b = contentBounds([{ x: 0, y: 0, w: 100, h: 100 }]);
  const far = clampPan(100000, 100000, 1, b);
  check("a huge pan is clamped", far.x <= 150 && far.y <= 150, true);
  const back = clampPan(-100000, -100000, 1, b);
  check("and so is the other way", back.x >= -150 && back.y >= -150, true);
  check("a modest pan is untouched", clampPan(20, -20, 1, b), { x: 20, y: -20 });
}

console.log("\n[fit] framing everything, including what is off in the negatives");

{
  const b = contentBounds([
    { x: -100, y: -100, w: 50, h: 50 },
    { x: 100, y: 100, w: 50, h: 50 },
  ]);
  const v = fitView(b, 0.25, 2);
  // The content centre must land in the middle of the box.
  const cx = b.x + b.w / 2;
  check("content centre lands mid-screen", near(v.x + cx * v.zoom, 50), true);
  check("and it zooms out to reach", v.zoom < 1, true);
}

console.log("\n[map] letterboxed, so the picture matches the canvas");

{
  // A wide, short arrangement. Stretched to a 160x96 box it would misrepresent
  // the layout, so the region is grown on the short axis instead.
  const region = mapRegion({ x: 0, y: 0, w: 400, h: 50 }, HOME, 160 / 96);
  check("region matches the map aspect", near(region.w / region.h, 160 / 96, 0.001), true);
  check("and still contains the content", region.x <= 0 && region.x + region.w >= 400, true);
}

if (failures > 0) throw new Error(`canvas-viewport-verify: ${failures} FAILED`);
console.log("\ncanvas-viewport-verify: OK");
