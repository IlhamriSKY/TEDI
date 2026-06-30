import { create } from "zustand";

/**
 * Live, in-memory status of spawned sub-agents so the user can watch a
 * `run_subagent` / `run_subagents` fan-out as it happens. Updated straight from
 * the tool `execute` (which runs in this same webview) via `getState()` - no
 * persistence, no React import, and crucially NO imports from `../lib` or
 * `../tools`, so wiring it into `tools/subagent.ts` can't create a cycle.
 *
 * Mirrors `todoStore`'s strip conventions: a per-session `hidden` set the user
 * can toggle, auto-revealed when a fresh run starts.
 */
export type SubagentRunStatus = "running" | "done" | "error";

export type SubagentRun = {
  id: string;
  sessionId: string;
  /** Subagent type id: a built-in roster id (comet, nova, odyssey, vega, ...) or a custom `sa-custom-...` id. */
  type: string;
  /** Optional human label from the spawning tool's `description`. */
  label?: string;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  stepCount?: number;
  /** Latest activity label while running (e.g. "Reading …", "Grepping …"). */
  currentStep?: string;
  durationMs?: number;
  error?: string;
  /** Final summary text once done, so the live view can show each subagent's
   *  result the moment it finishes - without waiting for the whole fan-out. */
  summary?: string;
};

/** Keep the per-session list bounded; oldest runs fall off the front. */
const MAX_RUNS_PER_SESSION = 24;

let seq = 0;

type SubagentRunState = {
  /** sessionId -> runs, oldest first. */
  bySession: Record<string, SubagentRun[]>;
  /** sessionIds where the user dismissed the strip. Cleared when a new run starts. */
  hidden: Set<string>;
  /** Register a freshly-spawned subagent. Returns its run id. */
  start: (sessionId: string, info: { type: string; label?: string }) => string;
  /** Mark a run finished with its stats and final summary. */
  finish: (
    sessionId: string,
    id: string,
    patch: { stepCount?: number; durationMs?: number; summary?: string },
  ) => void;
  /** Mark a run failed (or aborted) with a message. */
  fail: (sessionId: string, id: string, error: string) => void;
  /** Update a running run's latest activity label + live step count. */
  step: (sessionId: string, id: string, patch: { currentStep: string; stepCount: number }) => void;
  /** Drop every run for a session (e.g. on session delete). */
  clearSession: (sessionId: string) => void;
  hideStrip: (sessionId: string) => void;
  showStrip: (sessionId: string) => void;
};

function patchRun(
  s: SubagentRunState,
  sessionId: string,
  id: string,
  patch: Partial<SubagentRun>,
): Partial<SubagentRunState> {
  const list = s.bySession[sessionId];
  if (!list) return {};
  return {
    bySession: {
      ...s.bySession,
      [sessionId]: list.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    },
  };
}

export const useSubagentRunStore = create<SubagentRunState>((set) => ({
  bySession: {},
  hidden: new Set(),

  start(sessionId, info) {
    const id = `sa-${++seq}`;
    set((s) => {
      const list = s.bySession[sessionId] ?? [];
      const run: SubagentRun = {
        id,
        sessionId,
        type: info.type,
        label: info.label,
        status: "running",
        startedAt: Date.now(),
      };
      const appended = [...list, run];
      let next = appended;
      if (appended.length > MAX_RUNS_PER_SESSION) {
        // Over the cap: evict OLDEST FINISHED runs first so a long-lived
        // "running" row is never dropped before its finish()/fail() lands
        // (which would make that update a silent no-op). Only fall back to
        // dropping live rows if every slot is occupied by running ones - which
        // the concurrency cap (<= 8) keeps far below MAX_RUNS_PER_SESSION (24),
        // so it is effectively unreachable.
        let over = appended.length - MAX_RUNS_PER_SESSION;
        next = appended.filter((r) => {
          if (over > 0 && r.status !== "running") {
            over -= 1;
            return false;
          }
          return true;
        });
        if (next.length > MAX_RUNS_PER_SESSION) {
          next = next.slice(next.length - MAX_RUNS_PER_SESSION);
        }
      }
      // A new spawn re-reveals a dismissed strip.
      let hidden = s.hidden;
      if (hidden.has(sessionId)) {
        hidden = new Set(hidden);
        hidden.delete(sessionId);
      }
      return { bySession: { ...s.bySession, [sessionId]: next }, hidden };
    });
    return id;
  },

  finish(sessionId, id, patch) {
    set((s) => patchRun(s, sessionId, id, { status: "done", endedAt: Date.now(), ...patch }));
  },

  fail(sessionId, id, error) {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return {};
      const endedAt = Date.now();
      return {
        bySession: {
          ...s.bySession,
          // Record durationMs (from startedAt) so error rows show elapsed time
          // just like done rows do.
          [sessionId]: list.map((r) =>
            r.id === id
              ? { ...r, status: "error", endedAt, durationMs: endedAt - r.startedAt, error }
              : r,
          ),
        },
      };
    });
  },

  step(sessionId, id, patch) {
    set((s) => patchRun(s, sessionId, id, patch));
  },

  clearSession(sessionId) {
    set((s) => {
      if (!(sessionId in s.bySession) && !s.hidden.has(sessionId)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      let hidden = s.hidden;
      if (hidden.has(sessionId)) {
        hidden = new Set(hidden);
        hidden.delete(sessionId);
      }
      return { bySession: next, hidden };
    });
  },

  hideStrip(sessionId) {
    set((s) => {
      if (s.hidden.has(sessionId)) return s;
      const next = new Set(s.hidden);
      next.add(sessionId);
      return { hidden: next };
    });
  },

  showStrip(sessionId) {
    set((s) => {
      if (!s.hidden.has(sessionId)) return s;
      const next = new Set(s.hidden);
      next.delete(sessionId);
      return { hidden: next };
    });
  },
}));
