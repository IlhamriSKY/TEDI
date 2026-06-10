import { generateText, stepCountIs, type ModelMessage } from "ai";
import { tryGetModel, type DynamicModelId, type ModelInfo } from "../config";
import { buildLanguageModel } from "../lib/agent";
import { applyCacheBreakpoints } from "../lib/cache";
import type { ProviderKeys } from "../lib/keyring";
import {
  resolvePromptModel,
  resolvePromptTemperature,
  resolvePromptText,
  type PromptId,
} from "../lib/prompts";
import { getPromptOverrides } from "../store/promptsStore";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: DynamicModelId;
  toolContext: ToolContext;
  lmstudioBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  /** Forwarded from parent so Stop also cancels in-flight subagent fetches. */
  abortSignal?: AbortSignal;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  toolContext,
  lmstudioBaseURL,
  openaiCompatibleBaseURL,
  abortSignal,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // Read-only tools only. Skip mutating/recursive builders. Disable the
  // out-of-scope read approval gate: this generateText loop has no approval
  // responder, so a gated read would stall instead of running.
  const readOnly: Record<string, unknown> = {
    ...buildFsTools(toolContext, { gateOutOfScopeReads: false }),
    ...buildSearchTools(toolContext, { gateOutOfScopeReads: false }),
  };
  const filtered: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) filtered[t] = readOnly[t];
  }

  // User overrides: system prompt, model, and (opt-in) temperature per sub-agent.
  const overrides = getPromptOverrides();
  const promptId = `subagent:${type}` as PromptId;
  const systemPrompt = resolvePromptText(overrides, promptId, def.systemPrompt);
  // Model override defaults to the parent's model id so unconfigured sub-agents
  // behave exactly as before.
  const effectiveModelId = resolvePromptModel(overrides, promptId, modelId);
  const temperature = resolvePromptTemperature(overrides, promptId);

  // Unknown ids fall back to SumoPod (runtime discovery via /v1/models).
  const info: ModelInfo =
    tryGetModel(effectiveModelId) ??
    ({
      id: effectiveModelId,
      provider: "sumopod",
      label: effectiveModelId,
      hint: "SumoPod",
    } as ModelInfo);

  const model = await buildLanguageModel(info.provider, keys, info.id, {
    lmstudioBaseURL,
    openaiCompatibleBaseURL,
  });

  // Explicit messages so we can attach provider-cache markers (Experimental_Agent hides this).
  const baseMessages: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
  const messages = applyCacheBreakpoints(baseMessages, info.provider);

  // Casts because the SDK infers `never` for the tools generic on a dynamic record.
  const start = Date.now();
  const result = await generateText({
    model,
    messages,
    tools: filtered as never,
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS) as never,
    ...(temperature !== undefined ? { temperature } : {}),
    abortSignal,
  } as never);
  const durationMs = Date.now() - start;

  const summary = result.text?.trim() || "(no output)";
  const stepCount = result.steps?.length ?? 0;

  return { summary, stepCount, durationMs };
}
