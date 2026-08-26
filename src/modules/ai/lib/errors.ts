/**
 * Structured error codes for AI agent failures, detailed enough for a friendly
 * UI message and a traceable log. Payloads carry a `TediErrorCode` plus an
 * optional `correlationId` tying back to the transport send: 8-char hex, reset
 * per session so it leaks no state.
 */

// Regular (not `const`) enum: `isolatedModules: true` rejects ambient const
// enums across files, and Vite's esbuild loader can't inline them either.
/** Error taxonomy. Add codes here as new failure modes are identified. */
export enum TediErrorCode {
  /** API key missing or empty for the selected provider. */
  NO_API_KEY = "NO_API_KEY",
  /** Provider returned 401/403; key is invalid or expired. */
  AUTH_FAILED = "AUTH_FAILED",
  /** Provider rejected the request because the prompt exceeded the context window. */
  OVER_CONTEXT = "OVER_CONTEXT",
  /** Provider returned 429 (rate limited). */
  RATE_LIMITED = "RATE_LIMITED",
  /** Provider returned 5xx or network error after retries. */
  PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE",
  /** Agent hit the 15-step cap. */
  STEP_CAP = "STEP_CAP",
  /** Agent repeated the same tool call 3x. */
  TOOL_REPETITION = "TOOL_REPETITION",
  /** Agent produced 2 consecutive text-only steps. */
  NO_PROGRESS = "NO_PROGRESS",
  /** Tool call violated a security guard. */
  SECURITY_BLOCKED = "SECURITY_BLOCKED",
  /** User aborted the agent mid-stream. */
  ABORTED = "ABORTED",
  /** Unknown / unexpected error. See message for details. */
  UNKNOWN = "UNKNOWN",
}

export type TediErrorPayload = {
  code: TediErrorCode;
  /** Human-readable summary suitable for display in the chat error card. */
  message: string;
  /** Short hex id linking back to the transport send. Resets per session. */
  correlationId?: string;
  /** Original error message (for debugging). Not shown to users. */
  detail?: string;
  /** HTTP status code if the error came from a provider response. */
  httpStatus?: number;
  /** True when the error is transient and a retry might succeed. */
  retryable: boolean;
};

/** Factory: create a structured error with a correlation id. */
export function tediError(
  code: TediErrorCode,
  message: string,
  opts: {
    detail?: string;
    httpStatus?: number;
    correlationId?: string;
  } = {},
): TediErrorPayload {
  return {
    code,
    message,
    correlationId: opts.correlationId,
    detail: opts.detail,
    httpStatus: opts.httpStatus,
    retryable: RETRYABLE_CODES.has(code),
  };
}

/** Codes where a retry with backoff is reasonable. */
const RETRYABLE_CODES = new Set<TediErrorCode>([
  TediErrorCode.RATE_LIMITED,
  TediErrorCode.PROVIDER_UNAVAILABLE,
]);

/** Pull an HTTP status off a provider error, walking the SDK's wrappers
 *  (RetryError `.lastError`/`.errors[]`, APICallError `.statusCode`, `.cause`).
 *  The status is the only language-agnostic signal: a non-English 429 body
 *  ("Terlalu banyak penggunaan dalam 1 menit") has nothing for the string
 *  heuristics below to match. */
function extractHttpStatus(err: unknown): number | undefined {
  const seen = new Set<unknown>();
  const visit = (e: unknown): number | undefined => {
    if (!e || typeof e !== "object" || seen.has(e)) return undefined;
    seen.add(e);
    const o = e as Record<string, unknown>;
    for (const k of ["statusCode", "status", "httpStatus"]) {
      const v = o[k];
      if (typeof v === "number" && v >= 100 && v < 600) return v;
    }
    return (
      visit(o.cause) ??
      visit(o.lastError) ??
      (Array.isArray(o.errors)
        ? o.errors.reduce<number | undefined>((acc, e2) => acc ?? visit(e2), undefined)
        : undefined)
    );
  };
  return visit(err);
}

/**
 * Classify an HTTP status code or error string into a TediErrorCode.
 * Use this at the provider boundary to normalize errors before surfacing.
 */
