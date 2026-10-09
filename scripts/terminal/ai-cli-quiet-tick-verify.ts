/**
 * The AI-CLI detector re-reads the viewport on a timer. An idle agent pane used
 * to do that four times a second forever; once the state settles it now drops
 * to QUIET_RECLASSIFY_MS, and any PTY event must bring the fast tick straight
 * back so a transition is never slower than before.
 * Run: `npx tsx scripts/terminal/ai-cli-quiet-tick-verify.ts`.
 */
import { createAiCliDetector } from "../../src/modules/terminal/lib/aiCliDetector";

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// A one-timer fake clock: the detector keeps at most one reclassify timer.
let now = 1_000_000;
let pending: { fn: () => void; delay: number } | null = null;
Date.now = () => now;
globalThis.setTimeout = ((fn: () => void, delay: number) => {
  pending = { fn, delay };
  return 1;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = (() => {
  pending = null;
}) as typeof clearTimeout;
function tick(): number {
  const t = pending!;
  pending = null;
  now += t.delay;
  t.fn();
  return pending!.delay;
}

let reads = 0;
const detector = createAiCliDetector({
  onStatus: () => {},
  readBuffer: () => {
    reads++;
    return "";
  },
  isAltScreen: () => true,
  readCursorLine: () => "",
  initialTool: "claude",
});

check(pending!.delay === 250, "a freshly attached agent is classified at the fast cadence");
let delay = 250;
for (let i = 0; i < 20; i++) delay = tick();
check(delay === 2_000, `settled and silent, it slows down (next tick in ${delay} ms)`);

const readsBefore = reads;
for (let i = 0; i < 5; i++) tick();
check(reads - readsBefore === 5, "the quiet cadence still reads the screen, just less often");

detector.pushOutput("x");
check(pending!.delay === 250, "PTY output returns to the fast cadence immediately");
for (let i = 0; i < 20; i++) delay = tick();
detector.pushTitle("anything");
check(pending!.delay === 250, "a title change wakes it too");
for (let i = 0; i < 20; i++) delay = tick();
detector.pushProgress(3, null);
check(pending!.delay === 250, "and an OSC 9;4 progress report");

detector.dispose();
if (failed > 0) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log("\nai-cli-quiet-tick-verify: OK");
