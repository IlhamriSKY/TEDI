/**
 * Run state of TEDI's own agent, PER CHAT SESSION, in the same four words a
 * terminal's AI CLI reports: idle / working / blocking / done.
 *
 * Why a second store rather than `agentMeta`: that one is a SINGLE global field
 * describing the active session only (chatStore says so outright), which is
 * exactly what cannot answer "what is each of my four open chats doing". Each
 * `AiPanePanel` already runs `useChat` for its own session, so it reports from
 * there and this map stays exact for every pane on screen - which is also the
 * set the Board charts.
 *
 * Reusing `AiCliState` is deliberate: the Board's columns, the status colours
 * and the pane-icon tint are all written against those four words, so an agent
 * chat drops into them with no second vocabulary to keep in sync.
 */
import { create } from "zustand";
import type { AiCliState } from "@/modules/terminal/lib/aiCliStatus";

type State = {
  states: Record<string, AiCliState>;
  /** Report a session's state. A no-op when unchanged, so a streaming chat does
   *  not re-render every Board card on each token. */
  report: (sessionId: string, state: AiCliState) => void;
  /** `done` decays to `idle` once the user looks at the chat - the same
   *  contract `acknowledgeAiCli` gives a terminal, so a finished background
   *  chat stays visible until it has actually been seen. */
  acknowledge: (sessionId: string) => void;
  /** Drop a closed pane's entry. */
  forget: (sessionId: string) => void;
};

export const useAiSessionStatus = create<State>((set, get) => ({
  states: {},
  report: (sessionId, state) => {
    if (get().states[sessionId] === state) return;
    set((s) => ({ states: { ...s.states, [sessionId]: state } }));
  },
  acknowledge: (sessionId) => {
    if (get().states[sessionId] !== "done") return;
    set((s) => ({ states: { ...s.states, [sessionId]: "idle" } }));
  },
  forget: (sessionId) => {
    if (!(sessionId in get().states)) return;
    set((s) => {
      const next = { ...s.states };
      delete next[sessionId];
      return { states: next };
    });
  },
}));

/**
 * The four-word state for one chat, from what its `useChat` reports plus the
 * count of tool calls waiting on the user.
 *
 * `done` is the edge case worth spelling out: it is not a status the chat ever
 * reports, it is the WORKING -> QUIET transition, held until acknowledged. That
 * is the whole point of the column - a chat that finished while you were
 * looking somewhere else.
 */
export function deriveAiState(
  chatStatus: "submitted" | "streaming" | "ready" | "error",
  approvalsPending: number,
  wasWorking: boolean,
): AiCliState {
  if (approvalsPending > 0) return "blocking";
  if (chatStatus === "submitted" || chatStatus === "streaming") return "working";
  // An error needs the user exactly as an approval does.
  if (chatStatus === "error") return "blocking";
  return wasWorking ? "done" : "idle";
}
