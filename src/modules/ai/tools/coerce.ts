import { z } from "zod";

/**
 * Some providers serialize nested arg objects as JSON strings or stringify
 * numbers. These coercers normalize each value before zod validates so the
 * model doesn't waste a retry on a validation error.
 */
export function coerceInt(v: unknown): unknown {
  if (v === null) return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && Number.isInteger(n) ? n : v;
  }
  return v;
}

function coerceBool(v: unknown): unknown {
  if (v === null) return undefined;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "") return undefined;
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return v;
}

/**
 * Coerce loose model input into ARRAY shape before zod validates. Models
 * routinely send a bare value where the schema wants a list (`glob: "**\/*.ts"`),
 * and the SDK then rejects the call with `expected: array`, which can cascade
 * into a "service error" before the model gets to retry. Rules:
 *   - null / "" -> undefined (let `.optional()` decide)
 *   - already an array -> unchanged
 *   - JSON array/object string -> parsed (object wrapped as a single element)
 *   - any other non-empty string -> single-element array, trimmed; split on
 *     NEWLINES only (never commas - a glob brace `{a,b}` legitimately has them)
 *   - any other scalar/object -> wrapped as a single element
 */
function coerceArray(v: unknown): unknown {
  // null/undefined pass through as undefined so `.optional()` stays happy and a
  // required array still fails (an omitted optional `glob` must NOT become
  // `[undefined]`, which would reject every glob-less grep/list_directory call).
  if (v == null) return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Not valid JSON; fall through to scalar handling.
      }
    }
    const lines = trimmed
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.length > 1 ? lines : [trimmed];
  }
  return [v];
}

/**
 * Upper bound for the small non-negative integers TEDI tools take: pane, tab and
 * leaf ids, shell handles, ordinals, line offsets.
 *
 * BOUNDS ARE TOKENS, NOT DECORATION. Zod renders a bare `z.number().int()` with
 * the full safe-integer range, so every unbounded field ships
 * `"minimum":-9007199254740991,"maximum":9007199254740991` - 55 characters that
 * tell the model nothing, on every tool that takes one, on every request.
 *
 * i32 is chosen because it is unreachable for all of them, not merely generous:
 * ids come from one monotonic in-process counter, and no file has two billion
 * lines. A bound must stay unreachable - a rejected value comes back to the model
 * as a tool-error it has to spend a step correcting, so a bound that a real call
 * could exceed trades 55 characters for a wasted round trip.
 */
export const PANE_ID_MAX = 2_147_483_647;

/** Optional int that tolerates stringified numbers and explicit null.
 *  Output is `number | undefined`. */
export function flexIntOpt(opts: { min?: number; max?: number } = {}) {
  let inner = z.number().int();
  if (opts.min !== undefined) inner = inner.min(opts.min);
  if (opts.max !== undefined) inner = inner.max(opts.max);
  return z.preprocess(coerceInt, inner.optional());
}

/** Required version of flexIntOpt. */
export function flexIntReq(opts: { min?: number; max?: number } = {}) {
  let inner = z.number().int();
  if (opts.min !== undefined) inner = inner.min(opts.min);
  if (opts.max !== undefined) inner = inner.max(opts.max);
  return z.preprocess(coerceInt, inner);
}

/** Optional boolean. Accepts "true"/"false"/"1"/"0" and null. */
export function flexBoolOpt() {
  return z.preprocess(coerceBool, z.boolean().optional());
}

/** Array schema. Tolerates a JSON string, a bare scalar, or a single object
 *  (all coerced to an array via `coerceArray`). Required variant. */
export function flexArrayReq<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(coerceArray, z.array(item));
}

/** Optional array. null/"" -> undefined; JSON string -> parsed; bare scalar ->
 *  single-element array (see `coerceArray`). */
export function flexArrayOpt<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(coerceArray, z.array(item).optional());
}
