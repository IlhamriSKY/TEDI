/**
 * Structured error codes for AI agent failures. Surfaces enough detail so
 * the UI can show user-friendly messages and developers can trace issues.
 *
 * Error payloads carry a `TediErrorCode` enum + optional `correlationId`
 * that ties back to the originating transport send. Correlation ids are
 * short (8-char hex) and reset per session so they don't leak state.
 */

// Regular (not `const`) enum: `isolatedModules: true` rejects ambient const
// enums across files, and Vite's esbuild loader can't inline them either.
/** Error taxonomy. Add codes here as new failure modes are identified. */
export enum TediErrorCode {
  /** API key missing or empty for the selected provider. */
  NO_API_KEY = "NO_API_KEY",
  /** Provider returned 401/403; key is invalid or expired. */
  AUTH_FAILED = "AUTH_FAILED",
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

/**
 * Classify an HTTP status code or error string into a TediErrorCode.
 * Use this at the provider boundary to normalize errors before surfacing.
 */
export function classifyError(err: unknown): TediErrorCode {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();

  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key"))
    return TediErrorCode.AUTH_FAILED;
  if (msg.includes("403") || msg.includes("forbidden")) return TediErrorCode.AUTH_FAILED;
  if (msg.includes("429") || msg.includes("rate limit")) return TediErrorCode.RATE_LIMITED;
  if (
    msg.includes("5") &&
    (msg.includes("server error") || msg.includes("service") || msg.includes("unavailable"))
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
 * Generate a short correlation id for tracing. 8 hex chars = 4 bytes of
 * entropy, enough to de-duplicate in a single session.
 */
let correlationCounter = 0;
let correlationEpoch = Date.now().toString(36);
export function newCorrelationId(): string {
  correlationCounter++;
  return `${correlationEpoch}-${correlationCounter.toString(16)}`;
}

/** Reset the correlation epoch (call on session switch). */
export function resetCorrelationEpoch(): void {
  correlationEpoch = Date.now().toString(36);
  correlationCounter = 0;
}

/** Human-readable label for each error code (UI chips, toasts). */
export function errorCodeLabel(code: TediErrorCode): string {
  switch (code) {
    case TediErrorCode.NO_API_KEY:
      return "No API key";
    case TediErrorCode.AUTH_FAILED:
      return "Auth failed";
    case TediErrorCode.RATE_LIMITED:
      return "Rate limited";
    case TediErrorCode.PROVIDER_UNAVAILABLE:
      return "Provider unavailable";
    case TediErrorCode.STEP_CAP:
      return "Step limit reached";
    case TediErrorCode.TOOL_REPETITION:
      return "Tool loop detected";
    case TediErrorCode.NO_PROGRESS:
      return "No progress";
    case TediErrorCode.SECURITY_BLOCKED:
      return "Security blocked";
    case TediErrorCode.ABORTED:
      return "Aborted";
    default:
      return "Error";
  }
}

/**
 * Map a raw provider error message to a clearer, actionable one for the chat
 * error card. Falls back to the original message when nothing matches.
 *
 * The image case is the common surprise: a gateway (e.g. SumoPod) returns
 * "No endpoints found that support image input" when the selected model's
 * routing is text-only. There is no client-side fix — the user must pick a
 * vision-capable model — so we say exactly that instead of a raw gateway string.
 */
export function humanizeChatErrorMessage(raw: string): string {
  const msg = raw.toLowerCase();
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
