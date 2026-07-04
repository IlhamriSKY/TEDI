import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  LMSTUDIO_DEFAULT_BASE_URL,
  type AutocompleteProviderId,
} from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { resolvePromptTemperature, resolvePromptText } from "@/modules/ai/lib/prompts";
import { getPromptOverrides } from "@/modules/ai/store/promptsStore";
import { generateText } from "ai";
import { buildUserPrompt, COMPLETION_SYSTEM_PROMPT, type CompletionRequest } from "./prompt";

/** Default visible-output temperature. Override-able per the prompt settings. */
const DEFAULT_COMPLETION_TEMPERATURE = 0.2;

export type CompletionDeps = {
  provider: AutocompleteProviderId;
  modelId: string;
  /** Provider API key, or null for keyless (LM Studio). */
  apiKey: string | null;
  lmstudioBaseURL: string;
};

const MAX_OUTPUT_TOKENS_DEFAULT = 128;
// Reasoning models burn output tokens on internal thought; a tight cap
// finishes with empty text. Trim step still caps visible output at MAX_LINES.
const MAX_OUTPUT_TOKENS_REASONING = 1024;

export async function requestCompletion(
  req: CompletionRequest,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  const modelId = deps.modelId.trim() || DEFAULT_AUTOCOMPLETE_MODEL[deps.provider];
  const keys = { ...EMPTY_PROVIDER_KEYS, [deps.provider]: deps.apiKey };
  const model = await buildLanguageModel(deps.provider, keys, modelId, {
    lmstudioBaseURL: deps.lmstudioBaseURL || LMSTUDIO_DEFAULT_BASE_URL,
  });

  const isReasoning = /\bgpt-oss\b/i.test(modelId);
  const providerOptions = isReasoning
    ? {
        cerebras: { reasoningEffort: "low" },
        groq: { reasoningEffort: "low" },
        openai: { reasoningEffort: "low" },
      }
    : undefined;

  const overrides = getPromptOverrides();
  const systemPrompt = resolvePromptText(overrides, "autocomplete", COMPLETION_SYSTEM_PROMPT);
  const temperature =
    resolvePromptTemperature(overrides, "autocomplete") ?? DEFAULT_COMPLETION_TEMPERATURE;

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: buildUserPrompt(req),
    maxOutputTokens: isReasoning ? MAX_OUTPUT_TOKENS_REASONING : MAX_OUTPUT_TOKENS_DEFAULT,
    maxRetries: 0,
    abortSignal: signal,
    temperature,
    ...(providerOptions ? { providerOptions } : {}),
  });

  // trimSuggestion (inlineExtension.ts) strips the same markdown fence +
  // <|cursor|> on the only call path, so normalize there and return raw here.
  return text;
}
