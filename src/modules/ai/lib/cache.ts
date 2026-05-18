import type { ModelMessage } from "ai";
import type { ProviderId } from "../config";

/**
 * Provider-aware prompt-cache adapter.
 *
 * Why a registry: each provider has its own cache semantics.
 *
 *   anthropic         Explicit markers. Up to 4 `cacheControl` breakpoints.
 *                     We place three (system, last user, last tool result);
 *                     see `applyAnthropicBreakpoints` for the rationale.
 *
 *   openai            Implicit prefix cache, kicks in at ≥1024 tokens. We
 *   xai               just need the prefix to be byte-stable. Already
 *   deepseek          handled - system prompt has no dynamic data, and
 *   sumopod           the per-turn <env> block lives on the LAST user
 *   openai-compatible message (after the cacheable prefix).
 *
 *   google            Implicit cache on Gemini 2.5+. Same prefix-stability
 *                     requirement; explicit `cachedContent` API exists but
 *                     adds round-trip cost - skip until we measure a win.
 *
 *   groq              No prompt cache (gateway is stateless). The local
 *   cerebras          autocomplete LRU does the equivalent job.
 *   lmstudio
 *
 * Anyone adding a provider only has to extend the switch in
 * `applyCacheBreakpoints` - every other call site stays untouched.
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
      // Implicit / unsupported: byte-stable prefix is the precondition,
      // and `buildSystemPrompt` already guarantees it. Nothing to inject.
      return messages;
  }
}

function applyAnthropicBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  const out = messages.slice();

  // Anthropic allows up to 4 cache breakpoints per request. We use 3:
  //
  //   BP1  system message           - caches system + tool schemas across
  //                                   the entire conversation (5-min TTL,
  //                                   re-warmed each request).
  //
  //   BP2  last user message        - caches conversation prefix up to the
  //                                   current user turn. Steps within the
  //                                   tool loop all share this prefix, so
  //                                   step 2+ pays only for new appended
  //                                   tool calls / results.
  //
  //   BP3  last tool-result message - rolling write that moves forward each
  //                                   step. Step N writes a cache entry at
  //                                   the latest tool result; step N+1 hits
  //                                   it and only pays for the new step's
  //                                   delta. Compounding savings on long
  //                                   tool loops.

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
