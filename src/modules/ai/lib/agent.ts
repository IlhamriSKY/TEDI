import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import {
  DEFAULT_MODEL_ID,
  getModelContextLimit,
  getSystemPrompt,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  providerNeedsKey,
  SUMOPOD_BASE_URL,
  tryGetModel,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
} from "../config";
import type { ProviderKeys } from "./keyring";
import { buildTools, type ToolContext } from "../tools/tools";
import { applyCacheBreakpoints } from "./cache";
import { compactModelMessagesDetailed } from "./compact";
import { HOST_PROMPT_LINE } from "./osTag";

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
  /** Override LM Studio base URL. Defaults to `LMSTUDIO_DEFAULT_BASE_URL`. */
  lmstudioBaseURL?: string;
  /** Base URL for the user-configurable OpenAI-compatible provider. */
  openaiCompatibleBaseURL?: string;
};

// Memoize built models. Provider clients are not free to construct - they
// register middleware and parse keys - and we'd otherwise rebuild one per
// `sendMessages` call. Keyed on the full identity that affects the result.
// Capped via simple LRU so rotating keys / switching base URLs doesn't grow
// the cache forever (each entry holds a fully-wired provider client).
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
  const cacheKey = `${provider}|${key}|${resolvedModelId}|${baseURL}|${oaiCompatBase}`;
  const hit = modelCache.get(cacheKey);
  if (hit) {
    // Refresh LRU position by re-inserting at the tail.
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
      const url = (oaiCompatBase || "").replace(/\/$/, "");
      if (!url) {
        throw new Error(
          "OpenAI Compatible base URL is not set. Open Settings → Models to configure it.",
        );
      }
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: url,
        apiKey: key,
      })(resolvedModelId);
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
  // Maintain LRU eviction: drop the oldest entry once we exceed the cap.
  // `Map` preserves insertion order, so the first key is the LRU.
  if (modelCache.size >= MODEL_CACHE_LIMIT) {
    const oldest = modelCache.keys().next().value;
    if (oldest !== undefined) modelCache.delete(oldest);
  }
  modelCache.set(cacheKey, built);
  return built;
}

const PLAN_MODE_PROMPT = `\n\n## PLAN MODE - ACTIVE\nMutating tools (write_file, edit, multi_edit, create_directory) queue changes for the user to review as a single diff. Do NOT execute bash_run or bash_background while plan mode is active - reads (read_file, grep, glob, list_directory) and the queued mutations only. After queueing the full set of edits, stop and return a brief summary; don't continue until the user has accepted/rejected.`;

/** Per-step usage delta - handler is responsible for accumulating
 *  cumulative totals if it wants them. Cached tokens come from the
 *  provider's prompt-cache hit counter; 0 when the provider doesn't
 *  report it or the prefix didn't hit. */
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
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  lmstudioBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  planMode?: boolean;
  projectMemory?: string | null;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

/** Build the full system message text. Stable per session - does NOT carry
 *  any dynamic data (cwd, terminal output, etc.). That keeps the prefix
 *  byte-stable across turns, which is the precondition for prompt caching
 *  on every provider that supports it. */
function buildSystemPrompt(opts: {
  modelId: string;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  projectMemory?: string | null;
  planMode?: boolean;
}): string {
  const base = getSystemPrompt(opts.modelId);
  // Host tag is module-scoped (captured once at boot) so prepending it
  // keeps the prefix byte-stable across turns - the precondition for
  // every provider's prompt cache.
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
  const planBlock = opts.planMode ? PLAN_MODE_PROMPT : "";
  return `${hostBlock}${base}${memoryBlock}${personaBlock}${customBlock}${planBlock}`;
}

/** Run one streaming agent step. Used by the in-process Chat transport.
 *  Returns a streamText result whose `.toUIMessageStream()` plugs straight
 *  into `@ai-sdk/react`'s Chat. */
export async function runAgentStream(opts: RunAgentOptions) {
  const modelInfo: ModelInfo =
    tryGetModel(opts.modelId ?? DEFAULT_MODEL_ID) ??
    ({
      id: opts.modelId ?? DEFAULT_MODEL_ID,
      provider: "sumopod",
      label: opts.modelId ?? DEFAULT_MODEL_ID,
      hint: "SumoPod",
    } as ModelInfo);

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

  const history = await convertToModelMessages(opts.uiMessages);
  const compact = compactModelMessagesDetailed(history, getModelContextLimit(modelInfo.id));
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount });
  }

  const baseMessages: ModelMessage[] = [
    { role: "system", content: systemText },
    ...compact.messages,
  ];
  const finalMessages = applyCacheBreakpoints(baseMessages, provider);

  let stepsSeen = 0;
  return streamText({
    model,
    messages: finalMessages,
    tools: buildTools(opts.toolContext),
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
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
      });
    },
  });
}
