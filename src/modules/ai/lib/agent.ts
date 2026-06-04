import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  DEFAULT_MODEL_ID,
  getModelContextLimit,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  pickSystemPromptVariant,
  PLAN_MODE_PROMPT_BODY,
  providerNeedsKey,
  resolveOpenAICompatibleModel,
  SUMOPOD_BASE_URL,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
  tryGetModel,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
} from "../config";
import type { ProviderKeys } from "./keyring";
import { buildExtensionTools } from "../tools/extensions";
import { buildTools, type ToolContext } from "../tools/tools";
import { applyCacheBreakpoints } from "./cache";
import { compactModelMessagesDetailed, type CompactStages } from "./compact";
import { HOST_PROMPT_LINE } from "./osTag";
import { resolvePromptText, resolvePromptTemperature } from "./prompts";
import { getPromptOverrides } from "../store/promptsStore";

const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  read_file: (i) => `Reading ${shortPath(i.path)}`,
  list_directory: (i) => `Listing ${shortPath(i.path)}`,
  grep: (i) => `Grepping ${ellipsize(String(i.pattern ?? ""), 40)}`,
  glob: (i) => `Globbing ${ellipsize(String(i.pattern ?? ""), 40)}`,
  edit: (i) => `Editing ${shortPath(i.path)}`,
  multi_edit: (i) => `Editing ${shortPath(i.path)}`,
  write_file: (i) => `Writing ${shortPath(i.path)}`,
  create_directory: (i) => `Creating ${shortPath(i.path)}`,
  bash_run: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
  bash_background: (i) => `Spawning ${ellipsize(String(i.command ?? ""), 60)}`,
  bash_logs: () => `Reading logs`,
  bash_list: () => `Listing background processes`,
  bash_kill: () => `Stopping background process`,
  suggest_command: (i) => `Suggesting ${ellipsize(String(i.command ?? ""), 60)}`,
  todo_write: (i) => `Updating plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`,
  run_subagent: (i) => `Spawning ${String(i.type ?? "subagent")} subagent`,
};

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export type BuildModelOptions = {
  /** Override the model id (used by autocomplete with custom LM Studio model). */
  modelIdOverride?: string;
  /** LM Studio base URL. Defaults to `LMSTUDIO_DEFAULT_BASE_URL`. */
  lmstudioBaseURL?: string;
  /** Base URL for the user-configured OpenAI-compatible provider. */
  openaiCompatibleBaseURL?: string;
};

// Memoize built models. Provider clients register middleware and parse keys,
// so rebuilding per `sendMessages` is wasteful. LRU-capped so rotating keys
// or base URLs doesn't grow the cache forever.
const MODEL_CACHE_LIMIT = 16;
const modelCache = new Map<string, LanguageModel>();

