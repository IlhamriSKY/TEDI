/**
 * Self-check for the session goal behind `/goal` and the GoalStrip timer.
 * Run: `npx tsx scripts/ai/goal-verify.ts`.
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
} from "../../src/modules/ai/lib/goal";
import { activeGoalText, useGoalStore } from "../../src/modules/ai/store/goalStore";
import {
  GOAL_DONE_MARKER,
  MAX_GOAL_TURNS,
  armGoalRun,
  disarmGoalRun,
  isGoalRunArmed,
  nextGoalStep,
  settleGoal,
} from "../../src/modules/ai/lib/goalRunner";
import type { UIMessage } from "ai";

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

console.log("\n[runner] the loop only fires when it is armed AND a turn just finished");
{
  const R = "s-run";
  const msg = (role: "user" | "assistant", text: string): UIMessage =>
    ({ id: `${role}-${text}`, role, parts: [{ type: "text", text }] }) as UIMessage;
  const working = [msg("user", "go"), msg("assistant", "did a thing")];

  useGoalStore.getState().setGoal(R, "ship it");
  assert(nextGoalStep(R, working) === null, "an un-armed session never auto-continues");

  armGoalRun(R);
  assert(isGoalRunArmed(R), "arming takes");
  assert(nextGoalStep(R, [msg("user", "go")])?.kind === undefined, "a user tail is not a settle");
  assert(nextGoalStep(R, [])?.kind === undefined, "and neither is an empty thread");
  assert(nextGoalStep(R, working)?.kind === "send", "an assistant tail continues the run");
  // A turn stopped by the step cap ends on tool parts with no closing text. That
  // is the case that most needs continuing, so an empty tail must not stall it.
  const toolOnly = [
    { id: "t", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "grep" }] },
  ] as unknown as UIMessage[];
  assert(nextGoalStep(R, toolOnly)?.kind === "send", "a text-less assistant turn continues too");

  // What the Stop button, Restore and /clear all do: end the RUN while leaving
  // the goal set. A stopped turn still leaves an assistant message at the tail,
  // so without disarming the loop would settle and re-send itself instantly.
  disarmGoalRun(R);
  assert(nextGoalStep(R, working) === null, "disarming stops the loop");
  assert(activeGoalText(R) === "ship it", "and the goal itself is untouched");

  // Clearing the goal must stop the loop even though it is still armed: this is
  // the only thing standing between "/goal clear" and a run that keeps going.
  armGoalRun(R);
  useGoalStore.getState().clearGoal(R);
  assert(nextGoalStep(R, working) === null, "clearing the goal stops the loop");
  assert(!isGoalRunArmed(R), "and disarms it");
}

console.log("\n[runner] the done marker has to be its own line");
{
  const D = "s-done";
  const tail = (text: string): UIMessage[] =>
    [{ id: "a", role: "assistant", parts: [{ type: "text", text }] }] as UIMessage[];

  useGoalStore.getState().setGoal(D, "ship it");
  armGoalRun(D);
  assert(
    !settleGoal(D, tail(`I will print ${GOAL_DONE_MARKER} when I am finished.`)),
    "merely quoting the marker does not end the run",
  );
  assert(isGoalRunArmed(D), "so the run is still armed");
  assert(settleGoal(D, tail(`Built and tested.\n${GOAL_DONE_MARKER}`)), "its own line does");
  assert(activeGoalText(D) === null, "the goal is completed, not just stopped");
  assert(!isGoalRunArmed(D), "and the loop is disarmed");
  assert(!settleGoal(D, tail(GOAL_DONE_MARKER)), "settling a done goal again is a no-op");

  // How models actually write that line. A byte-exact match left every one of
  // these running until the turn budget ran out, with the strip still ticking.
  const decorated = [
    `**${GOAL_DONE_MARKER}**`,
    `\`${GOAL_DONE_MARKER}\``,
    `${GOAL_DONE_MARKER}.`,
    `## ${GOAL_DONE_MARKER}`,
    `- ${GOAL_DONE_MARKER}`,
    `  ${GOAL_DONE_MARKER}  `,
  ];
  for (const line of decorated) {
    const id = `s-done-${line}`;
    useGoalStore.getState().setGoal(id, "ship it");
    armGoalRun(id);
    assert(settleGoal(id, tail(`Done and verified.\n${line}`)), `sign-off "${line}" ends the run`);
  }

  // ...and what must still NOT end it.
  const notDone = [
    `I will print ${GOAL_DONE_MARKER} when I am finished.`,
    `> ${GOAL_DONE_MARKER}`,
    "goal complete",
    `NOT ${GOAL_DONE_MARKER}`,
  ];
  for (const line of notDone) {
    const id = `s-open-${line}`;
    useGoalStore.getState().setGoal(id, "ship it");
    armGoalRun(id);
    assert(!settleGoal(id, tail(`Working on it.\n${line}`)), `"${line}" does NOT end the run`);
    assert(isGoalRunArmed(id), "  (still armed)");
  }
}

console.log("\n[runner] an unattended run is bounded");
{
  const B = "s-budget";
  const working = [
    { id: "a", role: "assistant", parts: [{ type: "text", text: "still going" }] },
  ] as UIMessage[];
  useGoalStore.getState().setGoal(B, "boil the ocean");
  armGoalRun(B);
  let sends = 0;
  for (let i = 0; i < MAX_GOAL_TURNS + 5; i++) {
    const step = nextGoalStep(B, working);
    if (step?.kind === "send") sends++;
    else break;
  }
  assert(sends === MAX_GOAL_TURNS, `it stops after exactly ${MAX_GOAL_TURNS} automatic turns`);
  assert(nextGoalStep(B, working) === null, "and stays stopped once the budget is spent");
  assert(activeGoalText(B) === "boil the ocean", "the goal itself survives, so it can be re-run");
  armGoalRun(B);
  assert(nextGoalStep(B, working)?.kind === "send", "re-arming refills the budget");
}

console.log(failed === 0 ? "\nAll goal checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
