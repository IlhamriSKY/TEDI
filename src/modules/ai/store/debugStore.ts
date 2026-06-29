import { create } from "zustand";

/**
 * In-memory capture of the requests TEDI sends to the provider, for the Debug
 * option (Settings -> Agents -> Advanced & debugging). Filled from the agent
 * loop only while `debugEnabled` is on. No persistence, no `../lib`/`../tools`
 * imports (so the agent can use it without a cycle), and no secrets: API keys
 * and auth headers are never part of a snapshot.
 */
export type DebugCapture = {
  id: string;
  /** Epoch ms when captured. */
  at: number;
  kind: "main" | "subagent";
  sessionId: string | null;
  /** Sub-agent type id when kind === "subagent". */
  subagentType?: string;
  model: { id: string; provider: string; label?: string };
  params: Record<string, unknown>;
  system: string;
  /** The messages array sent to the model (system message included). */
  messages: unknown;
  tools: { name: string; description?: string }[];
};

const MAX_CAPTURES = 30;
let seq = 0;

type DebugState = {
  /** Newest first. */
  captures: DebugCapture[];
  add: (c: Omit<DebugCapture, "id" | "at">) => void;
  clear: () => void;
};

export const useDebugStore = create<DebugState>((set) => ({
  captures: [],
  add: (c) =>
    set((s) => {
      const entry: DebugCapture = { ...c, id: `dbg-${++seq}`, at: Date.now() };
      const next = [entry, ...s.captures];
      return { captures: next.length > MAX_CAPTURES ? next.slice(0, MAX_CAPTURES) : next };
    }),
  clear: () => set({ captures: [] }),
}));
