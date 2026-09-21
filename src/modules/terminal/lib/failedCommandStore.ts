import { create } from "zustand";
import type { FinishedCommand } from "./commandBlocks";

/**
 * The last command that FAILED in each terminal, keyed by leaf id, cleared the
 * moment the next command starts. Drives the pill in the pane that offers to
 * ask the AI why. A store rather than a callback for the same reason as
 * `useTerminalTitles`: the only consumer is the pane itself.
 */
type FailedCommandsState = {
  failed: Record<number, FinishedCommand>;
  setFailed: (leafId: number, cmd: FinishedCommand) => void;
  clear: (leafId: number) => void;
};

export const useFailedCommands = create<FailedCommandsState>((set) => ({
  failed: {},
  setFailed: (leafId, cmd) => set((s) => ({ failed: { ...s.failed, [leafId]: cmd } })),
  clear: (leafId) =>
    set((s) => {
      if (!(leafId in s.failed)) return s;
      const next = { ...s.failed };
      delete next[leafId];
      return { failed: next };
    }),
}));

/**
 * Raised by the pill's "Ask AI". The app shell owns the chat and knows whether
 * a model is configured and whether the leaf is private, so the terminal only
 * says what happened and the shell decides whether to pass it on.
 */
export const ASK_ABOUT_COMMAND_EVENT = "tedi:ai-ask-about-command";

export type AskAboutCommandDetail = {
  leafId: number;
  exitCode: number;
  /** The prompt line through the last line it printed, tail-capped. */
  output: string;
};
