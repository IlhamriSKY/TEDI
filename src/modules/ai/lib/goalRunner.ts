import type { UIMessage } from "ai";
import { activeGoalText, useGoalStore, type GoalRun } from "../store/goalStore";
import { useTodosStore } from "../store/todoStore";
import type { Todo } from "./todos";

/**
 * Drives a `/goal` to completion instead of only whispering it into the system
 * prompt. `/goal <text>` ARMS a session: every time the agent settles, the
 * composer asks here for the next step and keeps sending until the goal is met
 * (or the ceiling, the user, or `/goal clear` stops it).
 *
 * WHO DECIDES "MET". Not the working model. It used to end the run by printing
 * a magic line, which a confident model prints early and a forgetful one never
 * prints. Now, as in Claude Code, Codex and Hermes, every finished turn is
 * checked by an EVALUATOR call (`goalJudge.ts`) that reads the goal, the open
 * todos and the tail of the transcript and answers MET / NOT MET / BLOCKED with
 * a reason. The reason is fed into the next continue prompt, so each turn is
 * steered by what is actually missing. `GOAL COMPLETE` is still asked for: it is
 * evidence the evaluator reads, and the fallback when the evaluator call fails.
 *
 * Open todos are a hard gate checked first, with no model call: a goal cannot
 * be met while the agent's own plan still has work in it.
 *
 * Why the composer and not `onFinish`: the composer already owns the only place
 * that is allowed to auto-send - it waits for `!isBusy`, refuses while an
 * approval is pending, and opens a restore checkpoint first. Re-sending from
 * `onFinish` would bypass all three and could inject a user message on top of a
 * half-answered tool approval.
 *
 * ARMING IS IN-MEMORY, deliberately. A goal survives a restart (it is
 * persisted), but an unattended loop must not: coming back to TEDI and finding
 * it has been talking to itself since yesterday is not a feature. A restart
 * leaves the goal standing and the loop off until the user resumes it.
 */

/** The line the model ends on when it believes the goal is met. Mirrored in the
 *  SESSION GOAL block of the system prompt; changing one means changing both. */
export const GOAL_DONE_MARKER = "GOAL COMPLETE";

/**
 * Ceiling on unattended turns for one run. A wrong-but-confident model can
 * otherwise burn a key overnight. Hit it and the loop pauses with the goal still
 * standing, so the user can read the thread and resume.
 */
export const MAX_GOAL_TURNS = 25;

export type GoalVerdict = { met: boolean; blocked: boolean; reason: string };

/** sessionId -> the verdict for one assistant message. Consumed once, so a
 *  settle effect re-running before the chat flips to busy cannot double-send. */
const verdicts = new Map<string, { messageId: string; verdict: GoalVerdict; used: boolean }>();

const getRun = (sessionId: string): GoalRun | undefined => useGoalStore.getState().runs[sessionId];
const putRun = (sessionId: string, run: GoalRun | null) =>
  useGoalStore.getState().setRun(sessionId, run);

/** `/goal <text>` or a resume starts a run. Also refills the turn budget. */
export function armGoalRun(sessionId: string): void {
  verdicts.delete(sessionId);
  putRun(sessionId, { turns: 0, judging: false, paused: false, reason: null, lastSeen: null });
}

/** Drop the run entirely (`/goal done`, `/goal clear`, `/clear`, delete). */
export function disarmGoalRun(sessionId: string): void {
  verdicts.delete(sessionId);
  putRun(sessionId, null);
}

/** Stop the loop but keep showing why, so the strip can offer Resume. */
export function pauseGoalRun(sessionId: string, reason: string | null): void {
  const run = getRun(sessionId);
  verdicts.delete(sessionId);
  putRun(sessionId, {
    turns: run?.turns ?? 0,
    judging: false,
    paused: true,
    reason,
    lastSeen: run?.lastSeen ?? null,
  });
}

export function isGoalRunArmed(sessionId: string | null): boolean {
  if (sessionId === null) return false;
  const run = getRun(sessionId);
  return !!run && !run.paused;
}

