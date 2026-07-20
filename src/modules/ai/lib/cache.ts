import type { ModelMessage } from "ai";
import { findLastIndex } from "@/lib/utils";
import type { ProviderId } from "../config";

/**
 * Provider-aware prompt-cache adapter.
 *
 * Anthropic uses explicit `cacheControl` markers (up to 4). OpenAI, xAI, and
 * DeepSeek do implicit prefix caching at >= 1024 tokens; the system prompt and
 * per-turn <env> placement keep the prefix byte-stable so those hits land.
 * Google's Gemini 2.5+ also has implicit caching; explicit `cachedContent`
 * is skipped because it adds round-trip cost.
 * Third-party gateways (SumoPod and other OpenAI-compatible endpoints): whether
 * the upstream caches is UNVERIFIED and endpoint-specific - the SDK sends no
 * cache hint, so any hit depends entirely on the gateway/model doing automatic
 * prefix caching AND reporting it. Do not assume a discount here; the real
 * defence against re-send cost on these is per-step compaction (see
 * compactStepMessages), not caching.
 * Groq, Cerebras, and LM Studio have no prompt cache.
 *
 * Adding a provider only needs a new case in `applyCacheBreakpoints`.
 */
export function applyCacheBreakpoints(
  messages: ModelMessage[],
  provider: ProviderId,
): ModelMessage[] {
  if (messages.length === 0) return messages;
  switch (provider) {
    case "anthropic":
      return applyAnthropicBreakpoints(messages);
    default:
      // Implicit or unsupported. `buildSystemPrompt` already keeps the
      // prefix byte-stable, so nothing to inject.
      return messages;
  }
}

/**
 * Does this provider cache the prompt prefix at all?
 *
 * Callers use it to decide whether rewriting history mid-turn is worth it:
 * on a caching provider an edit to an old message invalidates everything after
 * it, so shrinking the payload can cost more than it saves. On a cache-less
 * gateway there is no prefix to protect and shrinking is a pure win.
 */
export function providerHasPromptCache(provider: ProviderId): boolean {
  switch (provider) {
    case "anthropic": // explicit cacheControl
    case "openai": // implicit prefix cache >= 1024 tokens
    case "xai":
    case "deepseek":
    case "google":
      return true;
    // groq / cerebras / lmstudio have none; sumopod and openai-compatible are
    // arbitrary upstreams, so assume none rather than bet on a discount.
    default:
      return false;
  }
}

function applyAnthropicBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  // Strip marks we set on a previous pass FIRST. Re-applying per step is what
  // makes BP3 a rolling write, but the SDK accumulator hands back the messages
  // we already marked, so without this the marks pile up (step 2 marks T1,
  // step 3 marks T2, ...) and blow through Anthropic's 4-breakpoint ceiling.
  // Dropping a mark does not invalidate anything: cacheControl only designates
  // where a write happens, reads still match on the longest cached prefix.
  const out = messages.map(withoutAnthropicCacheMark);

  // Anthropic allows 4 breakpoints; we use 3:
  //   BP1 system - caches system + tool schemas (5-min TTL, re-warmed).
  //   BP2 last user - caches prefix up to the current user turn; tool-loop
  //       steps share it, so step 2+ pays only for appended deltas.
  //   BP3 last tool result - rolling write. Step N writes, step N+1 hits it
  //       and pays only the new delta. Compounds on long tool loops. Only lands
  //       when this runs per step (see applyStepCacheBreakpoints); at turn start
  //       the last message is always the user turn, so BP3 has nothing to mark.

  const systemIdx = out.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) out[systemIdx] = withAnthropicCacheMark(out[systemIdx]);

  const lastUserIdx = findLastIndex(out, (m) => m.role === "user");
  if (lastUserIdx > systemIdx && lastUserIdx >= 0) {
    out[lastUserIdx] = withAnthropicCacheMark(out[lastUserIdx]);
  }

  const lastToolIdx = findLastIndex(out, (m) => m.role === "tool");
  if (lastToolIdx > lastUserIdx && lastToolIdx >= 0) {
    out[lastToolIdx] = withAnthropicCacheMark(out[lastToolIdx]);
  }

  return out;
}

/**
 * Re-apply breakpoints for ONE step of the tool loop. This is what activates
 * BP3: at turn start the newest message is the user turn, so the rolling
 * tool-result breakpoint never had anything to mark, and every step re-sent the
 * whole accumulated tool tail at full write price (quadratic over a long loop).
 * A no-op for providers without explicit markers.
 */
export function applyStepCacheBreakpoints(
  messages: ModelMessage[],
  provider: ProviderId,
): ModelMessage[] {
  return provider === "anthropic" ? applyCacheBreakpoints(messages, provider) : messages;
}

/** Drop a mark this module set, leaving any other providerOptions intact. */
function withoutAnthropicCacheMark(msg: ModelMessage): ModelMessage {
  const anthropic = msg.providerOptions?.anthropic as Record<string, unknown> | undefined;
  if (!anthropic || !("cacheControl" in anthropic)) return msg;
  const { cacheControl: _dropped, ...rest } = anthropic;
  return { ...msg, providerOptions: { ...msg.providerOptions, anthropic: rest } } as ModelMessage;
}

function withAnthropicCacheMark(msg: ModelMessage): ModelMessage {
  return {
    ...msg,
    providerOptions: {
      ...(msg.providerOptions ?? {}),
      anthropic: {
        ...((msg.providerOptions?.anthropic as object | undefined) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    },
  } as ModelMessage;
}
