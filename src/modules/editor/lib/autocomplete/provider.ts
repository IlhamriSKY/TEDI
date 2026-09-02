import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  LMSTUDIO_DEFAULT_BASE_URL,
  type AutocompleteProviderId,
} from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { resolvePromptTemperature, resolvePromptText } from "@/modules/ai/lib/prompts";
import { reasoningControlFor, reasoningProviderOptions } from "@/modules/ai/lib/reasoning";
import { getPromptOverrides } from "@/modules/ai/store/promptsStore";
import { generateText } from "ai";
import { buildUserPrompt, COMPLETION_SYSTEM_PROMPT, type CompletionRequest } from "./prompt";

/** Default visible-output temperature. Override-able per the prompt settings. */
const DEFAULT_COMPLETION_TEMPERATURE = 0.2;

export type CompletionDeps = {
  provider: AutocompleteProviderId;
  modelId: string;
  /** Provider API key, or null for keyless (LM Studio, local OpenAI-compatible). */
  apiKey: string | null;
  lmstudioBaseURL: string;
  /** Base URL for the OpenAI-compatible provider. Required only when a bare
   *  (non-namespaced) model id is used, since a namespaced id carries its own
   *  instance base URL. Optional so existing callers keep compiling. */
  openaiCompatibleBaseURL?: string;
};

/**
 * Families that spend output tokens on hidden thought before emitting any
 * visible text. They need the larger cap below, or the tight one finishes
 * mid-thought and the completion comes back empty.
 *
 * `(?<!non-)` matters: `grok-4.20-non-reasoning` is a default here, and matching
 * it would grant an 8x cap to the one model whose name says it does not reason.
 */
const THINKING_MODEL = [
  /\b(gpt-oss|o[1-9]\b|deepseek-r\d|qwq|thinking)\b/i,
  /(?<!non-)\breasoning\b/i,
  /\bgpt-5/i,
  /\bgemini-(?:[3-9]|2\.5)/i,
  /\bclaude-(fable|mythos)-\d/i,
  /\bclaude-opus-4-(?:[7-9]|\d\d)/i,
  /\bclaude-sonnet-(?:[5-9]|\d\d)/i,
];
function isThinkingModel(modelId: string): boolean {
  return THINKING_MODEL.some((re) => re.test(modelId));
}

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
    openaiCompatibleBaseURL: deps.openaiCompatibleBaseURL,
  });

  const isReasoning = isThinkingModel(modelId);
  // Completion wants an answer, not deliberation, so ask the model for the
  // LOWEST reasoning level it actually supports.
  //
  // Resolved through the shared capability table rather than re-derived here.
  // This used to set `reasoningEffort: "low"` under seven namespaces at once
  // plus a Google `thinkingLevel` - a shotgun, because a model id alone does not
  // say which client built it. It could not know that `low` is not the floor on
  // the gpt-5.x line (`none` is), that gpt-5.x-codex rejects `none` outright, or
  // that Gemini 2.5 takes an integer budget and 400s on a level. One table now,
  // covered by one verify, and a model with no control gets no parameter at all.
  const control = reasoningControlFor(deps.provider, modelId);
  const providerOptions = control
    ? reasoningProviderOptions(deps.provider, modelId, control.values[0])
    : undefined;

  const overrides = getPromptOverrides();
  const systemPrompt = resolvePromptText(overrides, "autocomplete", COMPLETION_SYSTEM_PROMPT);
  // A rejected sampling param is not one bad response here, it is a permanently
  // dead feature: this fires on every typing pause. The thinking families are
  // exactly the ones to skip it for - the GPT-5 line and the newer Claude models
  // return a hard 400, and Google asks that Gemini be left at its default
  // because lowering it can make the model loop. Older Claude (opus-4-6,
  // sonnet-4-6, haiku-4-5) and the gpt-4.x line still accept it, and none of
  // those match. An explicit user setting always wins.
  const explicitTemperature = resolvePromptTemperature(overrides, "autocomplete");
  const temperature =
    explicitTemperature ?? (isReasoning ? undefined : DEFAULT_COMPLETION_TEMPERATURE);

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: buildUserPrompt(req),
    maxOutputTokens: isReasoning ? MAX_OUTPUT_TOKENS_REASONING : MAX_OUTPUT_TOKENS_DEFAULT,
    maxRetries: 0,
    abortSignal: signal,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  });

  // trimSuggestion (inlineExtension.ts) strips the same markdown fence +
  // <|cursor|> on the only call path, so normalize there and return raw here.
  return text;
}