export async function buildLanguageModel(
  provider: ProviderId,
  keys: ProviderKeys,
  resolvedModelId: string,
  options: BuildModelOptions = {},
): Promise<LanguageModel> {
  if (providerNeedsKey(provider) && !keys[provider]) {
    throw new Error(`No API key configured for ${provider}. Open Settings → AI to add one.`);
  }
  const key = keys[provider] ?? "";
  const baseURL = options.lmstudioBaseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  const oaiCompatBase = options.openaiCompatibleBaseURL ?? "";
  // For openai-compatible, fold the resolved instance's base URL + key into the
  // cache key so rotating one instance's key (or editing its URL) invalidates
  // its cached client without disturbing other instances.
  const oaiCompatResolved =
    provider === "openai-compatible" ? resolveOpenAICompatibleModel(resolvedModelId) : null;
  const oaiCompatCacheTag = oaiCompatResolved
    ? `|${oaiCompatResolved.instanceId}|${oaiCompatResolved.baseURL}|${oaiCompatResolved.apiKey}`
    : "";
  const cacheKey = `${provider}|${key}|${resolvedModelId}|${baseURL}|${oaiCompatBase}${oaiCompatCacheTag}`;
  const hit = modelCache.get(cacheKey);
  if (hit) {
    modelCache.delete(cacheKey);
    modelCache.set(cacheKey, hit);
    return hit;
  }

  let built: LanguageModel;
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = createOpenAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ apiKey: key })(resolvedModelId);
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ apiKey: key })(resolvedModelId);
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ apiKey: key })(resolvedModelId);
      break;
    }
    case "deepseek": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
      })(resolvedModelId);
      break;
    }
    case "sumopod": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "sumopod",
        baseURL: SUMOPOD_BASE_URL,
        apiKey: key,
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      // Resolve the concrete endpoint for this model. Namespaced ids
      // (`<instanceId>::<rawId>`) carry their instance; the resolver returns
      // that instance's base URL + key and the raw model id to send upstream.
      // A plain (non-namespaced) id falls back to the legacy single-endpoint
      // base URL + the `openai-compatible` key, preserving old behaviour.
      const resolved = oaiCompatResolved;
      const url = (resolved?.baseURL ?? oaiCompatBase ?? "").replace(/\/$/, "");
      if (!url) {
        throw new Error(
          "OpenAI Compatible base URL is not set. Open Settings → Models to configure it.",
        );
      }
      const apiKey = resolved?.apiKey || key;
      const upstreamModelId = resolved?.rawModelId ?? resolvedModelId;
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: url,
        apiKey,
      })(upstreamModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ apiKey: key })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({ name: "lmstudio", baseURL })(resolvedModelId);
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive as ProviderId}`);
    }
  }
  if (modelCache.size >= MODEL_CACHE_LIMIT) {
    const oldest = modelCache.keys().next().value;
    if (oldest !== undefined) modelCache.delete(oldest);
  }
  modelCache.set(cacheKey, built);
  return built;
}

/** Fingerprint for a tool call. Sorts arg keys so equivalent inputs match. */
function toolCallFingerprint(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return `${toolName}::${JSON.stringify(input)}`;
  const sortedKeys = Object.keys(input as Record<string, unknown>).sort();
  return `${toolName}::${JSON.stringify(input, sortedKeys)}`;
}

/**
 * Stops when the last `maxRepeats` steps used the same tool with the same
 * input. Default 3 because some tools (e.g. `bash_logs`) repeat twice
 * legitimately.
 */
function noToolRepetition<T extends ToolSet>(maxRepeats = 3): StopCondition<T> {
  return ({ steps }) => {
    if (steps.length < maxRepeats) return false;
    const recent = steps.slice(-maxRepeats);
    const fingerprints: (string | null)[] = recent.map((s) => {
      const calls = s.toolCalls;
      if (!calls || calls.length === 0) return null;
      // Cover the full ordered set of tool calls so parallel multi-tool
      // repetition is caught and a step that only matches on its first call
      // (but differs on the rest) isn't falsely flagged.
      return calls.map((c) => toolCallFingerprint(c.toolName, c.input)).join("\n");
    });
    if (fingerprints.some((x) => x === null)) return false;
    return fingerprints.every((x) => x === fingerprints[0]);
  };
}

/** Stops after `maxIdle` consecutive text-only steps. A real text turn ends
 *  on its own and never chains another empty step. */
function noProgressStop<T extends ToolSet>(maxIdle = 2): StopCondition<T> {
  return ({ steps }) => {
    if (steps.length < maxIdle) return false;
    return steps.slice(-maxIdle).every((s) => (s.toolCalls?.length ?? 0) === 0);
  };
}

/** Per-step usage delta. The handler accumulates totals. `cachedInputTokens`
 *  is 0 when the provider doesn't report it or the prefix didn't hit. */
export type AgentUsageDelta = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type RunAgentOptions = {
  keys: ProviderKeys;
  modelId?: DynamicModelId;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number; stages: CompactStages }) => void;
  onFinishMeta?: (info: {
    hitStepCap: boolean;
    finishReason: string;
    /** Which guard stopped the loop. Surfaced in the UI so the user sees why. */
    stopReason: "step-cap" | "tool-repetition" | "no-progress" | "normal";
  }) => void;
  lmstudioBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  planMode?: boolean;
  projectMemory?: string | null;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

/** Build the full system message. Carries no dynamic data (cwd, terminal
 *  output) so the prefix is byte-stable across turns for prompt caching. */
function buildSystemPrompt(opts: {
  modelId: string;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  projectMemory?: string | null;
  planMode?: boolean;
}): string {
  // Resolve the core prompt: the user can override the full or compact variant
  // independently, so the byte-stable lite/full token split survives overrides.
  const overrides = getPromptOverrides();
  const variant = pickSystemPromptVariant(opts.modelId);
  const builtinBase = variant === "lite" ? SYSTEM_PROMPT_LITE : SYSTEM_PROMPT;
  const base = resolvePromptText(overrides, variant === "lite" ? "core-lite" : "core", builtinBase);
  // Host tag is captured once at boot; prepending it keeps the prefix
  // byte-stable across turns for prompt caching.
  const hostBlock = HOST_PROMPT_LINE ? `${HOST_PROMPT_LINE}\n\n` : "";
  const personaBlock = opts.agentPersona?.instructions.trim()
    ? `\n\n## ACTIVE AGENT - ${opts.agentPersona.name}\n${opts.agentPersona.instructions.trim()}`
    : "";
  const customBlock = opts.customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS - follow unless they conflict with safety rules above\n${opts.customInstructions.trim()}`
    : "";
  const memoryBlock =
    opts.projectMemory && opts.projectMemory.trim().length > 0
      ? `\n\n## PROJECT - TEDI.md\n${opts.projectMemory.trim()}`
      : "";
  const planBody = resolvePromptText(overrides, "plan-mode", PLAN_MODE_PROMPT_BODY);
  const planBlock = opts.planMode ? `\n\n${planBody}` : "";
  return `${hostBlock}${base}${memoryBlock}${personaBlock}${customBlock}${planBlock}`;
}

