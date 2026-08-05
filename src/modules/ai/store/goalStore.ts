import { create } from "zustand";
import {
  deleteGoal as persistDelete,
  loadGoal as persistLoad,
  saveGoal as persistSave,
  normalizeGoalText,
  type Goal,
} from "../lib/goal";

/**
 * Per-session goal state. Mirrors `todoStore`: hydrate on demand, keep a
 * `hidden` set so the strip can be dismissed, and hold NO imports from `../lib`
 * beyond the plain persistence module, so the agent loop can read it without a
 * cycle.
 *
 * `buildSystemPrompt` reads this synchronously via `getState()`, which is why
 * `hydrated` is tracked: an un-hydrated session must not look like "no goal".
 */
type GoalState = {
  /** sessionId -> goal, or null when that session has none. */
  bySession: Record<string, Goal | null>;
  hydrated: Set<string>;
  /** sessionIds where the user dismissed the strip. Cleared when a new goal is set. */
  hidden: Set<string>;
  hydrate: (sessionId: string) => Promise<void>;
  /** Set (or replace) the goal. Returns the stored goal, or null if `text` was blank. */
  setGoal: (sessionId: string, text: string) => Goal | null;
  /** Freeze the clock. No-op when there is no goal or it is already done. */
  completeGoal: (sessionId: string) => void;
  clearGoal: (sessionId: string) => void;
  hideStrip: (sessionId: string) => void;
};

export const useGoalStore = create<GoalState>((set, get) => ({
  bySession: {},
  hydrated: new Set(),
  hidden: new Set(),

  async hydrate(sessionId) {
    if (get().hydrated.has(sessionId)) return;
    const goal = await persistLoad(sessionId);
    set((s) => {
      // Re-check inside the setter: a `setGoal` may have landed while the load
      // was in flight, and disk is the older value there.
      if (s.hydrated.has(sessionId)) return s;
      const hydrated = new Set(s.hydrated);
      hydrated.add(sessionId);
      return { bySession: { ...s.bySession, [sessionId]: goal }, hydrated };
    });
  },

  setGoal(sessionId, text) {
    const clean = normalizeGoalText(text);
    if (!clean) return null;
    const goal: Goal = { text: clean, startedAt: Date.now(), completedAt: null };
    set((s) => {
      const hydrated = new Set(s.hydrated);
      hydrated.add(sessionId);
      const hidden = new Set(s.hidden);
      hidden.delete(sessionId);
      return { bySession: { ...s.bySession, [sessionId]: goal }, hydrated, hidden };
    });
    void persistSave(sessionId, goal);
    return goal;
  },

  completeGoal(sessionId) {
    const current = get().bySession[sessionId];
    if (!current || current.completedAt !== null) return;
    const done: Goal = { ...current, completedAt: Date.now() };
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: done } }));
    void persistSave(sessionId, done);
  },

  clearGoal(sessionId) {
    set((s) => {
      const hydrated = new Set(s.hydrated);
      hydrated.add(sessionId);
      return { bySession: { ...s.bySession, [sessionId]: null }, hydrated };
    });
    void persistDelete(sessionId);
  },

  hideStrip(sessionId) {
    set((s) => {
      const hidden = new Set(s.hidden);
      hidden.add(sessionId);
      return { hidden };
    });
  },
}));

/** The goal text the system prompt should carry, or null. Synchronous by
 *  design: the agent loop cannot await here. An un-hydrated session returns
 *  null, which is correct - the strip hydrates on mount, well before a turn. */
export function activeGoalText(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const goal = useGoalStore.getState().bySession[sessionId];
  return goal && goal.completedAt === null ? goal.text : null;
}
