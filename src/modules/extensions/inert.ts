/**
 * What every method of a disposed context returns. Whatever the live method
 * gave back (nothing, a disposer, a handle, a promise), dead extension code
 * keeps working against it without effect: calling it is a no-op and any
 * property leads back to it (`handle.setValue(...)`). As a promise it REJECTS,
 * so an `await` stops the dead code instead of running on with `undefined`, and
 * host code awaiting an extension handler (an AI tool call, an MCP command)
 * gets an error back instead of hanging until the user presses Stop.
 */
const DEAD: unknown = new Proxy(function dead() {}, {
  get: (_target, key) => {
    if (typeof key === "symbol") return undefined;
    if (key === "then") {
      return (_onFulfilled?: unknown, onRejected?: unknown) => {
        if (typeof onRejected === "function") onRejected(new Error("extension was disabled"));
        return DEAD;
      };
    }
    // A primitive, or `${result}` and string concatenation would throw.
    if (key === "toString" || key === "valueOf") return () => "";
    return DEAD;
  },
  apply: () => DEAD,
});

/**
 * An extension can keep its `ctx` past deactivate (a stray interval, a late
 * promise). Once disposed, every method returns `DEAD`, so such a caller cannot
 * put back a status item or listener that teardown just removed, and the common
 * case, a dead interval calling a void setter, stays silent.
 */
export function inert<T extends object>(obj: T, isDisposed: () => boolean): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "function") {
      out[k] = (...args: unknown[]) =>
        isDisposed() ? DEAD : (v as (...a: unknown[]) => unknown).apply(obj, args);
    } else if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      out[k] = inert(v, isDisposed);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
