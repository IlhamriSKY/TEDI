import { create } from "zustand";
import { confirmHostKey, type SshHostKeyPrompt } from "./bridge";

/**
 * Pending first-connect SSH host-key confirmations. The backend pauses each
 * handshake (no credentials sent yet) and asks the user to verify the server's
 * fingerprint before trusting it; the answer flows back via `confirmHostKey`.
 * Queued so two concurrent first-connects each get their own turn.
 */
type HostKeyPromptState = {
  queue: SshHostKeyPrompt[];
  /** Push a prompt emitted by the backend (deduped by id). */
  enqueue: (prompt: SshHostKeyPrompt) => void;
  /** Answer a prompt: tell the backend, then drop it from the queue. */
  resolve: (promptId: string, accept: boolean) => void;
  /**
   * Drop a prompt from the queue WITHOUT answering the backend, for a handshake
   * that already ended on its own (connect failed, the 120s confirm timeout
   * fired, or the probe was abandoned). The dialog only renders `queue[0]`, so a
   * dead prompt left at the front shadows every later connect's prompt - the
   * exact state that used to require an app restart to clear.
   */
  dismiss: (promptId: string) => void;
};

export const useHostKeyPrompt = create<HostKeyPromptState>((set) => ({
  queue: [],
  enqueue: (prompt) =>
    set((s) =>
      s.queue.some((p) => p.promptId === prompt.promptId) ? s : { queue: [...s.queue, prompt] },
    ),
  resolve: (promptId, accept) => {
    void confirmHostKey(promptId, accept).catch(() => {});
    set((s) => ({ queue: s.queue.filter((p) => p.promptId !== promptId) }));
  },
  dismiss: (promptId) => set((s) => ({ queue: s.queue.filter((p) => p.promptId !== promptId) })),
}));
