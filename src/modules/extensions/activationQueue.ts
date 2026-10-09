/**
 * Per-id bookkeeping behind the extension loader's activate/deactivate.
 *
 * `active` (in loader.ts) is only written once an activation finishes, so on its
 * own a disable that landed mid-load found no record, and the load then
 * completed and left a disabled extension running. Here a run holds a token
 * that `revoke` withdraws; a run that finds its token gone undoes its own work
 * instead of registering. Work for one id never overlaps: a teardown removes
 * registrations by KEY (panel renderer, sidebar section, the module's own
 * deactivate), which would wipe what a parallel activation had just registered.
 *
 * The wait is bounded by `waitMs`: an `activate()` or `deactivate()` that never
 * settles must not wedge that extension (or hot reload, which awaits it) for the
 * rest of the session. Going ahead past a revoked run that is still alive is
 * only safe because the loader disposes its context at revoke time, so its late
 * code can no longer write anything (see `loading` in loader.ts).
 */
export function createActivationQueue(waitMs = 10_000) {
  const tokens = new Map<string, symbol>();
  const tails = new Map<string, Promise<void>>();

  /** Run `body` once everything queued for `id` has settled. */
  async function chain(id: string, body: () => Promise<void>): Promise<void> {
    const previous = tails.get(id);
    const work = (async () => {
      if (previous) await settledOrTimeout(previous, waitMs, id);
      await body();
    })();
    tails.set(id, work);
    try {
      await work;
    } finally {
      if (tails.get(id) === work) tails.delete(id);
    }
  }

  return {
    /** An activation for `id` is wanted and not yet finished. */
    pending: (id: string): boolean => tokens.has(id),
    /** `token` is still the wanted activation for `id`. */
    isCurrent: (id: string, token: symbol): boolean => tokens.get(id) === token,
    /** Withdraw the wanted activation for `id`; it undoes itself when it finishes. */
    revoke: (id: string): void => {
      tokens.delete(id);
    },
    /**
     * Activate: run `fn` for `id` once earlier work has settled. Ignored while an
     * activation for `id` is already wanted; skipped if revoked while waiting.
     */
    async run(id: string, fn: (token: symbol) => Promise<void>): Promise<void> {
      if (tokens.has(id)) return;
      const token = Symbol(id);
      tokens.set(id, token);
      try {
        await chain(id, async () => {
          if (tokens.get(id) === token) await fn(token);
        });
      } finally {
        if (tokens.get(id) === token) tokens.delete(id);
      }
    },
    /** Teardown: run `fn` for `id` in the same chain, so a later `run` waits for it. */
    after: (id: string, fn: () => Promise<void>): Promise<void> => chain(id, fn),
  };
}

async function settledOrTimeout(work: Promise<void>, ms: number, id: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[extensions] ${id}: earlier activation still running after ${ms}ms; going ahead.`,
      );
      resolve();
    }, ms);
  });
  await Promise.race([work.catch(() => {}), timeout]);
  clearTimeout(timer);
}
