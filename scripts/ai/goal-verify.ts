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
import { activeGoalText, useGoalStore, type GoalRun } from "../../src/modules/ai/store/goalStore";
import {
  GOAL_DONE_MARKER,
  MAX_GOAL_TURNS,
  armGoalRun,
  beginGoalJudge,
  declaredDone,
  disarmGoalRun,
  goalJudgeInput,
  goalRunStatus,
  isGoalRunArmed,
  markerVerdict,
  nextGoalStep,
  parseGoalVerdict,
  recordGoalVerdict,
  settleGoal,
} from "../../src/modules/ai/lib/goalRunner";
import { useTodosStore } from "../../src/modules/ai/store/todoStore";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const NOT_MET = { met: false, blocked: false, reason: "tests not run" };
const MET = { met: true, blocked: false, reason: "tests pass" };
const msg = (role: "user" | "assistant", text: string, id = `${role}-${text}`): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

console.log("\n[runner] the loop only acts when it is armed AND a turn just finished");
{
  const R = "s-run";
  const working = [msg("user", "go"), msg("assistant", "did a thing")];

  useGoalStore.getState().setGoal(R, "ship it");
  assert(nextGoalStep(R, working) === null, "an un-armed session never auto-continues");

  armGoalRun(R);
  assert(isGoalRunArmed(R), "arming takes");
  assert(nextGoalStep(R, [msg("user", "go")]) === null, "a user tail is not a settle");
  assert(nextGoalStep(R, []) === null, "and neither is an empty thread");

  // The evaluator, not the working model, decides. A finished turn first asks it.
  const ask = nextGoalStep(R, working);
  assert(ask?.kind === "judge", "a finished turn asks the evaluator first");
  beginGoalJudge(R, "assistant-did a thing");
  assert(nextGoalStep(R, working) === null, "and waits while that call is in flight");
  recordGoalVerdict(R, "some-older-message", MET);
  assert(
    nextGoalStep(R, working) === null,
    "a verdict for a message it is not judging is dropped (a resume superseded that call)",
  );
  recordGoalVerdict(R, "assistant-did a thing", NOT_MET);
  const step = nextGoalStep(R, working);
  assert(step?.kind === "send", "a NOT MET verdict continues the run");
  assert(
    step?.kind === "send" && step.text.includes("tests not run"),
    "and the continue prompt carries the evaluator's reason",
  );
  assert(nextGoalStep(R, working) === null, "a verdict is used once, never double-sent");
  assert(useGoalStore.getState().runs[R]?.turns === 1, "the turn is counted");

  // What the strip shows. The turn ceiling is a safety limit, not progress: a
  // goal that was just set has counted nothing, and "turn 0/25" reads as work
  // already underway when none is.
  console.log("\n[strip] the status speaks only once it has something to say");
  const runAt = (turns: number, patch: Partial<GoalRun> = {}): GoalRun => ({
    turns,
    judging: false,
    paused: false,
    reason: null,
    lastSeen: null,
    ...patch,
  });
  assert(goalRunStatus(undefined, false) === null, "a done goal has no run status");
  assert(
    goalRunStatus(undefined, true) === "paused",
    "a goal that is set but not running reads as paused",
  );
  assert(
    goalRunStatus(runAt(0), true) === null,
    "no automatic turn yet -> nothing shown, so there is no 'turn 0/25'",
  );
  assert(
    goalRunStatus(runAt(0, { judging: true }), true) === "checking…",
    "the evaluator still speaks on the first turn: that is real work",
  );
  assert(
    goalRunStatus(runAt(1), true) === `turn 1/${MAX_GOAL_TURNS}`,
    "and the counter appears once it has counted",
  );
  assert(
    goalRunStatus(runAt(4, { paused: true, reason: "blocked" }), true) === "paused",
    "a paused run says so, not the count",
  );
  {
    // Pins the WIRING, not just the helper: re-inlining the counter in the
    // strip would pass the tests above and put 'turn 0/25' back on screen.
    const strip = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/modules/ai/components/GoalStrip.tsx",
      ),
      "utf8",
    );
    assert(
      /goalRunStatus\(run, open\)/.test(strip),
      "the strip renders through that helper rather than its own inline counter",
    );
    assert(!/turn \$\{run\.turns\}/.test(strip), "and no inline 'turn N/M' is left to drift");
  }

  // A turn stopped by the step cap ends on tool parts with no closing text. That
  // is the case that most needs continuing, so an empty tail must not stall it.
  const toolOnly = [
    { id: "t", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "grep" }] },
  ] as unknown as UIMessage[];
  assert(nextGoalStep(R, toolOnly)?.kind === "judge", "a text-less assistant turn is judged too");

  // What /clear and /goal done do: end the RUN while leaving the goal set.
  // (Stop and Restore PAUSE it instead - see the pause checks below.)
  disarmGoalRun(R);
  assert(nextGoalStep(R, working) === null, "disarming stops the loop");
  assert(activeGoalText(R) === "ship it", "and the goal itself is untouched");

  // Clearing the goal must stop the loop even though it is still armed.
  armGoalRun(R);
  useGoalStore.getState().clearGoal(R);
  assert(nextGoalStep(R, working) === null, "clearing the goal stops the loop");
  assert(!isGoalRunArmed(R), "and disarms it");
}

