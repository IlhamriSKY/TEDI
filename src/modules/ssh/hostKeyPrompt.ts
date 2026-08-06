import { create } from "zustand";
import { confirmHostKey, type SshHostKeyPrompt } from "./bridge";

/** A queued prompt plus what the caller wants done if the user says yes. The
 *  callback is how the fingerprint gets pinned at the moment of trust: only the
 *  code that started the connect knows which saved host this key belongs to. It
 *  runs before the backend hears the answer, so it must not throw or the paused
 *  handshake would be left waiting out its confirm timeout. */
type QueuedPrompt = SshHostKeyPrompt & { onAccept?: () => void };

/**
 * Pending first-connect SSH host-key confirmations. The backend pauses each
 * handshake (no credentials sent yet) and asks the user to verify the server's
 * fingerprint before trusting it; the answer flows back via `confirmHostKey`.
 * Queued so two concurrent first-connects each get their own turn.
 */
type HostKeyPromptState = {
  queue: QueuedPrompt[];
  /** Push a prompt emitted by the backend (deduped by id). */
  enqueue: (prompt: SshHostKeyPrompt, onAccept?: () => void) => void;
  /** Answer a prompt: run the accept hook, tell the backend, drop it. */
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

/**
 * Which saved connections a host-key prompt belongs to, so trusting it pins the
 * key on the right rows. A prompt only names the HOST, and one connect can be
 * dialling several: every hop of a ProxyJump chain plus the target, each with
 * its own saved connection and its own pin.
 *
 * Returns every match rather than the first. Two different saved connections can
 * legitimately point at the same machine (one used as a jump host, one as a
 * target), and they have the same key by definition, so pinning both is the
 * honest answer and spares the other one a prompt it would only answer the same
 * way. No match at all means the prompt is not ours to record.
 */
export function hostKeyOwners(
  promptHost: string,
  target: { host: string; connectionId: string },
  jumps: readonly { host: string; connectionId: string }[],
): string[] {
  const ids = jumps.filter((j) => j.host === promptHost).map((j) => j.connectionId);
  if (target.host === promptHost) ids.unshift(target.connectionId);
  return [...new Set(ids)];
}

export const useHostKeyPrompt = create<HostKeyPromptState>((set, get) => ({
  queue: [],
  enqueue: (prompt, onAccept) =>
    set((s) =>
      s.queue.some((p) => p.promptId === prompt.promptId)
        ? s
        : { queue: [...s.queue, { ...prompt, onAccept }] },
    ),
  resolve: (promptId, accept) => {
    const answered = get().queue.find((p) => p.promptId === promptId);
    // Runs BEFORE the backend is told, so trusting the key is recorded even if
    // the handshake that follows dies (bad password, dropped link).
    if (accept) answered?.onAccept?.();
    void confirmHostKey(promptId, accept).catch(() => {});
    set((s) => ({ queue: s.queue.filter((p) => p.promptId !== promptId) }));
  },
  dismiss: (promptId) => set((s) => ({ queue: s.queue.filter((p) => p.promptId !== promptId) })),
}));
