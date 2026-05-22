import type { ModelMessage } from "ai";
import type { ProviderId } from "../config";

/**
 * Provider-aware prompt-cache adapter.
 *
 * Anthropic uses explicit `cacheControl` markers (up to 4). OpenAI, xAI,
 * DeepSeek, SumoPod, and OpenAI-compatible gateways use implicit prefix
 * caching at >= 1024 tokens; the system prompt and per-turn <env> placement
 * already keep the prefix byte-stable.
 * Google's Gemini 2.5+ also has implicit caching; explicit `cachedContent`
 * is skipped because it adds round-trip cost.
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

function applyAnthropicBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  const out = messages.slice();

  // Anthropic allows 4 breakpoints; we use 3:
  //   BP1 system - caches system + tool schemas (5-min TTL, re-warmed).
  //   BP2 last user - caches prefix up to the current user turn; tool-loop
  //       steps share it, so step 2+ pays only for appended deltas.
  //   BP3 last tool result - rolling write. Step N writes, step N+1 hits it
  //       and pays only the new delta. Compounds on long tool loops.

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

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}