console.log("\n[runner] the evaluator's verdict decides, and open todos overrule it");
{
  const V = "s-verdict";
  const tail = [msg("assistant", "all done", "a1")];
  useGoalStore.getState().setGoal(V, "ship it");
  armGoalRun(V);
  assert(nextGoalStep(V, tail)?.kind === "judge", "asks");
  beginGoalJudge(V, "a1");
  recordGoalVerdict(V, "a1", MET);
  assert(nextGoalStep(V, tail)?.kind === "done", "MET completes the goal");
  assert(activeGoalText(V) === null, "the goal is completed, not just stopped");
  assert(!isGoalRunArmed(V), "and the loop is disarmed");

  const T = "s-todos";
  useGoalStore.getState().setGoal(T, "ship it");
  useTodosStore.getState().setTodos(T, [
    { id: "1", title: "write tests", status: "completed" },
    { id: "2", title: "run tests", status: "in_progress" },
  ]);
  armGoalRun(T);
  const gated = nextGoalStep(T, [msg("assistant", `done\n${GOAL_DONE_MARKER}`, "b1")]);
  assert(gated?.kind === "send", "open todos skip the evaluator and continue");
  assert(
    gated?.kind === "send" && gated.text.includes("run tests"),
    "and the continue prompt lists the open todo",
  );
  assert(activeGoalText(T) === "ship it", "a sign-off line cannot complete it past an open todo");
  beginGoalJudge(T, "b2");
  recordGoalVerdict(T, "b2", MET);
  assert(
    nextGoalStep(T, [msg("assistant", "done", "b2")])?.kind === "send",
    "even a MET verdict is overruled while a todo is open",
  );

  const B = "s-blocked";
  useGoalStore.getState().setGoal(B, "deploy");
  armGoalRun(B);
  nextGoalStep(B, [msg("assistant", "need the prod key", "c1")]);
  beginGoalJudge(B, "c1");
  recordGoalVerdict(B, "c1", { met: false, blocked: true, reason: "needs the prod key" });
  const blocked = nextGoalStep(B, [msg("assistant", "need the prod key", "c1")]);
  assert(blocked?.kind === "paused", "BLOCKED pauses instead of nagging the model");
  assert(useGoalStore.getState().runs[B]?.paused === true, "the run shows as paused");
  assert(
    useGoalStore.getState().runs[B]?.reason === "needs the prod key",
    "with the evaluator's reason for the strip",
  );
  assert(activeGoalText(B) === "deploy", "and the goal stays open to resume");

  const E = "s-error";
  useGoalStore.getState().setGoal(E, "ship it");
  armGoalRun(E);
  assert(
    nextGoalStep(E, [msg("assistant", "partial", "d1")], { failed: true })?.kind === "paused",
    "a failed turn pauses the run instead of sending Continue over the error",
  );
  armGoalRun(E);
  assert(isGoalRunArmed(E), "resuming re-arms it");

  // An error before the first token leaves NO assistant message: the thread
  // ends on the user's own prompt. It must still pause, not stay "running".
  const E2 = "s-error-early";
  useGoalStore.getState().setGoal(E2, "ship it");
  armGoalRun(E2);
  assert(
    nextGoalStep(E2, [msg("user", "Continue working", "u1")], { failed: true })?.kind === "paused",
    "a turn that failed before any output pauses too",
  );

  // A turn still waiting on its approval card is not finished.
  const P = "s-pending";
  useGoalStore.getState().setGoal(P, "ship it");
  armGoalRun(P);
  const pending = [
    {
      id: "p1",
      role: "assistant",
      parts: [{ type: "tool-edit", state: "approval-requested", approval: { id: "x" } }],
    },
  ] as unknown as UIMessage[];
  assert(nextGoalStep(P, pending) === null, "a turn waiting on an approval card is not judged");
}

