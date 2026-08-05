import type { UIMessage } from "ai";
import { activeGoalText, useGoalStore } from "../store/goalStore";

/**
 * Drives a `/goal` to completion instead of only whispering it into the system
 * prompt. `/goal <text>` ARMS a session: every time the agent settles, the
 * composer asks here for the next step and keeps sending until the model
 * declares the goal met (or the ceiling, the user, or `/goal clear` stops it).
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
 * leaves the goal standing and the loop off until the user re-runs `/goal`.
 */

/** The exact line the model ends on when the goal is met. Mirrored in the
 *  SESSION GOAL block of the system prompt; changing one means changing both. */
export const GOAL_DONE_MARKER = "GOAL COMPLETE";

/**
 * Ceiling on unattended turns for one goal. A wrong-but-confident model can
 * otherwise burn a key overnight. Hit it and the loop stops with the goal still
 * standing, so the user can read the thread and re-arm with `/goal`.
 */
export const MAX_GOAL_TURNS = 25;

const CONTINUE_PROMPT = `Continue working toward the session goal. Do not ask whether to proceed and do not summarize what you would do next - do the next step. When the goal is fully met and verified, end your message with the line ${GOAL_DONE_MARKER}.`;

/** sessionId -> auto turns already spent. PRESENCE means "armed". */
const armed = new Map<string, number>();

/** `/goal <text>` starts a run. Also resets the turn budget for a re-run. */
export function armGoalRun(sessionId: string): void {
  armed.set(sessionId, 0);
}

/** `/goal done`, `/goal clear`, and the ceiling all land here. */
export function disarmGoalRun(sessionId: string): void {
  armed.delete(sessionId);
}

export function isGoalRunArmed(sessionId: string | null): boolean {
  return sessionId !== null && armed.has(sessionId);
}

/** True when a turn just finished. Deliberately does NOT require text: a turn
 *  stopped by the step cap ends on tool parts alone, and that is exactly when
 *  continuing matters most. */
function endsWithAssistantTurn(messages: UIMessage[]): boolean {
  return messages[messages.length - 1]?.role === "assistant";
}

/** Concatenated text of the last assistant message, or "" if the tail is not
 *  one (the user spoke last, or the thread is empty). */
function lastAssistantText(messages: UIMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return "";
  return last.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

/** True when the model signed off with the marker on its own line. Substring
 *  matching would fire on the model merely QUOTING the instruction. */
function declaredDone(text: string): boolean {
  return text.split("\n").some((line) => line.trim() === GOAL_DONE_MARKER);
}

/**
 * Freeze the goal's clock when the model declared it met. Runs on every settle,
 * armed or not, so a hand-driven goal closes itself too. Idempotent:
 * `completeGoal` is a no-op once `completedAt` is set.
 */
export function settleGoal(sessionId: string | null, messages: UIMessage[]): boolean {
  if (!sessionId || !activeGoalText(sessionId)) return false;
  if (!declaredDone(lastAssistantText(messages))) return false;
  useGoalStore.getState().completeGoal(sessionId);
  disarmGoalRun(sessionId);
  return true;
}

export type GoalStep =
  | { kind: "send"; text: string }
  /** The budget ran out. The caller toasts; the goal stays set. */
  | { kind: "exhausted" }
  | null;

/**
 * The next thing to send to keep an armed goal moving, or null when the loop
 * must not fire: not armed, no live goal, or the thread does not end in a
 * finished assistant turn (nothing has run yet, or the user is mid-exchange).
 */
export function nextGoalStep(sessionId: string | null, messages: UIMessage[]): GoalStep {
  if (!sessionId) return null;
  const spent = armed.get(sessionId);
  if (spent === undefined) return null;
  if (!activeGoalText(sessionId)) {
    disarmGoalRun(sessionId);
    return null;
  }
  // Only ever continue AFTER a completed assistant turn. Without this the loop
  // would also fire on a freshly opened session that merely has a goal on it.
  if (!endsWithAssistantTurn(messages)) return null;
  if (spent >= MAX_GOAL_TURNS) {
    disarmGoalRun(sessionId);
    return { kind: "exhausted" };
  }
  armed.set(sessionId, spent + 1);
  return { kind: "send", text: CONTINUE_PROMPT };
}
