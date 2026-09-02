import type { JSONValue, ModelMessage } from "ai";
import { findLastIndex } from "@/lib/utils";
import type { ProviderId } from "../config";
import { reasoningProviderOptions } from "./reasoning";

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

/**
 * Every provider-specific request option, in ONE place.
 *
 * Caching: Anthropic is handled by the explicit breakpoints above. OpenAI's cache
 * is implicit, which this file used to read as "nothing to inject" - no longer
 * true. `promptCacheKey` pins a conversation to one cache shard (without it a
 * long session's requests can miss a prefix that IS cached), and a 24h retention
 * is the difference between a hit and a miss when the user comes back after
 * lunch. Scoped to `openai`: the ChatGPT-account endpoint shares the namespace
 * but is a different backend that already refuses a request over one unexpected
 * key.
 *
 * Reasoning: merged in from `reasoning.ts`, which owns the per-model capability
 * table. It has to be MERGED here rather than spread separately at the call site
 * - `providerOptions` is a single key, so a second spread would replace this one
 * wholesale and silently drop ChatGPT's mandatory `store: false` (that endpoint
 * then refuses the request) along with OpenAI's cache key.
 */
export function providerRequestOptions(
  provider: ProviderId,
  sessionId: string | null,
  modelId?: string,
  reasoningChoice?: string,
): { providerOptions?: Record<string, Record<string, JSONValue>> } {
  const base: Record<string, Record<string, JSONValue>> = {};
  if (provider === "chatgpt") {
    // The Responses API stores a conversation server-side by DEFAULT, and the
    // ChatGPT backend refuses a request that asks it to. Sending `store: false`
    // is what makes that endpoint answer at all.
    base.openai = { store: false };
  } else if (provider === "openai") {
    base.openai = {
      ...(sessionId ? { promptCacheKey: sessionId } : {}),
      promptCacheRetention: "24h",
    };
  }

  // Undefined unless the model really supports the level the user picked, so a
  // model with no reasoning control - or a stale choice left over from another
  // one - adds nothing to the request.
  const reasoning = reasoningChoice
    ? reasoningProviderOptions(provider, modelId, reasoningChoice)
    : undefined;
  for (const [ns, opts] of Object.entries(reasoning ?? {})) {
    base[ns] = { ...(base[ns] ?? {}), ...opts };
  }

  return Object.keys(base).length > 0 ? { providerOptions: base } : {};
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
  if (systemIdx >= 0) out[systemIdx] = withAnthropicCacheMark(out[systemIdx], "1h");

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

/**
 * Mark one message as a cache breakpoint.
 *
 * `ttl` decides whether the entry is still there when the user comes back. The
 * default is five minutes; a 1h write costs 2x base instead of 1.25x, and a read
 * refreshes the entry's timer for free.
 *
 * ONLY BP1 TAKES THE 1h. The system block (prompt + tool schemas + the TEDI.md
 * preload, ~13k tokens) is byte-stable for a whole session, so it is written once
 * and read by every later request - exactly the shape a long TTL is for, and the
 * one thing that would otherwise expire while the user reads an answer and
 * thinks.
 *
 * BP2 and BP3 stay at 5m, and that is not an oversight. Both cover bytes that
 * MOVE: BP2 is the newest user message, new on every turn, and BP3 rolls forward
 * every step seconds apart. A longer TTL there protects a prefix that has already
 * changed by the time the extra hour could matter, while charging the 2x premium
 * on every single turn - and consecutive requests keep a 5m entry warm
 * indefinitely anyway.
 */
function withAnthropicCacheMark(msg: ModelMessage, ttl?: "1h"): ModelMessage {
  return {
    ...msg,
    providerOptions: {
      ...(msg.providerOptions ?? {}),
      anthropic: {
        ...((msg.providerOptions?.anthropic as object | undefined) ?? {}),
        cacheControl: { type: "ephemeral", ...(ttl ? { ttl } : {}) },
      },
    },
  } as ModelMessage;
}