console.log("\n[runner] a PAUSED goal still closes on a newer sign-off, not on the judged one");
{
  const Q = "s-paused";
  useGoalStore.getState().setGoal(Q, "ship it");
  armGoalRun(Q);
  const judged = [msg("assistant", `done\n${GOAL_DONE_MARKER}`, "j1")];
  nextGoalStep(Q, judged);
  beginGoalJudge(Q, "j1");
  recordGoalVerdict(Q, "j1", { met: false, blocked: true, reason: "needs a token" });
  assert(nextGoalStep(Q, judged)?.kind === "paused", "the evaluator ruled BLOCKED");
  assert(
    !settleGoal(Q, judged),
    "the sign-off on the message it judged does not override the evaluator",
  );
  const later = [
    ...judged,
    msg("user", "here is the token"),
    msg("assistant", `works\n${GOAL_DONE_MARKER}`, "j2"),
  ];
  assert(settleGoal(Q, later), "a sign-off on a NEWER message closes the paused goal");
  assert(activeGoalText(Q) === null, "and the clock stops");
  assert(useGoalStore.getState().runs[Q] === undefined, "and the run is dropped");
}

console.log("\n[runner] a hand-driven goal still closes on its own sign-off line");
{
  const tail = (text: string): UIMessage[] => [msg("assistant", text, "h")];
  const D = "s-done";
  useGoalStore.getState().setGoal(D, "ship it");
  assert(
    !settleGoal(D, tail(`I will print ${GOAL_DONE_MARKER} when I am finished.`)),
    "merely quoting the marker does not end it",
  );
  assert(settleGoal(D, tail(`Built and tested.\n${GOAL_DONE_MARKER}`)), "its own line does");
  assert(activeGoalText(D) === null, "the goal is completed");
  assert(!settleGoal(D, tail(GOAL_DONE_MARKER)), "settling a done goal again is a no-op");

  const A = "s-armed";
  useGoalStore.getState().setGoal(A, "ship it");
  armGoalRun(A);
  assert(!settleGoal(A, tail(`done\n${GOAL_DONE_MARKER}`)), "an ARMED run is the evaluator's call");

  // A sign-off in its own text part must stay its own line.
  const split = [
    {
      id: "p",
      role: "assistant",
      parts: [
        { type: "text", text: "Build passed." },
        { type: "text", text: GOAL_DONE_MARKER },
      ],
    },
  ] as unknown as UIMessage[];
  assert(markerVerdict(split).met, "a marker opening its own part still counts");

  const decorated = [
    `**${GOAL_DONE_MARKER}**`,
    `\`${GOAL_DONE_MARKER}\``,
    `${GOAL_DONE_MARKER}.`,
    `## ${GOAL_DONE_MARKER}`,
    `- ${GOAL_DONE_MARKER}`,
    `  ${GOAL_DONE_MARKER}  `,
  ];
  for (const line of decorated) {
    assert(declaredDone(`Done and verified.\n${line}`), `sign-off "${line}" counts`);
  }
  const notDone = [
    `I will print ${GOAL_DONE_MARKER} when I am finished.`,
    `> ${GOAL_DONE_MARKER}`,
    "goal complete",
    `NOT ${GOAL_DONE_MARKER}`,
  ];
  for (const line of notDone) {
    assert(!declaredDone(`Working on it.\n${line}`), `"${line}" does NOT count`);
  }
}

