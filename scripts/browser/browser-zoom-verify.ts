/**
 * Self-check for the browser pane's zoom stepping (`nextBrowserZoom`).
 * Run: `npx tsx scripts/browser/browser-zoom-verify.ts`.
 *
 * The stepper cannot be index-based, and that is the whole reason this check
 * exists. The pane is a real webview, so its own Ctrl+plus / Ctrl+minus and
 * Ctrl+scroll change the zoom without TEDI ever seeing the keystroke - the page
 * has focus, so nothing reaches the DOM. That means the factor handed to this
 * function is routinely a value that is NOT one of our steps, and an
 * `indexOf(current) + 1` stepper would return -1 + 1 = 0 and silently snap the
 * page to 25%. So:
 *  1. STEPS FROM A KNOWN LEVEL: up and down from 100% land on the neighbours.
 *  2. STEPS FROM BETWEEN LEVELS: an off-grid factor (what the keyboard leaves
 *     behind) moves to the next step in that direction, never past it.
 *  3. CLAMPED: the ends hold instead of walking off the list.
 *  4. ALWAYS MOVES: away from the ends every step changes the value, so a click
 *     is never a no-op.
 *  5. WALKS THE WHOLE LIST: repeated stepping visits every level in order, in
 *     both directions, and settles at the end.
 *  6. FLOAT NOISE: the zoom is read back as a division, so a value that is
 *     0.9999999 rather than 1 must behave as 1 and not step to itself.
 */
import { BROWSER_ZOOM_STEPS, nextBrowserZoom } from "../../src/modules/browser/lib/native";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const steps = [...BROWSER_ZOOM_STEPS] as number[];
const MIN = steps[0];
const MAX = steps[steps.length - 1];

console.log("\nsteps from a known level");
assert(nextBrowserZoom(1, 1) === 1.1, "up from 100% is 110%");
assert(nextBrowserZoom(1, -1) === 0.9, "down from 100% is 90%");
assert(nextBrowserZoom(0.5, 1) === 0.67, "up from 50% is 67%");
assert(nextBrowserZoom(0.5, -1) === 0.33, "down from 50% is 33%");

console.log("\nsteps from BETWEEN levels (what the webview's own hotkeys leave)");
assert(nextBrowserZoom(1.05, 1) === 1.1, "up from an off-grid 105% is 110%");
assert(nextBrowserZoom(1.05, -1) === 1, "down from an off-grid 105% is 100%");
assert(nextBrowserZoom(0.42, 1) === 0.5, "up from an off-grid 42% is 50%");
assert(nextBrowserZoom(0.42, -1) === 0.33, "down from an off-grid 42% is 33%");
assert(nextBrowserZoom(3.7, -1) === 3, "down from an off-grid 370% is 300%");

console.log("\nclamped at both ends");
assert(nextBrowserZoom(MIN, -1) === MIN, "down at the minimum holds");
assert(nextBrowserZoom(MAX, 1) === MAX, "up at the maximum holds");
assert(nextBrowserZoom(0.01, -1) === MIN, "below the minimum resolves to it");
assert(nextBrowserZoom(99, 1) === MAX, "above the maximum resolves to it");
assert(nextBrowserZoom(99, -1) === MAX, "down from above the maximum lands on it");

console.log("\nevery step away from the ends actually moves");
for (const s of steps) {
  if (s !== MAX) assert(nextBrowserZoom(s, 1) > s, `up from ${s} increases`);
  if (s !== MIN) assert(nextBrowserZoom(s, -1) < s, `down from ${s} decreases`);
}

console.log("\nwalks the whole list, in order, and settles");
const up: number[] = [];
let cur = MIN;
for (let i = 0; i < steps.length + 5; i++) {
  const next = nextBrowserZoom(cur, 1);
  if (next === cur) break;
  up.push(next);
  cur = next;
}
assert(cur === MAX, `stepping up from ${MIN} settles at ${MAX}`);
assert(
  JSON.stringify(up) === JSON.stringify(steps.slice(1)),
  "stepping up visits every level exactly once, in order",
);
const down: number[] = [];
cur = MAX;
for (let i = 0; i < steps.length + 5; i++) {
  const next = nextBrowserZoom(cur, -1);
  if (next === cur) break;
  down.push(next);
  cur = next;
}
assert(cur === MIN, `stepping down from ${MAX} settles at ${MIN}`);
assert(
  JSON.stringify(down) === JSON.stringify([...steps].reverse().slice(1)),
  "stepping down visits every level exactly once, in order",
);

console.log("\nfloat noise from reading the zoom back as a division");
assert(nextBrowserZoom(0.9999999, 1) === 1.1, "a hair under 100% still steps up to 110%");
assert(nextBrowserZoom(1.0000001, -1) === 0.9, "a hair over 100% still steps down to 90%");

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`browser-zoom-verify: ${failed} check(s) failed`);
console.log("\nbrowser-zoom-verify: all checks passed");