/**
 * What the loop is doing, for the strip and `/goal`'s status. Null when there is
 * nothing worth saying.
 *
 * The turn ceiling is a safety limit, not progress, so it is only worth SHOWING
 * once the loop has counted against it. A goal that was just set has taken no
 * automatic turn, and "turn 0/25" reads as if work is already underway when
 * nothing has happened yet. An evaluator call still speaks at that point: that
 * is real work the user is waiting on.
 */
export function goalRunStatus(run: GoalRun | undefined, open: boolean): string | null {
  if (!open) return null;
  if (!run || run.paused) return "paused";
  if (run.judging) return "checking…";
  return run.turns > 0 ? `turn ${run.turns}/${MAX_GOAL_TURNS}` : null;
}

/** Mark an evaluator call on `messageId` as in flight, so the settle effect
 *  waits for it and only ITS verdict is accepted. */
export function beginGoalJudge(sessionId: string, messageId: string): void {
  const run = getRun(sessionId);
  if (run && !run.paused) putRun(sessionId, { ...run, judging: true, lastSeen: messageId });
}

/** Store the evaluator's verdict for `messageId`. The store update re-runs the
 *  composer's settle effect, which then acts on it. A run disarmed or paused
 *  while the call was in flight stays so, and a verdict from a call a resume
 *  superseded is dropped instead of cutting the new call short. */
export function recordGoalVerdict(
  sessionId: string,
  messageId: string,
  verdict: GoalVerdict,
): void {
  const run = getRun(sessionId);
  if (!run || run.paused || run.lastSeen !== messageId) return;
  verdicts.set(sessionId, { messageId, verdict, used: false });
  putRun(sessionId, { ...run, judging: false });
}

/** True when a turn just finished. Deliberately does NOT require text: a turn
 *  stopped by the step cap ends on tool parts alone, and that is exactly when
 *  continuing matters most. */
function endsWithAssistantTurn(messages: UIMessage[]): boolean {
  return messages[messages.length - 1]?.role === "assistant";
}

/** Text of one message's text parts, parts joined by a NEWLINE: a step that
 *  ends "Build passed." followed by a part opening "GOAL COMPLETE" must stay
 *  two lines, or the line-anchored marker below never matches. */
