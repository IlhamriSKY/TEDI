/**
 * Where focus lands when the ACTIVE tab closes.
 * Run: `npx tsx scripts/workspace/tab-close-focus-verify.ts` (or `pnpm verify`).
 *
 * Both close paths - the strip's close button (`closeTab`) and closing the last
 * pane inside a tab (`closePaneByLeaf`) - used to activate the LEFT NEIGHBOUR.
 * That reads as reasonable and is wrong in the one case that happens constantly:
 * opening a file APPENDS a tab and activates it, so its left neighbour is
 * whatever happened to be last in the strip. Close the editor and you were not
 * returned to the tab you opened it from - you were thrown to the far end of the
 * strip, further the more tabs you had open.
 *
 * The rule is most-recently-used, like every editor. What is worth pinning here
 * is the part that is easy to get subtly wrong rather than the happy path:
 *
 *   1. The stack outlives the tabs in it. Entries for tabs already closed, or
 *      belonging to another workspace, must be SKIPPED rather than returned -
 *      returning one activates a tab that no longer exists.
 *   2. The tab being closed is itself the newest entry, so it has to be
 *      excluded, or a close would resolve to the tab it just removed.
 *   3. The neighbour fallback still has to work, for a restored workspace whose
 *      stack is empty and for one whose every entry has since been closed.
 */
import { nextActiveAfterClose } from "../../src/modules/tabs/lib/tabHelpers";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (got === want) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[mru] closing the active tab goes back where you came from");
// The report, exactly: working in tab 2, open a file (tab 5, appended and
// activated), close it. The left neighbour is 4; the answer is 2.
check(
  "returns to the tab the editor was opened from",
  nextActiveAfterClose([5, 2, 1], 5, [1, 2, 3, 4], 4),
  2,
);
check(
  "not the left neighbour, which is a tab that was never chosen",
  nextActiveAfterClose([5, 2, 1], 5, [1, 2, 3, 4], 4) === 4,
  false,
);
// Two files opened in a row, both closed: each close unwinds one step.
check(
  "a second close unwinds one more step",
  nextActiveAfterClose([5, 4, 2], 5, [1, 2, 3, 4], 4),
  4,
);
check("and then the one before that", nextActiveAfterClose([4, 2, 1], 4, [1, 2, 3], 3), 2);

console.log("\n[staleness] the stack outlives the tabs in it");
// 4 was closed earlier, so it is still in the stack and must not be chosen:
// activating it would select a tab that does not exist.
check("an id no longer open is skipped", nextActiveAfterClose([5, 4, 2], 5, [1, 2, 3], 3), 2);
check(
  "several dead ids in a row are all skipped",
  nextActiveAfterClose([9, 8, 7, 1], 9, [1, 2], 1),
  1,
);
// Ids from another workspace live in the same stack; membership is what counts.
check(
  "ids belonging to another workspace do not leak in",
  nextActiveAfterClose([5, 77, 88, 2], 5, [1, 2, 3], 2),
  2,
);

console.log("\n[self] the closing tab is the newest entry, and must not be returned");
// The stack always has the closing tab at its head - it was the active one. So
// the property is that no input can make the answer be the tab just removed;
// asserting a particular id here would only be testing the fallback twice.
const selfCases: [number[], number, number[], number][] = [
  [[3, 2, 1], 3, [1, 2], 2],
  [[3], 3, [1, 2], 2],
  [[3, 3, 3], 3, [1, 2], 2], // a stack that somehow repeated
  [[], 3, [1, 2], 0],
];
for (const [mru, closed, remaining, idx] of selfCases) {
  const got = nextActiveAfterClose(mru, closed, remaining, idx);
  check(
    `mru ${JSON.stringify(mru)} closing ${closed} -> ${got}, which is still open and not ${closed}`,
    got !== closed && remaining.includes(got),
    true,
  );
}

console.log("\n[fallback] the neighbour, only when there is nothing to go back to");
check("an empty stack falls back to the left neighbour", nextActiveAfterClose([], 3, [1, 2], 2), 2);
check(
  "a stack of nothing but dead ids falls back too",
  nextActiveAfterClose([3, 99, 98], 3, [1, 2], 2),
  2,
);
// Closing the FIRST tab has no left neighbour; `Math.max(0, ...)` must keep the
// index in range rather than reading past the start.
check("closing the first tab clamps to the new first", nextActiveAfterClose([1], 1, [2, 3], 0), 2);
check(
  "and with a usable stack the first tab still goes back",
  nextActiveAfterClose([1, 3], 1, [2, 3], 0),
  3,
);

console.log(failed === 0 ? "\nAll tab-close-focus checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
