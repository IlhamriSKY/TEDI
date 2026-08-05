import type { ModelMessage } from "ai";
import { findLastIndex } from "@/lib/utils";
import type { ProviderId } from "../config";

/**
 * Provider-aware prompt-cache adapter. A new provider needs only a case here.
 *
 * Anthropic: explicit `cacheControl`, 4 markers max. OpenAI/xAI/DeepSeek/Gemini
 * 2.5+: implicit prefix caching, nothing to inject. Groq/Cerebras/LM Studio:
 * none. Gateways (SumoPod, openai-compatible): unverified, assume none - the
 * defence there is `compactStepMessages`, not caching.
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

/** Providers seen reporting cache-read tokens in this app run. */
const observedPromptCache = new Set<ProviderId>();

/**
 * Record that a provider really returned cached input tokens.
 *
 * Gateways are assumed cache-less below, which makes `compactStepMessages`
 * rewrite history every step - and that rewriting is itself what invalidates a
 * prefix the gateway did cache. The usage report is ground truth, so stop
 * guessing once it disagrees. One-way: a single cold miss must not restart the
 * rewriting that caused it.
 */
export function noteProviderCacheRead(provider: ProviderId): void {
  observedPromptCache.add(provider);
}

/**
 * Does this provider cache the prompt prefix at all? Decides whether rewriting
 * history mid-turn pays: on a caching provider editing an old message
 * invalidates everything after it, on a cache-less one shrinking is free.
 */
export function providerHasPromptCache(provider: ProviderId): boolean {
  // Measured beats tabled: a gateway that reported a cache read has one.
  if (observedPromptCache.has(provider)) return true;
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
  // Strip our own marks first: the SDK hands back messages we already marked, so
  // they would pile up past Anthropic's 4-breakpoint ceiling. Dropping a mark
  // invalidates nothing - reads still match the longest cached prefix.
  const out = messages.map(withoutAnthropicCacheMark);

  // 3 of Anthropic's 4 breakpoints:
  //   BP1 system     - system + tool schemas.
  //   BP2 last user  - tool-loop steps share it, so step 2+ pays only deltas.
  //   BP3 last tool result - rolling write, only lands when run per step
  //       (applyStepCacheBreakpoints); at turn start there is no tool tail yet.

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
 * BP3; without it every step re-sent the whole tool tail at full write price.
 * No-op for providers without explicit markers.
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
