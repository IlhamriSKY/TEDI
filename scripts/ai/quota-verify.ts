/**
 * Self-check: a spent quota fails fast instead of being retried as a rate limit.
 * Run: `npx tsx scripts/ai/quota-verify.ts`.
 */
import { quotaExhausted, withStreamIdleTimeout } from "../../src/modules/ai/lib/httpProxy";
import { APICallError } from "ai";
import { classifyError, TediErrorCode } from "../../src/modules/ai/lib/errors";
import { acceptsForcedToolChoice } from "../../src/modules/ai/config";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// The ChatGPT-account shape actually observed ("Failed after 3 attempts").
const chatgpt = await quotaExhausted(
  res(429, {
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      resets_in_seconds: 5400,
    },
  }),
);
assert(chatgpt !== null, "ChatGPT usage_limit_reached is a quota, not a rate limit");
assert(!!chatgpt && chatgpt.includes("1h 30m"), "and names when it resets");
assert(
  !!chatgpt && classifyError(new Error(chatgpt)) !== TediErrorCode.RATE_LIMITED,
  "its message is not classified as retryable",
);

assert(
  (await quotaExhausted(
    res(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
  )) !== null,
  "OpenAI insufficient_quota",
);
assert(
  (await quotaExhausted(
    res(403, {
      error: { message: "Budget pool quota has been exhausted. Please ask an administrator" },
    }),
  )) !== null,
  "a new-api gateway's exhausted budget pool (seen on AgentRouter)",
);
assert(
  (await quotaExhausted(res(402, { error: { message: "Insufficient Balance" } }))) !== null,
  "DeepSeek's insufficient balance",
);

assert(
  (await quotaExhausted(res(429, { error: { message: "Rate limit reached, retry in 2s" } }))) ===
    null,
  "a plain rate limit is left to the normal retry",
);
assert((await quotaExhausted(res(200, "ok"))) === null, "a success is never a quota");
assert((await quotaExhausted(res(500, "usage_limit_reached"))) === null, "only 429/402/403 count");

// A connection that drops before any response is safe to resend, and the SDK
// only retries a retryable APICallError. The user's Stop must never be retried.
{
  const dropped = withStreamIdleTimeout((async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch);
  const err = await dropped("https://x/v1/chat/completions", {}).catch((e: unknown) => e);
  assert(APICallError.isInstance(err) && err.isRetryable, "a dropped connection is retryable");

  const ac = new AbortController();
  ac.abort();
  const stopped = withStreamIdleTimeout((async () => {
    throw new DOMException("aborted", "AbortError");
  }) as unknown as typeof fetch);
  const e2 = await stopped("https://x/v1/chat/completions", { signal: ac.signal }).catch(
    (e: unknown) => e,
  );
  assert(!APICallError.isInstance(e2), "a user abort is not turned into a retry");
}

// DeepSeek's thinking mode 400s on any forced tool_choice, which failed every
// forced fan-out and every sub-agent's first step on SumoPod deepseek-v4-flash.
assert(!acceptsForcedToolChoice("deepseek-v4-flash"), "deepseek is never forced");
assert(!acceptsForcedToolChoice("deepseek/deepseek-v4-pro"), "nor behind a gateway prefix");
assert(acceptsForcedToolChoice("gpt-5.6-sol"), "other models still are");

console.log(failed === 0 ? "\nAll quota checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