console.log("\n[judge] the evaluator's reply is parsed strictly");
{
  const v = (t: string) => parseGoalVerdict(t);
  assert(v("MET: tests pass (12/12)")?.met === true, "MET");
  assert(v("NOT MET: build fails")?.met === false, "NOT MET is not MET");
  assert(v("NOT MET: build fails")?.reason === "build fails", "reason kept");
  assert(v("**NOT MET**: no evidence")?.met === false, "bolded");
  assert(v("BLOCKED: needs a token")?.blocked === true, "BLOCKED");
  assert(v("Thinking...\nMET - verified by read-back")?.met === true, "on a later line");
  assert(v("The goal is not met yet") === null, "prose is not a verdict");
  assert(v("") === null, "empty is not a verdict");

  const J = "s-judge";
  const long = Array.from({ length: 40 }, (_, i) =>
    msg(i % 2 ? "assistant" : "user", "x".repeat(2000), `m${i}`),
  );
  const input = goalJudgeInput(J, "ship it", long);
  assert(input.length < 16_000, "the evaluator input is bounded");
  assert(input.includes("<goal>\nship it\n</goal>"), "and carries the goal");
}

console.log("\n[runner] an unattended run is bounded");
{
  const B = "s-budget";
  useGoalStore.getState().setGoal(B, "boil the ocean");
  armGoalRun(B);
  let sends = 0;
  for (let i = 0; i < MAX_GOAL_TURNS + 5; i++) {
    const tail = [msg("assistant", "still going", `t${i}`)];
    if (nextGoalStep(B, tail)?.kind !== "judge") break;
    beginGoalJudge(B, `t${i}`);
    recordGoalVerdict(B, `t${i}`, NOT_MET);
    if (nextGoalStep(B, tail)?.kind === "send") sends++;
    else break;
  }
  assert(sends === MAX_GOAL_TURNS, `it stops after exactly ${MAX_GOAL_TURNS} automatic turns`);
  assert(!isGoalRunArmed(B), "and pauses once the budget is spent");
  assert(activeGoalText(B) === "boil the ocean", "the goal itself survives, so it can be resumed");
  armGoalRun(B);
  assert(nextGoalStep(B, [msg("assistant", "x", "z")])?.kind === "judge", "resuming refills it");
}

console.log("\n[composer] an approved tool is the SDK's send, not a settle");
{
  // The captured shape: the user approved focus_pane, the part is responded but
  // has no output yet. The goal loop saw an assistant tail + `idle` status and
  // sent "Continue" 52 ms after the SDK's own continuation, duplicating the turn.
  const approved = [
    {
      id: "a",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-focus_pane",
          toolCallId: "c1",
          state: "approval-responded",
          input: { leafId: 4 },
          approval: { id: "ap1", approved: true },
        },
      ],
    },
  ] as unknown as UIMessage[];
  assert(
    lastAssistantMessageIsCompleteWithApprovalResponses({ messages: approved }),
    "the SDK will auto-send this tail",
  );
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/modules/ai/lib/composer.tsx"),
    "utf8",
  );
  const gate = src.indexOf("lastAssistantMessageIsCompleteWithApprovalResponses({ messages");
  assert(
    gate !== -1 &&
      gate < src.indexOf("consumeNextQueuedPrompt(sessionId)") &&
      gate < src.indexOf("nextGoalStep(sessionId"),
    "the composer checks it before the queue and the goal can send",
  );
}

console.log(failed === 0 ? "\nAll goal checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