function messageText(m: UIMessage | undefined): string {
  if (!m) return "";
  return m.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Text of the last assistant message, or "" if the tail is not one. */
function lastAssistantText(messages: UIMessage[]): string {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" ? messageText(last) : "";
}

/**
 * The sign-off line, allowing for how models actually write a line: bolded,
 * fenced in backticks, as a heading or a bullet, with a full stop after it.
 * Still line-anchored, so the marker inside a sentence ("I will print GOAL
 * COMPLETE when done") does not count. Blockquote `>` is deliberately NOT
 * accepted: quoting the instruction back is exactly the shape that misfires.
 *
 * Spells out `GOAL_DONE_MARKER` rather than building itself from it. Drift is
 * caught: `goal-verify.ts` feeds the constant through `settleGoal`.
 */
const DONE_LINE = /^[\s*_`#-]*GOAL\s*COMPLETE[\s*_`.!:]*$/;

export function declaredDone(text: string): boolean {
  return text.split("\n").some((line) => DONE_LINE.test(line));
}

function openTodos(sessionId: string): Todo[] {
  return (useTodosStore.getState().bySession[sessionId] ?? []).filter(
    (t) => t.status !== "completed",
  );
}

/**
 * A goal driven by hand closes itself when the model signs off: no run at all,
 * or a PAUSED run on a message newer than the one it last judged (after Stop or
 * BLOCKED the user carries on by hand and the prompt still asks for the line).
 * An ARMED run is the evaluator's call in `nextGoalStep`, and so is the message
 * a paused run was judged on - its verdict must not be overridden here.
 * Idempotent: `completeGoal` is a no-op once done.
 */
export function settleGoal(sessionId: string | null, messages: UIMessage[]): boolean {
  if (!sessionId || !activeGoalText(sessionId)) return false;
  const run = getRun(sessionId);
  if (run && !run.paused) return false;
  const last = messages[messages.length - 1];
  if (run && last?.id === run.lastSeen) return false;
  if (!declaredDone(lastAssistantText(messages))) return false;
  if (run) disarmGoalRun(sessionId);
  useGoalStore.getState().completeGoal(sessionId);
  return true;
}

export type GoalStep =
  | { kind: "send"; text: string }
  /** Ask the evaluator about this assistant message, then settle again. */
  | { kind: "judge"; messageId: string }
  | { kind: "done" }
  | { kind: "paused"; reason: string }
  /** The budget ran out. The caller toasts; the goal stays set. */
  | { kind: "exhausted" }
  | null;

const CONTINUE_BASE =
  "Continue working toward the session goal. Do not ask whether to proceed and do not summarize what you would do next - do the next step.";

function continuePrompt(reason: string, todos: Todo[]): string {
  const lines = [CONTINUE_BASE];
  if (reason) lines.push(`An independent check says the goal is NOT met yet: ${reason}`);
  if (todos.length) {
    lines.push(
      `Open todos:\n${todos.map((t) => `- [${t.status}] ${t.title}`).join("\n")}\nFinish them, or update the list with todo_write if the plan changed.`,
    );
  }
  lines.push(
    `When the goal is fully met and verified, show the evidence and end your message with the line ${GOAL_DONE_MARKER}.`,
  );
  return lines.join("\n\n");
}

/**
 * The next thing to do for an armed goal, or null when the loop must not act:
 * not armed, no live goal, an evaluator call in flight, or the thread does not
 * end in a finished assistant turn. `failed` = the last turn ended in an error,
 * which pauses the run instead of papering over it with "Continue".
 */
export function nextGoalStep(
  sessionId: string | null,
  messages: UIMessage[],
  opts: { failed?: boolean } = {},
): GoalStep {
  if (!sessionId) return null;
  const run = getRun(sessionId);
  if (!run || run.paused) return null;
  if (!activeGoalText(sessionId)) {
    disarmGoalRun(sessionId);
    return null;
  }
  // A failed turn pauses even when it left NO assistant message: an error before
  // the first token (a 429 after retries, an expired login) ends on the user's
  // own prompt, and checking the tail first kept such a run "running" forever.
  if (opts.failed) {
    const reason = "the last turn failed";
    pauseGoalRun(sessionId, reason);
    return { kind: "paused", reason };
  }
  // Only ever act AFTER a completed assistant turn. Without this the loop would
  // also fire on a freshly opened session that merely has a goal on it.
  if (!endsWithAssistantTurn(messages)) return null;
  // A turn still waiting on an approval card is not finished; judging it would
  // spend the verdict on a message the continuation then keeps extending.
  const tail = messages[messages.length - 1];
  if (tail.parts.some((p) => (p as { state?: string }).state === "approval-requested")) {
    return null;
  }
  if (run.judging) return null;

  const lastId = tail.id;
  const todos = openTodos(sessionId);
  let seen = verdicts.get(sessionId);
  if (!seen || seen.messageId !== lastId) {
    // The deterministic gate needs no model call: open todos mean not met.
    if (!todos.length) return { kind: "judge", messageId: lastId };
    seen = {
      messageId: lastId,
      verdict: {
        met: false,
        blocked: false,
        reason: `${todos.length} todo item${todos.length === 1 ? " is" : "s are"} still open`,
      },
      used: false,
    };
    verdicts.set(sessionId, seen);
  }
  if (seen.used) return null;
  seen.used = true;

  const { verdict } = seen;
  // A todo left open overrules a "met": the plan is the agent's own statement
  // of what the goal takes.
  if (verdict.met && !todos.length) {
    useGoalStore.getState().completeGoal(sessionId);
    disarmGoalRun(sessionId);
    return { kind: "done" };
  }
  if (verdict.blocked) {
    putRun(sessionId, { ...run, lastSeen: lastId });
    pauseGoalRun(sessionId, verdict.reason);
    return { kind: "paused", reason: verdict.reason };
  }
  if (run.turns >= MAX_GOAL_TURNS) {
    putRun(sessionId, { ...run, lastSeen: lastId });
    pauseGoalRun(sessionId, `stopped after ${MAX_GOAL_TURNS} automatic turns`);
    return { kind: "exhausted" };
  }
  putRun(sessionId, {
    ...run,
    turns: run.turns + 1,
    reason: verdict.reason || null,
    lastSeen: lastId,
  });
  return { kind: "send", text: continuePrompt(verdict.reason, todos) };
}

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One tool part as a line of evidence: name, input, and what came back. */
function toolLine(p: Record<string, unknown>): string | null {
  const type = String(p.type ?? "");
  const name =
    type === "dynamic-tool"
      ? String(p.toolName ?? "tool")
      : type.startsWith("tool-")
        ? type.slice(5)
        : null;
  if (!name) return null;
  const input = p.input === undefined ? "" : clamp(JSON.stringify(p.input), 200);
  const out =
    p.errorText != null
      ? `ERROR ${clamp(String(p.errorText), 300)}`
      : p.output === undefined
        ? String(p.state ?? "")
        : clamp(typeof p.output === "string" ? p.output : JSON.stringify(p.output), 400);
  return `[tool ${name}] ${input} -> ${out}`;
}

/**
 * What the evaluator reads: the goal, the open todos, and the tail of the
 * transcript with tool calls and their results, because a claim is only as good
 * as the output behind it. Bounded (keeps the END), so the check stays cheap.
 */
export function goalJudgeInput(sessionId: string, goal: string, messages: UIMessage[]): string {
  const rows: string[] = [];
  for (const m of messages.slice(-8)) {
    const parts: string[] = [];
    for (const p of m.parts as unknown as Record<string, unknown>[]) {
      if (p.type === "text" && typeof p.text === "string") parts.push(clamp(p.text, 3000));
      else {
        const line = toolLine(p);
        if (line) parts.push(line);
      }
    }
    if (parts.length) rows.push(`### ${m.role}\n${parts.join("\n")}`);
  }
  let transcript = rows.join("\n\n");
  if (transcript.length > 14_000) transcript = `…${transcript.slice(-14_000)}`;
  const todos = useTodosStore.getState().bySession[sessionId] ?? [];
  const todoBlock = todos.length
    ? todos.map((t) => `- [${t.status}] ${t.title}`).join("\n")
    : "(none)";
  return `<goal>\n${goal}\n</goal>\n\n<todos>\n${todoBlock}\n</todos>\n\n<transcript>\n${transcript}\n</transcript>`;
}

const VERDICT_LINE = /^[\s*_`#-]*(NOT\s+MET|MET|BLOCKED)\b[\s*_`]*[:\-–]?\s*(.*)$/gim;

/**
 * Parse the evaluator's reply, or null when it did not answer in the format.
 * `last`: take the LAST verdict line - for reasoning text, which often weighs
 * "- MET: ... / - NOT MET: ..." before concluding; the first would be a guess.
 */
export function parseGoalVerdict(text: string, last = false): GoalVerdict | null {
  const all = [...text.matchAll(VERDICT_LINE)];
  const m = last ? all[all.length - 1] : all[0];
  if (!m) return null;
  const kind = m[1].toUpperCase().replace(/\s+/g, " ");
  const reason = m[2].replace(/[*_`]+$/g, "").trim();
  return { met: kind === "MET", blocked: kind === "BLOCKED", reason };
}

/** The verdict to use when the evaluator could not be asked: trust the marker. */
export function markerVerdict(messages: UIMessage[]): GoalVerdict {
  return declaredDone(lastAssistantText(messages))
    ? { met: true, blocked: false, reason: "" }
    : { met: false, blocked: false, reason: "" };
}
