import { generateText, stepCountIs, type ModelMessage } from "ai";
import {
  tryGetModel,
  type DynamicModelId,
  type ModelInfo,
} from "../config";
import { buildLanguageModel } from "../lib/agent";
import { applyCacheBreakpoints } from "../lib/cache";
import type { ProviderKeys } from "../lib/keyring";
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
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // Subagents only get read-only tools. Build directly from the read-only
  // builders to avoid pulling in mutating/recursive tools.
  const readOnly: Record<string, unknown> = {
    ...buildFsTools(toolContext),
    ...buildSearchTools(toolContext),
  };
  const filtered: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) filtered[t] = readOnly[t];
  }

  // Unknown ids fall back to SumoPod (the only provider with runtime
  // discovery via /v1/models). Same shape main agent uses — keeps
  // behavior consistent when the user picks a freshly detected model.
  const info: ModelInfo =
    tryGetModel(modelId) ??
    ({
      id: modelId,
      provider: "sumopod",
      label: modelId,
      hint: "SumoPod",
    } as ModelInfo);

  const model = await buildLanguageModel(info.provider, keys, info.id, {
    lmstudioBaseURL,
    openaiCompatibleBaseURL,
  });

  // Build explicit messages so we can attach provider-cache markers.
  // The Experimental_Agent class hides this — generateText does not, and
  // the tool-loop semantics (stopWhen) carry over.
  const baseMessages: ModelMessage[] = [
    { role: "system", content: def.systemPrompt },
    { role: "user", content: prompt },
  ];
  const messages = applyCacheBreakpoints(baseMessages, info.provider);

  // `tools` / `stopWhen` are casted because the SDK infers `never` for the
  // tools generic when fed a dynamic record — same shape the original
  // Experimental_Agent call site used.
  const start = Date.now();
  const result = await generateText({
    model,
    messages,
    tools: filtered as never,
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS) as never,
  } as never);
  const durationMs = Date.now() - start;

  const summary = result.text?.trim() || "(no output)";
  const stepCount = result.steps?.length ?? 0;

  return { summary, stepCount, durationMs };
}
