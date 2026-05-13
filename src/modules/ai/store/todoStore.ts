import { create } from "zustand";
import {
  deleteTodos as persistDelete,
  loadTodos as persistLoad,
  saveTodos as persistSave,
  type Todo,
} from "../lib/todos";

type TodosState = {
  /** Map of sessionId -> todos. */
  bySession: Record<string, Todo[]>;
  /** Set of sessionIds whose todos were hydrated. */
  hydrated: Set<string>;
  /** Set of sessionIds where the user dismissed the TodoStrip. Resets
   *  automatically when a new todo (unseen id) arrives via setTodos. */
  hidden: Set<string>;
  hydrate: (sessionId: string) => Promise<void>;
  setTodos: (sessionId: string, todos: Todo[]) => void;
  clearSession: (sessionId: string) => Promise<void>;
  hideStrip: (sessionId: string) => void;
  showStrip: (sessionId: string) => void;
};

export const useTodosStore = create<TodosState>((set, get) => ({
  bySession: {},
  hydrated: new Set(),
  hidden: new Set(),

  async hydrate(sessionId) {
    if (get().hydrated.has(sessionId)) return;
    const todos = await persistLoad(sessionId);
    set((s) => {
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: todos },
        hydrated: nextHydrated,
      };
    });
  },

  setTodos(sessionId, todos) {
    // If the agent added a brand-new todo to a hidden session, surface the
    // strip again — the user dismissed yesterday's list, not tomorrow's.
    const prev = get().bySession[sessionId] ?? [];
    const prevIds = new Set(prev.map((t) => t.id));
    const hasNew = todos.some((t) => !prevIds.has(t.id));
    set((s) => {
      const nextHidden = new Set(s.hidden);
      if (hasNew && nextHidden.has(sessionId)) nextHidden.delete(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: todos },
        hidden: nextHidden,
      };
    });
    void persistSave(sessionId, todos);
  },

  async clearSession(sessionId) {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.delete(sessionId);
      const nextHidden = new Set(s.hidden);
      nextHidden.delete(sessionId);
      return { bySession: next, hydrated: nextHydrated, hidden: nextHidden };
    });
    await persistDelete(sessionId);
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

export function getTodos(sessionId: string | null): Todo[] {
  if (!sessionId) return [];
  return useTodosStore.getState().bySession[sessionId] ?? [];
}
