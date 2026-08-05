/**
 * Self-check for the session goal behind `/goal` and the GoalStrip timer.
 * Run: `npx tsx scripts/goal-verify.ts`.
 *
 * The timer is the part that silently rots, so it is pinned hardest:
 *  1. Elapsed derives from the stored `startedAt`, never from an accumulator,
 *     so a reload or a session switch cannot restart or double-count it.
 *  2. Completing FREEZES the clock. A done goal must keep showing what it took,
 *     not keep counting.
 *  3. A completed goal stops steering the agent - `activeGoalText` returns null
 *     so the system prompt drops it, while the strip still displays it.
 *  4. Goal text is bounded, because it rides in the prompt on every turn.
 */
import {
  GOAL_MAX_CHARS,
  goalElapsed,
  normalizeGoalText,
  type Goal,
} from "../src/modules/ai/lib/goal";
import { activeGoalText, useGoalStore } from "../src/modules/ai/store/goalStore";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

console.log("[normalize] blank is not a goal, whitespace collapses, length is bounded");
assert(normalizeGoalText("") === null, "empty -> null");
assert(normalizeGoalText("   \n\t ") === null, "whitespace only -> null");
assert(
  normalizeGoalText("  ship   the\n release  ") === "ship the release",
  "collapsed and trimmed",
);
assert(normalizeGoalText("x".repeat(GOAL_MAX_CHARS + 500))!.length === GOAL_MAX_CHARS, "capped");
assert(normalizeGoalText("a") === "a", "a one-character goal is still a goal");

console.log("\n[elapsed] measured from startedAt, and frozen once done");
const t0 = 1_000_000;
const running: Goal = { text: "g", startedAt: t0, completedAt: null };
assert(goalElapsed(running, t0 + 5_000) === 5_000, "counts up while active");
assert(goalElapsed(running, t0) === 0, "zero at the instant it was set");
assert(goalElapsed(running, t0 - 9_999) === 0, "a clock that jumped backwards clamps to 0");
const done: Goal = { text: "g", startedAt: t0, completedAt: t0 + 7_000 };
assert(goalElapsed(done, t0 + 7_000) === 7_000, "frozen value is the real duration");
assert(goalElapsed(done, t0 + 999_999) === 7_000, "still frozen much later (not a live clock)");

console.log("\n[store] set / complete / clear");
const S = "s-test";
const store = useGoalStore.getState();
assert(store.setGoal(S, "   ") === null, "a blank goal is refused, not stored");
assert(useGoalStore.getState().bySession[S] === undefined, "and nothing was written");

const set = store.setGoal(S, "make the tool calls cheap");
assert(set !== null && set.completedAt === null, "a fresh goal starts active");
assert(activeGoalText(S) === "make the tool calls cheap", "it reaches the system prompt");

useGoalStore.getState().completeGoal(S);
const after = useGoalStore.getState().bySession[S]!;
assert(after.completedAt !== null, "completing stamps the end");
assert(after.startedAt === set!.startedAt, "completing does NOT move the start");
assert(activeGoalText(S) === null, "a done goal no longer steers the agent");
assert(after.text === set!.text, "but the strip can still show it");

const stamp = after.completedAt;
useGoalStore.getState().completeGoal(S);
assert(
  useGoalStore.getState().bySession[S]!.completedAt === stamp,
  "completing twice is a no-op, not a re-stamp",
);

useGoalStore.getState().clearGoal(S);
assert(useGoalStore.getState().bySession[S] === null, "clear removes it");
assert(activeGoalText(S) === null, "and the prompt drops it");

console.log("\n[store] a session with no goal, and a session id that never existed");
assert(activeGoalText(null) === null, "no session -> no goal");
assert(activeGoalText("s-never") === null, "unknown session -> no goal, no throw");

console.log("\n[store] setting a new goal un-hides a dismissed strip");
useGoalStore.getState().setGoal(S, "first");
useGoalStore.getState().hideStrip(S);
assert(useGoalStore.getState().hidden.has(S), "dismissed");
useGoalStore.getState().setGoal(S, "second");
assert(!useGoalStore.getState().hidden.has(S), "a new goal is worth showing again");
assert(activeGoalText(S) === "second", "and it replaced the old one");

console.log(failed === 0 ? "\nAll goal checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
