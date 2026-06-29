import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { tryGetModel, type DynamicModelId, type ModelInfo } from "../config";
import { buildLanguageModel, noProgressStop, noToolRepetition, TOOL_LABELS } from "../lib/agent";
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
import { buildEditTools } from "../tools/edit";
import { buildShellTools } from "../tools/shell";
import { READ_ONLY_TOOLS, type SubagentDef } from "./registry";
import { getAllSubagentDefs } from "../store/subagentsStore";
import { useDebugStore } from "../store/debugStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

/** Sub-agents have no user-facing step cap so they can run a task to completion.
 *  Termination is driven by natural finish plus the same anti-loop guards the
 *  main agent uses (tool-repetition + no-progress); this high number is only a
 *  runaway backstop the guards almost always trip well before. */
const SUBAGENT_STEP_BUDGET = 100;

type Args = {
  type: string;
  prompt: string;
  keys: ProviderKeys;
  modelId: DynamicModelId;
  toolContext: ToolContext;
  lmstudioBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  /** Forwarded from parent so Stop also cancels in-flight subagent fetches. */
  abortSignal?: AbortSignal;
  /** Fires after each internal step with a human label of what the subagent
   *  just did ("Reading …", "Grepping …") and the running step count, so the UI
   *  can show live progress for an otherwise-blocking generateText loop. */
  onStep?: (label: string, stepCount: number) => void;
};

/** Human label for the subagent's latest step, mirroring the main agent's
 *  per-step label derivation (reuses the shared TOOL_LABELS map). */
function describeStep(step: {
  toolCalls?: Array<{ toolName: string; input?: unknown }>;
  text?: string;
}): string {
  const last = step.toolCalls?.[step.toolCalls.length - 1];
  if (last) {
    const label = TOOL_LABELS[last.toolName];
    return label
      ? label((last.input ?? {}) as Record<string, unknown>)
      : `Calling ${last.toolName}`;
  }
  return step.text ? "Writing" : "Thinking";
}

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
  onStep,
}: Args): Promise<RunResult> {
  const def = getAllSubagentDefs()[type] as SubagentDef | undefined;
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // A worker (its tool list includes anything beyond READ_ONLY_TOOLS, e.g.
  // Odyssey) gets the mutating + shell tools; a read-only agent does not.
  const isWorker = def.tools.some((t) => !READ_ONLY_TOOLS.includes(t));

  // Disable the out-of-scope read approval gate: this generateText loop has no
  // approval responder, so a gated read would stall instead of running. A
  // worker additionally gets edit/write/fs-mutation/shell tools with approval
  // OFF (autoApprove): same no-responder reason. Mutations stay guarded by the
  // secret/system denylist, writable/deletable checks, scope-root protection,
  // and checkpoint/restore. run_subagent is never built here, so no recursion.
  const available: Record<string, unknown> = {
    ...buildFsTools(toolContext, {
      gateOutOfScopeReads: false,
      refuseOutOfScopeReads: true,
      autoApproveMutations: isWorker,
    }),
    ...buildSearchTools(toolContext, { gateOutOfScopeReads: false, refuseOutOfScopeReads: true }),
    ...(isWorker
      ? {
          ...buildEditTools(toolContext, { autoApprove: true }),
          ...buildShellTools(toolContext, { autoApprove: true }),
        }
      : {}),
  };
  const filtered: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in available) filtered[t] = available[t];
  }

  // User overrides: system prompt, model, and (opt-in) temperature per sub-agent.
  const overrides = getPromptOverrides();
  const promptId = `subagent:${type}` as PromptId;
  const systemPrompt = resolvePromptText(overrides, promptId, def.systemPrompt);
  // Model resolution: an explicit prompt-override (built-ins) wins, else the
  // def's own model (custom sub-agents), else the parent chat model.
  const effectiveModelId = resolvePromptModel(overrides, promptId, def.model ?? modelId);
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

  // Debug capture: snapshot this sub-agent's request (no secrets) when Debug is on.
  if (usePreferencesStore.getState().debugEnabled) {
    useDebugStore.getState().add({
      kind: "subagent",
      sessionId: toolContext.getSessionId(),
      subagentType: type,
      model: { id: info.id, provider: info.provider, label: info.label },
      params: {
        ...(temperature !== undefined ? { temperature } : {}),
        stepBudget: SUBAGENT_STEP_BUDGET,
      },
      system: systemPrompt,
      messages,
      tools: Object.entries(filtered).map(([name, t]) => ({
        name,
        description: (t as { description?: string } | undefined)?.description,
      })),
    });
  }

  // Casts because the SDK infers `never` for the tools generic on a dynamic record.
  const start = Date.now();
  let liveSteps = 0;
  const result = await generateText({
    model,
    messages,
    tools: filtered as never,
    // No low step cap (powerful sub-agents): natural finish plus the main
    // agent's anti-loop guards terminate; the count is just a runaway backstop.
    stopWhen: [
      stepCountIs(SUBAGENT_STEP_BUDGET),
      noToolRepetition<ToolSet>(3),
      noProgressStop<ToolSet>(2),
    ] as never,
    ...(temperature !== undefined ? { temperature } : {}),
    abortSignal,
    // Surface live progress: each finished step reports what the subagent just
    // did + the running step count to the optional onStep callback.
    onStepFinish: (step: {
      toolCalls?: Array<{ toolName: string; input?: unknown }>;
      text?: string;
    }) => {
      liveSteps += 1;
      onStep?.(describeStep(step), liveSteps);
    },
  } as never);
  const durationMs = Date.now() - start;

  const summary = result.text?.trim() || "(no output)";
  const stepCount = result.steps?.length ?? 0;

  return { summary, stepCount, durationMs };
}
