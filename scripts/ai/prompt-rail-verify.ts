/**
 * Self-check for the chat prompt rail's layout across pane sizes and session
 * lengths. Run: `npx tsx scripts/ai/prompt-rail-verify.ts`.
 *
 * The rail is one mark per user prompt down the right edge of the chat, and it
 * has to survive both ends: three prompts in a full-height sidebar, and three
 * hundred in a quarter of a four-way split. The failures are quiet ones - marks
 * strewn down the whole side, or squeezed to a smear nobody can click - so this
 * sweeps the ranges rather than checking a couple of examples.
 */
import {
  fitRail,
  PITCH_MAX,
  PITCH_MIN,
  RAIL_MIN_PX,
  RAIL_SHARE,
} from "../../src/modules/ai/lib/promptRail";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

// Real heights: a maximised sidebar, a half split, a quarter split, a small
// canvas window, and something too short to draw in.
const VIEWPORTS = [900, 600, 420, 260, 160, 60];
const COUNTS = [2, 3, 8, 20, 40, 80, 200, 1000];

console.log("[gates] what does not get a rail");
check("one prompt draws nothing", !fitRail(900, 1).visible);
check("no prompts draw nothing", !fitRail(900, 0).visible);
check("two prompts in a tall chat do", fitRail(900, 2).visible);
check("a chat too short to hold a band draws nothing", !fitRail(60, 20).visible);
check(
  "the cutoff really is RAIL_MIN_PX of band, not of chat",
  fitRail(RAIL_MIN_PX / RAIL_SHARE, 5).visible && !fitRail(RAIL_MIN_PX / RAIL_SHARE - 1, 5).visible,
);

console.log("\n[pitch] a mark is always aimable, and never a stripe down the side");
for (const v of VIEWPORTS) {
  for (const n of COUNTS) {
    const { pitch } = fitRail(v, n);
    if (pitch >= PITCH_MIN && pitch <= PITCH_MAX) continue;
    check(`pitch stays in range at ${v}px / ${n} prompts`, false, pitch);
  }
}
check(`pitch in [${PITCH_MIN}, ${PITCH_MAX}] across every size and length`, true);

console.log("\n[fit] short sessions sit at full pitch, long ones pack down");
check("3 prompts in a 600px chat get the full pitch", fitRail(600, 3).pitch === PITCH_MAX);
check("and do not scroll", !fitRail(600, 3).scrolls);
// 600 * 0.55 = 330px of band; 40 marks is 8.25px each, still under the cap.
const mid = fitRail(600, 40);
check("40 prompts pack tighter than the cap", mid.pitch < PITCH_MAX && mid.pitch > PITCH_MIN, mid);
check("and still fit without scrolling", !mid.scrolls, mid);
check(
  "the band is exactly filled when the pitch is doing the work",
  Math.abs(mid.pitch * 40 - mid.room) < 0.001,
  mid,
);

console.log("\n[overflow] only past the floor does the rail start scrolling");
const long = fitRail(600, 200);
check("200 prompts bottom out at the floor", long.pitch === PITCH_MIN, long);
check("and the rail scrolls to follow the lit mark", long.scrolls, long);
// The whole point of the floor: the crossover is where a mark would go under
// PITCH_MIN, not some arbitrary count.
for (const v of VIEWPORTS) {
  const room = v * RAIL_SHARE;
  if (room < RAIL_MIN_PX) continue;
  const fits = Math.floor(room / PITCH_MIN);
  check(
    `at ${v}px the rail holds ${fits} marks before it has to scroll`,
    !fitRail(v, fits).scrolls && fitRail(v, fits + 1).scrolls,
    { fits, at: fitRail(v, fits), over: fitRail(v, fits + 1) },
  );
}

console.log("\n[monotonic] more prompts never make a mark bigger");
for (const v of VIEWPORTS) {
  let prev = Infinity;
  let broke: unknown = null;
  for (let n = 2; n <= 400; n++) {
    const { pitch } = fitRail(v, n);
    if (pitch > prev + 1e-9) broke = { n, pitch, prev };
    prev = pitch;
  }
  check(`pitch only ever shrinks as prompts arrive (${v}px)`, broke === null, broke);
}

console.log("\n[resize] a pane dragged narrower re-lays the same session");
const before = fitRail(900, 30);
const after = fitRail(300, 30);
check("a shorter chat gives a shorter band", after.room < before.room);
check("and packs the same prompts tighter", after.pitch < before.pitch, { before, after });
check("a chat with no measured height yet draws nothing", !fitRail(0, 30).visible);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
