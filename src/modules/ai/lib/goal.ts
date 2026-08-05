import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * A session goal: one standing objective the agent keeps in view for the whole
 * session, plus the clock the user reads to see how long they have been on it.
 *
 * `startedAt` is stamped once, at set time, and never moved - the elapsed time
 * is derived from it rather than accumulated, so it survives a reload, a
 * hibernated chat, and a restart. `completedAt` freezes that clock instead of
 * deleting the goal, so a finished goal still shows what it took.
 */
export type Goal = {
  text: string;
  /** Epoch ms the goal was set. */
  startedAt: number;
  /** Epoch ms the user marked it done; null while active. */
  completedAt: number | null;
};

const STORE_PATH = "tedi-goals.json";
const goalKey = (sessionId: string) => `goal:${sessionId}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadGoal(sessionId: string): Promise<Goal | null> {
  return (await store.get<Goal>(goalKey(sessionId))) ?? null;
}

export async function saveGoal(sessionId: string, goal: Goal): Promise<void> {
  await store.set(goalKey(sessionId), goal);
}

export async function deleteGoal(sessionId: string): Promise<void> {
  await store.delete(goalKey(sessionId));
}

/** Max characters of goal text. It rides in the system prompt on every turn, so
 *  a pasted essay would be billed for the whole session. */
export const GOAL_MAX_CHARS = 500;

/** Normalize user input. Returns null when there is nothing usable, so callers
 *  can treat "no goal" and "blank goal" the same. */
export function normalizeGoalText(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > GOAL_MAX_CHARS ? t.slice(0, GOAL_MAX_CHARS) : t;
}

/** Elapsed ms for a goal: live while active, frozen once completed. */
export function goalElapsed(goal: Goal, now: number): number {
  return Math.max(0, (goal.completedAt ?? now) - goal.startedAt);
}
