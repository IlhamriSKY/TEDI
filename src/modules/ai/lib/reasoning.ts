import type { JSONValue } from "ai";
import { parseOpenAICompatibleModelId, type ProviderId } from "../config";

/**
 * Which reasoning control a model really has, and exactly what it maps to on the
 * wire.
 *
 * THERE IS NO UNIVERSAL VOCABULARY, and that is the entire reason this file
 * exists. Every provider spells the capability differently, and the accepted
 * values differ between MODEL FAMILIES of one provider as often as they differ
 * between providers:
 *
 *   openai / chatgpt   reasoning: { effort }              none low medium high xhigh (+max on 5.6)
 *   anthropic          output_config: { effort }          low medium high xhigh max (no xhigh on sonnet-4-6)
 *   google             generationConfig.thinkingConfig    thinkingLevel: minimal low medium high
 *   xai / groq /
 *   cerebras / deepseek  reasoning_effort                 per-model subsets, no two alike
 *
 * Every mapping below was verified by capturing the actual request body the
 * installed provider emits, not read off a docs page. The values were then
 * checked against each provider's official model documentation, because the SDKs
 * do NOT validate: @ai-sdk/google passes `thinkingConfig` through untouched, and
 * the openai-compatible base types `reasoningEffort` as a bare string, so a value
 * this table gets wrong reaches the API and 400s.
 *
 * Every absence below is deliberate and explained at the rule that omits it.
 *
 * DEFAULT IS ALWAYS "SEND NOTHING". `REASONING_AUTO` is not a value any API
 * knows; it means TEDI omits the parameter entirely and the provider's own
 * default applies. So enabling this feature changes no request until the user
 * picks a level, and no model ever receives a parameter it did not ask for.
 */

/** The "let the provider decide" choice. Selecting it sends NO parameter. */
export const REASONING_AUTO = "";

export type ReasoningControl = {
  /**
   * The provider's own parameter as it appears in the request body. Surfaced in
   * the UI so the mapping is inspectable instead of a mystery.
   */
  wire: string;
  /** Selectable values, ascending in depth. Provider-native tokens, never ours. */
  values: readonly string[];
  /**
   * What the provider applies when nothing is sent, or null where the provider
   * does not document one. DISPLAY ONLY - TEDI never sends it.
   */
  providerDefault: string | null;
};

/** One rule: exact ids or a family pattern, plus the control they grant. */
type Rule = { ids?: readonly string[]; pattern?: RegExp; control: ReasoningControl };

const effort = (
  wire: string,
  values: readonly string[],
  providerDefault: string | null,
): ReasoningControl => ({ wire, values, providerDefault });