export function classifyError(err: unknown): TediErrorCode {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();

  // HTTP status wins over the string heuristics: it's reliable and works
  // regardless of the provider's error-body language.
  const status = extractHttpStatus(err);
  if (status === 429) return TediErrorCode.RATE_LIMITED;
  if (status === 401 || status === 403) return TediErrorCode.AUTH_FAILED;
  if (status !== undefined && status >= 500) return TediErrorCode.PROVIDER_UNAVAILABLE;

  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key"))
    return TediErrorCode.AUTH_FAILED;
  if (msg.includes("403") || msg.includes("forbidden")) return TediErrorCode.AUTH_FAILED;
  if (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("prompt is too long") ||
    msg.includes("context window exceeded") ||
    msg.includes("input length and max_tokens exceed") ||
    msg.includes("too many tokens") ||
    msg.includes("token limit exceeded") ||
    ((msg.includes("context") || msg.includes("prompt")) &&
      (msg.includes("too large") || msg.includes("too long") || msg.includes("exceed")))
  ) {
    return TediErrorCode.OVER_CONTEXT;
  }
  if (msg.includes("429") || msg.includes("rate limit")) return TediErrorCode.RATE_LIMITED;
  if (
    /\b5\d\d\b/.test(msg) ||
    msg.includes("server error") ||
    msg.includes("internal server") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway timeout") ||
    msg.includes("temporarily unavailable")
  )
    return TediErrorCode.PROVIDER_UNAVAILABLE;
  if (
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("network")
  )
    return TediErrorCode.PROVIDER_UNAVAILABLE;
  if (msg.includes("no api key")) return TediErrorCode.NO_API_KEY;
  if (msg.includes("abort") || msg.includes("cancelled")) return TediErrorCode.ABORTED;

  return TediErrorCode.UNKNOWN;
}

/**
 * Generate a short correlation id for tracing, formatted `<epoch36>-<counterHex>`
 * (variable length, monotonic) — enough to de-duplicate within a session.
 */
let correlationCounter = 0;
let correlationEpoch = Date.now().toString(36);
export function newCorrelationId(): string {
  correlationCounter++;
  return `${correlationEpoch}-${correlationCounter.toString(16)}`;
}

/**
 * Best text available for a provider error thrown mid-stream.
 *
 * `message` is usually enough, but not always: the AI SDK only fills it from
 * the body when the body matches OpenAI's `{ error: { message } }` shape, and
 * otherwise falls back to `Response.statusText` - which the Rust proxy leaves
 * empty, so the message is "". The ChatGPT-account endpoint answers
 * `{"detail": "..."}`, so without this a plain 400 reaches the user blank.
 */
export function describeProviderError(e: unknown): string {
  const err = e as { message?: string; responseBody?: string; statusCode?: number };
  const message = err?.message?.trim();
  if (message) return message;
  const body = err?.responseBody?.trim();
  if (body) {
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } };
      const detail = parsed.detail ?? parsed.error?.message;
      if (typeof detail === "string" && detail.trim()) return detail.trim();
    } catch {
      // Not JSON: the raw body still beats an empty card.
    }
    return body.slice(0, 500);
  }
  return err?.statusCode ? `The provider returned HTTP ${err.statusCode}.` : String(e);
}

/**
 * Map a raw provider error message to a clearer, actionable one for the chat
 * error card. Falls back to the original message when nothing matches.
 *
 * The image case is the common surprise: a gateway answers "No endpoints found
 * that support image input" when the model's routing is text-only. No
 * client-side fix exists, so say "pick a vision model" rather than echo it.
 */
export function humanizeChatErrorMessage(raw: string): string {
  const msg = raw.toLowerCase();
  // The ChatGPT-account endpoint gates its model list by plan and says only
  // this, with no hint that the fix is picking a different model.
  if (msg.includes("not supported when using codex with a chatgpt account")) {
    return `${raw} Pick another ChatGPT model in the model picker - the Codex and Sol models need a Plus or Pro plan, Terra and Luna work on any.`;
  }
  if (
    msg.includes("image input") ||
    (msg.includes("no endpoints") && msg.includes("image")) ||
    msg.includes("does not support image") ||
    msg.includes("vision")
  ) {
    return "This model can't read images on the current provider. Switch to a vision-capable model (e.g. Gemini, Claude, or GPT) or remove the image attachment, then resend.";
  }
  return raw;
}

/**
 * Convert a TediErrorPayload into a user-facing Error that the chat UI can
 * render. Preserves the structured metadata on `.cause`.
 */
export function toChatError(payload: TediErrorPayload): Error & { tediCode: TediErrorCode } {
  const err = new Error(payload.message) as Error & { tediCode: TediErrorCode };
  err.tediCode = payload.code;
  if (payload.correlationId) err.cause = { ...payload };
  return err;
}