/** Runs one streaming agent step. Returns a `streamText` result whose
 *  `.toUIMessageStream()` plugs into `@ai-sdk/react`'s Chat. */
export async function runAgentStream(opts: RunAgentOptions) {
  const requestedModelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const modelInfo: ModelInfo =
    tryGetModel(requestedModelId) ??
    // Unknown id: if it carries an openai-compatible namespace, route it back
    // through that provider so the agent resolves the right endpoint instead of
    // mislabelling it as SumoPod.
    (resolveOpenAICompatibleModel(requestedModelId)
      ? ({
          id: requestedModelId,
          provider: "openai-compatible",
          label: requestedModelId,
          hint: "OpenAI Compatible",
        } as ModelInfo)
      : ({
          id: requestedModelId,
          provider: "sumopod",
          label: requestedModelId,
          hint: "SumoPod",
        } as ModelInfo));

  const provider = modelInfo.provider;
  const model = await buildLanguageModel(provider, opts.keys, modelInfo.id, {
    lmstudioBaseURL: opts.lmstudioBaseURL,
    openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
  });

  const systemText = buildSystemPrompt({
    modelId: modelInfo.id,
    customInstructions: opts.customInstructions,
    agentPersona: opts.agentPersona,
    projectMemory: opts.projectMemory,
    planMode: opts.planMode,
  });

  // Optional main-agent temperature override. Only sent when the user set one,
  // so reasoning models that reject sampling params stay untouched by default.
  const coreTemperature = resolvePromptTemperature(getPromptOverrides(), "core");

  const history = await convertToModelMessages(opts.uiMessages);
  const compact = compactModelMessagesDetailed(history, getModelContextLimit(modelInfo.id));
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount, stages: compact.stages });
  }

  const baseMessages: ModelMessage[] = [
    { role: "system", content: systemText },
    ...compact.messages,
  ];
  const finalMessages = applyCacheBreakpoints(baseMessages, provider);

  // Thread the abort signal into the ToolContext so tools can fast-fail on
  // Stop/session-delete. The SDK only aborts the HTTP fetch by default.
  // Mutate the stable session ctx instead of spreading a fresh object: tools
  // read `abortSignal` lazily (throwIfAborted / per-tool execute), so a new
  // signal per turn is picked up, and keeping the same ctx identity lets
  // buildTools' per-ctx WeakMap cache actually hit (no zod schema rebuilds).
  opts.toolContext.abortSignal = opts.abortSignal;

  let stepsSeen = 0;
  // Three stop predicates (any trip ends the loop):
  //   1. Step cap.
  //   2. Identical tool+input 3x in a row.
  //   3. Two consecutive text-only steps.
  // Each wrapper records which guard tripped so the UI can show a stopReason.
  let trippedReason: "step-cap" | "tool-repetition" | "no-progress" | null = null;
  const capPred = stepCountIs(MAX_AGENT_STEPS);
  const repeatPred = noToolRepetition<ToolSet>(3);
  const idlePred = noProgressStop<ToolSet>(2);
  const trackingStopWhen: StopCondition<ToolSet>[] = [
    (args) => {
      if (capPred(args) as boolean) {
        if (!trippedReason) trippedReason = "step-cap";
        return true;
      }
      return false;
    },
    (args) => {
      if (repeatPred(args) as boolean) {
        if (!trippedReason) trippedReason = "tool-repetition";
        return true;
      }
      return false;
    },
    (args) => {
      if (idlePred(args) as boolean) {
        if (!trippedReason) trippedReason = "no-progress";
        return true;
      }
      return false;
    },
  ];
  return streamText({
    model,
    messages: finalMessages,
    ...(coreTemperature !== undefined ? { temperature: coreTemperature } : {}),
    // Extension-contributed AI tools first, built-ins spread AFTER so an
    // extension can never shadow a built-in tool name (e.g. bash_run).
    tools: { ...buildExtensionTools(), ...buildTools(opts.toolContext) },
    // SDK infers a specific ToolSet from `tools` and refuses our generic
    // `StopCondition<ToolSet>[]`. Predicates only touch common fields, so
    // a structural cast is safe.
    stopWhen: trackingStopWhen as never,
    abortSignal: opts.abortSignal,
    onStepFinish: (step) => {
      stepsSeen++;
      if (opts.onStep) {
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) {
          const label = TOOL_LABELS[last.toolName];
          opts.onStep(
            label
              ? label((last.input ?? {}) as Record<string, unknown>)
              : `Calling ${last.toolName}`,
          );
        } else if (step.text) {
          opts.onStep("Writing");
        }
      }
      if (opts.onUsage && step.usage) {
        const u = step.usage;
        opts.onUsage({
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
        });
      }
    },
    onFinish: (result) => {
      opts.onStep?.(null);
      const finishReason = (result as { finishReason?: string } | undefined)?.finishReason ?? "";
      opts.onFinishMeta?.({
        hitStepCap: stepsSeen >= MAX_AGENT_STEPS,
        finishReason,
        stopReason: trippedReason ?? "normal",
      });
    },
  });
}