// --- OpenAI and the ChatGPT account --------------------------------------
//
// Both lanes reach the RESPONSES API (`createOpenAI(...)(id)` returns a responses
// model in this SDK, and the ChatGPT lane calls `.responses()` explicitly), so
// the shape is the nested `reasoning: { effort }` - never the flat
// `reasoning_effort` of chat completions.
const OA = "reasoning.effort";
const OPENAI_RULES: readonly Rule[] = [
  // Codex FIRST: `gpt-5.3-codex` must not fall into the 5.3/5.4 rule, which would
  // offer it `none` - the one value its family rejects.
  { pattern: /^gpt-5\.\d+-codex/, control: effort(OA, ["low", "medium", "high", "xhigh"], null) },
  {
    pattern: /^gpt-5\.6(?:[-.:]|$)/,
    control: effort(OA, ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
  },
  {
    pattern: /^gpt-5\.5(?:[-.:]|$)/,
    control: effort(OA, ["none", "low", "medium", "high", "xhigh"], "medium"),
  },
  // gpt-5.4-mini and -nano default to `none`: no reasoning at all unless asked.
  // That is documented provider behaviour, and showing the default is the only
  // way a user can see that these two models are not thinking.
  {
    pattern: /^gpt-5\.4(?:[-.:]|$)/,
    control: effort(OA, ["none", "low", "medium", "high", "xhigh"], "none"),
  },
];

// --- Anthropic -----------------------------------------------------------
//
// The modern line takes an ENUM under `output_config`, not a token budget:
// budget_tokens is a 400 on fable-5 / opus-4-8 / opus-4-7 / sonnet-5.
const AN = "output_config.effort";
const ANTHROPIC_RULES: readonly Rule[] = [
  // sonnet-4-6 predates `xhigh`, so it gets its own shorter list.
  {
    ids: ["claude-sonnet-4-6"],
    control: effort(AN, ["low", "medium", "high", "max"], "high"),
  },
  {
    ids: ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"],
    control: effort(AN, ["low", "medium", "high", "xhigh", "max"], "high"),
  },
  // claude-haiku-4-5 is intentionally absent: `effort` ERRORS on it and thinking
  // is budget-only there.
];

// --- Google --------------------------------------------------------------
//
// Gemini 3.x takes the `thinkingLevel` enum; Gemini 2.5 takes the legacy integer
// `thinkingBudget`, and sending both in one request is a documented 400. Only the
// 3.x line is offered. Google states 3.x models always think, so there is no off.
const GO = "thinkingConfig.thinkingLevel";
const GOOGLE_RULES: readonly Rule[] = [
  {
    pattern: /^gemini-3(?:[-.]|$)/,
    control: effort(GO, ["minimal", "low", "medium", "high"], null),
  },
];

// --- reasoning_effort providers ------------------------------------------
//
// One wire field, four different accepted sets. Cerebras declares no reasoning
// option of its own but extends the openai-compatible base, whose provider string
// is `cerebras.chat`, so `providerOptions.cerebras.reasoningEffort` does reach
// the wire.
const RE = "reasoning_effort";
const LMH = ["low", "medium", "high"] as const;

const RULES: Partial<Record<ProviderId, readonly Rule[]>> = {
  openai: OPENAI_RULES,
  // Same models, same Responses endpoint, same parameter - the ChatGPT backend is
  // the subscription route to them, not a different API.
  chatgpt: OPENAI_RULES,
  anthropic: ANTHROPIC_RULES,
  google: GOOGLE_RULES,
  // xAI documents the parameter for grok-4.5 only. The SDK's enum also offers
  // `none`, but xAI's own docs say reasoning cannot be disabled, so it is not
  // offered here.
  xai: [{ ids: ["grok-4.5"], control: effort(RE, LMH, "high") }],
  // The gpt-oss pair. `none`/`default` in the SDK enum belong to the Qwen family,
  // which TEDI does not ship.
  groq: [{ pattern: /gpt-oss/, control: effort(RE, LMH, null) }],
  cerebras: [{ pattern: /gpt-oss/, control: effort(RE, LMH, "medium") }],
  // DeepSeek accepts low / high / max and thinks by default.
  deepseek: [{ pattern: /^deepseek-/, control: effort(RE, ["low", "high", "max"], "high") }],
};

/**
 * The reasoning control for one model, or null when it has none.
 *
 * Lookup mirrors `getModelContextLimit`: strip the OpenAI-compatible namespace
 * first (a capability belongs to the MODEL, not to the endpoint serving it), then
 * exact ids, then family patterns. An id nobody recognises gets NULL rather than
 * a guess, because sending an unsupported reasoning parameter is a 400.
 */
export function reasoningControlFor(
  provider: ProviderId,
  modelId: string | undefined,
): ReasoningControl | null {
  if (!modelId) return null;
  const rules = RULES[provider];
  if (!rules) return null;
  const raw = (parseOpenAICompatibleModelId(modelId)?.rawModelId ?? modelId).toLowerCase();
  for (const r of rules) {
    if (r.ids?.includes(raw) || r.pattern?.test(raw)) return r.control;
  }
  return null;
}

/** True when `choice` is a value this model really accepts. `AUTO` always is. */
export function isValidReasoningChoice(
  provider: ProviderId,
  modelId: string | undefined,
  choice: string,
): boolean {
  if (choice === REASONING_AUTO) return true;
  return reasoningControlFor(provider, modelId)?.values.includes(choice) ?? false;
}

/**
 * The `providerOptions` fragment for a chosen level, or undefined for "send
 * nothing".
 *
 * A FRAGMENT to be merged, never a whole `providerOptions` object: the ChatGPT
 * lane already carries a mandatory `store: false` under the same `openai`
 * namespace, and replacing rather than merging there makes that endpoint refuse
 * the request outright.
 *
 * An invalid choice returns undefined rather than throwing. A stored value can
 * outlive the model it was chosen for, and the correct response to that is the
 * provider's own default, not a failed turn.
 */
export function reasoningProviderOptions(
  provider: ProviderId,
  modelId: string | undefined,
  choice: string,
): Record<string, Record<string, JSONValue>> | undefined {
  if (!isValidReasoningChoice(provider, modelId, choice) || choice === REASONING_AUTO) {
    return undefined;
  }
  switch (provider) {
    case "openai":
    case "chatgpt":
      return { openai: { reasoningEffort: choice } };
    case "anthropic":
      return { anthropic: { effort: choice } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: choice } } };
    case "xai":
    case "groq":
    case "cerebras":
    case "deepseek":
      return { [provider]: { reasoningEffort: choice } };
    default:
      return undefined;
  }
}
