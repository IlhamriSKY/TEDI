/**
 * Self-check for the AI "still running" clock (formatElapsed).
 * Run: `npx tsx scripts/ai/ai-elapsed-verify.ts`.
 *
 * This string is the whole point of the indicator: it is what tells the user a
 * 90s tool call is running rather than hung. It must stay a stable, whole-second
 * clock - a jittering decimal or a "60s" that never rolls over to minutes reads
 * as broken, and a negative value (clock skew between the tick and the start
 * stamp) must never render.
 */
import { formatElapsed } from "../../src/modules/ai/lib/elapsed";

let failed = 0;
function expect(ms: number, want: string): void {
  const got = formatElapsed(ms);
  if (got !== want) {
    console.error(
      `  FAIL: formatElapsed(${ms}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
    failed++;
  } else {
    console.log(`  ok: ${String(ms).padStart(8)}ms -> ${got}`);
  }
}

console.log("[sub-minute] whole seconds, always rounded DOWN so the clock never runs ahead");
expect(0, "0s");
expect(999, "0s");
expect(1000, "1s");
expect(1999, "1s");
expect(45_400, "45s");
expect(59_999, "59s");

console.log("\n[rollover] 60s becomes 1m, and the seconds are zero-padded so the width is stable");
expect(60_000, "1m 00s");
expect(65_000, "1m 05s");
expect(119_000, "1m 59s");
expect(600_000, "10m 00s");
// The stream idle guard aborts a wedged provider at 5 minutes; the clock has to
// stay readable well past that for a long tool call or a queued fan-out.
expect(3_723_000, "62m 03s");

console.log("\n[guards] a negative delta clamps to zero instead of rendering '-1s'");
expect(-1, "0s");
expect(-60_000, "0s");

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
