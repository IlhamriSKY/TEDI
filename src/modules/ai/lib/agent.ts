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
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  DEFAULT_MODEL_ID,
  getModelContextLimit,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  ORCHESTRATION_PROMPT_BODY,
  ORCHESTRATION_PROMPT_BODY_LITE,
  pickSystemPromptVariant,
  PLAN_MODE_PROMPT_BODY,
  providerNeedsKey,
  providersServingModel,
  resolveModelInfo,
  resolveOpenAICompatibleModel,
  SUMOPOD_BASE_URL,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
  tryGetModel,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
} from "../config";
import { classifyError, TediErrorCode } from "./errors";
import type { ProviderKeys } from "./keyring";
import { corsFallbackFetch } from "./httpProxy";
import { buildExtensionTools } from "../tools/extensions";
import { buildTools, type ToolContext } from "../tools/tools";
import type { Tool } from "ai";
import { applyCacheBreakpoints } from "./cache";
import { compactModelMessagesDetailed, type CompactStages } from "./compact";
import { HOST_PROMPT_LINE } from "./osTag";
import { resolvePromptText, resolvePromptTemperature } from "./prompts";
import { getPromptOverrides } from "../store/promptsStore";
import { useDebugStore } from "../store/debugStore";

export const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  read_file: (i) => `Reading ${shortPath(i.path)}`,
  list_directory: (i) => `Listing ${shortPath(i.path)}`,
  grep: (i) => `Grepping ${ellipsize(String(i.pattern ?? ""), 40)}`,
  glob: (i) => `Globbing ${ellipsize(String(i.pattern ?? ""), 40)}`,
  replace_in_files: (i) => `Replacing ${ellipsize(String(i.pattern ?? ""), 40)} across files`,
  edit: (i) => `Editing ${shortPath(i.path)}`,
  multi_edit: (i) => `Editing ${shortPath(i.path)}`,
  write_file: (i) => `Writing ${shortPath(i.path)}`,
  create_directory: (i) => `Creating ${shortPath(i.path)}`,
  move_file: (i) => `Moving ${shortPath(i.from)} → ${shortPath(i.to)}`,
  copy_file: (i) => `Copying ${shortPath(i.from)} → ${shortPath(i.to)}`,
  delete_file: (i) => `Deleting ${shortPath(i.path)}`,
  fetch: (i) => `Fetching ${ellipsize(String(i.url ?? ""), 60)}`,
  bash_run: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
  bash_background: (i) => `Spawning ${ellipsize(String(i.command ?? ""), 60)}`,
  bash_logs: () => `Reading logs`,
  bash_list: () => `Listing background processes`,
  bash_kill: () => `Stopping background process`,
  suggest_command: (i) => `Suggesting ${ellipsize(String(i.command ?? ""), 60)}`,
  todo_write: (i) => `Updating plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`,
  skill: (i) => `Using ${String(i.name ?? "skill")} skill`,
  run_subagent: (i) => `Spawning ${String(i.type ?? "subagent")} subagent`,
  run_subagents: (i) => {
    const tasks = Array.isArray(i.tasks) ? i.tasks : [];
    // "(orchestrated)" when the batch actually uses depends_on; a plain fan-out
    // (no deps) shows "in parallel".
    const orchestrated = tasks.some(
      (t) =>
        t &&
        typeof t === "object" &&
        Array.isArray((t as { depends_on?: unknown }).depends_on) &&
        (t as { depends_on: unknown[] }).depends_on.length > 0,
    );
    return `Spawning ${tasks.length} subagent${tasks.length === 1 ? "" : "s"}${orchestrated ? " (orchestrated)" : " in parallel"}`;
  },
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
    // The resolved provider has no key. If the same model id is served by a
    // configured provider (one the user has a key for), route there instead of
    // failing - covers ids shared across providers (e.g. deepseek-v4-pro on both
    // native DeepSeek and SumoPod) when the pick lands on the keyless native one.
    const alt = providersServingModel(resolvedModelId).find(
      (p) => !providerNeedsKey(p) || !!keys[p],
    );
    if (alt && alt !== provider) {
      provider = alt;
    } else {
      throw new Error(`No API key configured for ${provider}. Open Settings → AI to add one.`);
    }
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
        // Route chat through the native-first CORS fallback so self-hosted /
        // tunnelled endpoints (9Router, local routers) that don't send CORS
        // headers still stream, while cloud gateways keep the native path.
        fetch: corsFallbackFetch,
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
      built = createOpenAICompatible({ name: "lmstudio", baseURL, fetch: corsFallbackFetch })(
        resolvedModelId,
      );
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

/** Deterministic JSON with keys sorted at EVERY level, so equivalent inputs
 *  fingerprint equal. A top-level-keys array passed as JSON.stringify's replacer
 *  strips nested keys (`{todos:[{},{}]}`), collapsing distinct payloads. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** Fingerprint for a tool call. Canonicalizes args so equivalent inputs match. */
function toolCallFingerprint(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input)}`;
}

/**
 * Stops when the last `maxRepeats` steps used the same tool with the same
 * input. Default 3 because some tools (e.g. `bash_logs`) repeat twice
 * legitimately.
 */
export function noToolRepetition<T extends ToolSet>(maxRepeats = 3): StopCondition<T> {
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
export function noProgressStop<T extends ToolSet>(maxIdle = 2): StopCondition<T> {
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
  /** Provider the user picked alongside `modelId`. Wins over id-based lookup so
   *  a model id shared by two providers (e.g. `deepseek-v4-pro` on both the
   *  native DeepSeek provider and SumoPod) routes to the one actually selected. */
  provider?: ProviderId;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number; stages: CompactStages }) => void;
  /** Fired when a streaming OVER_CONTEXT error surfaces (after runAgentStream
   *  has returned, so the transport's synchronous retry can't see it). The
   *  transport compacts persisted history so the next send fits. */
  onOverContext?: () => void;
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
  /** Concatenated `.tedi/memory/*.md` (durable project memory). */
  memory?: string | null;
  /** Pre-formatted "## SKILLS" block (name + description per available skill).
   *  Byte-stable across turns so it stays in the cacheable prefix. */
  skillsPrompt?: string | null;
  /** Pre-formatted "## MCP SERVERS" block for the system prompt. */
  mcpSummary?: string | null;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

export type McpToolRecord = Record<string, Tool>;

/** Build the full system message. Carries no dynamic data (cwd, terminal
 *  output) so the prefix is byte-stable across turns for prompt caching. */
function buildSystemPrompt(opts: {
  modelId: string;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  projectMemory?: string | null;
  memory?: string | null;
  skillsPrompt?: string | null;
  mcpSummary?: string | null;
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
  // Persistent memory (Claude-CLI style): files under .tedi/memory are loaded as
  // durable context. The instruction is always present so the agent knows it can
  // record facts there; the saved content is appended when any exists.
  const memBlock = `\n\n## MEMORY\nDurable project memory lives in \`.tedi/memory/*.md\` and is auto-loaded here. To remember a fact across sessions, write or update a short markdown file there (create the folder if missing).${
    opts.memory && opts.memory.trim().length > 0 ? `\n\nSaved memory:\n${opts.memory.trim()}` : ""
  }`;
  const skillsBlock = opts.skillsPrompt?.trim() ? `\n\n${opts.skillsPrompt.trim()}` : "";
  const mcpBlock = opts.mcpSummary?.trim() ? `\n\n${opts.mcpSummary.trim()}` : "";
  const planBody = resolvePromptText(overrides, "plan-mode", PLAN_MODE_PROMPT_BODY);
  const planBlock = opts.planMode ? `\n\n${planBody}` : "";
  // Auto-orchestration nudge: appended whenever sub-agents are enabled (the
  // single on/off now covers orchestration too). Read live (like the overrides
  // above); the flag is stable across a turn so the prefix stays byte-stable for
  // caching until the setting changes. Lite models get a compact prompt.
  const subPrefs = usePreferencesStore.getState();
  const orchestrationOn = subPrefs.subagentsEnabled;
  const orchestrationDefault =
    variant === "lite" ? ORCHESTRATION_PROMPT_BODY_LITE : ORCHESTRATION_PROMPT_BODY;
  const orchestrationBody = resolvePromptText(overrides, "orchestration", orchestrationDefault);
  const orchestrationBlock = orchestrationOn ? `\n\n${orchestrationBody}` : "";
  return `${hostBlock}${base}${memoryBlock}${memBlock}${skillsBlock}${mcpBlock}${personaBlock}${customBlock}${planBlock}${orchestrationBlock}`;
}

/** Appended for the turn when the user writes "ultrathink": a provider-agnostic
 *  push for deeper reasoning (TEDI runs many model families, so this is a prompt
 *  directive rather than a per-provider thinking-budget knob). */
const ULTRATHINK_DIRECTIVE = `\n\n## ULTRATHINK\nThe user asked you to think hard this turn. Before any tool call or final answer, reason step by step and exhaustively: restate the problem, weigh multiple approaches and their trade-offs, check edge cases and failure modes, and verify your plan against the actual code. Prioritize correctness over speed.`;

/** Orchestration-intent cues that mechanically enforce the SUB-AGENT mandate.
 *  When a turn matches and sub-agents are on, step 0 is pinned to a
 *  `run_subagents` fan-out (see forceSpawnStep0). This is the model-agnostic way
 *  to get RELIABLE auto-delegation: a soft prompt mandate is followed by strong
 *  instruction-tuned models but ignored by many others, which reach for the
 *  easy inline tools (read/grep/list) instead. Restricting step 0 to the spawn
 *  tool removes that choice, so delegation happens regardless of the model - the
 *  same principle as opencode's orchestrator, which simply denies inline tools.
 *  Mirrors the mandate's own verb list; EN + ID because the user base writes
 *  both. Deliberately broad: over-delegating a borderline task still returns a
 *  correct answer, just via a sub-agent. ponytail: keyword heuristic, not intent
 *  parsing; add languages or tighten only if it misfires. */
const ORCHESTRATION_INTENT = new RegExp(
  [
    "sub[-\\s]?agents?",
    "orchestrat\\w*",
    "stud(?:y|ies)",
    "explor\\w*",
    "understand",
    "audit",
    "trace",
    "analy[sz]e\\w*",
    "investigat\\w*",
    "map\\s+out",
    // Indonesian
    "pelajari",
    "eksplor\\w*",
    "telusuri",
    "pahami",
    "tinjau",
    "petakan",
    "analis\\w*",
    "selidiki",
    "menyeluruh",
  ].join("|"),
  "i",
);

/** Text of the latest user message (concatenated text parts), for keyword
 *  detection like "ultrathink". Empty when there is no user message. */
function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    return (messages[i].parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/** Runs one streaming agent step. Returns a `streamText` result whose
 *  `.toUIMessageStream()` plugs into `@ai-sdk/react`'s Chat. */
export async function runAgentStream(
  opts: RunAgentOptions & { mcpTools?: McpToolRecord; mcpSummary?: string | null },
) {
  const requestedModelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const known = tryGetModel(requestedModelId);
  // Unknown id that carries an openai-compatible namespace routes back through
  // that provider so the agent resolves the right endpoint instead of
  // mislabelling it as SumoPod.
  const fallbackProvider: ProviderId = resolveOpenAICompatibleModel(requestedModelId)
    ? "openai-compatible"
    : "sumopod";
  // The explicitly-selected provider wins over id-based lookup. `tryGetModel`
  // prefers the static MODELS table, so a SumoPod id that also exists natively
  // (deepseek-v4-pro, claude-sonnet-4-6) would otherwise resolve to the native
  // provider and fail with "no API key".
  const provider: ProviderId = opts.provider ?? known?.provider ?? fallbackProvider;
  const modelInfo: ModelInfo = resolveModelInfo(requestedModelId, provider, known);

  const model = await buildLanguageModel(provider, opts.keys, modelInfo.id, {
    lmstudioBaseURL: opts.lmstudioBaseURL,
    openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
  });

  // "ultrathink" in the latest user message escalates reasoning for this turn
  // (breaks the cached prefix only on those turns, which is the intent).
  const latestUserText = lastUserText(opts.uiMessages);
  const ultrathink = /\bultra ?think\b/i.test(latestUserText);
  const systemText =
    buildSystemPrompt({
      modelId: modelInfo.id,
      customInstructions: opts.customInstructions,
      agentPersona: opts.agentPersona,
      projectMemory: opts.projectMemory,
      memory: opts.memory,
      skillsPrompt: opts.skillsPrompt,
      mcpSummary: opts.mcpSummary,
      planMode: opts.planMode,
    }) + (ultrathink ? ULTRATHINK_DIRECTIVE : "");

  // Optional main-agent temperature override. Only sent when the user set one,
  // so reasoning models that reject sampling params stay untouched by default.
  const coreTemperature = resolvePromptTemperature(getPromptOverrides(), "core");

  const history = await convertToModelMessages(opts.uiMessages);
  // The system prompt is prepended *after* compaction (see baseMessages below)
  // and the transport injects a per-turn <env> block into the latest user
  // message - neither is visible to the history compactor. Reserve their
  // approximate token cost so the 60/80% thresholds reflect the real request
  // size. This matters most on small-context models and when a large
  // project-memory file (TEDI.md) inflates the system prompt. The floor keeps
  // us from reserving more than half the window if the system prompt is huge.
  const fullContextLimit = getModelContextLimit(modelInfo.id);
  const systemTokenEstimate = Math.ceil(systemText.length / 4);
  const ENV_AND_OUTPUT_RESERVE = 2000;
  const effectiveContextLimit = Math.max(
    Math.floor(fullContextLimit / 2),
    fullContextLimit - systemTokenEstimate - ENV_AND_OUTPUT_RESERVE,
  );
  const compact = compactModelMessagesDetailed(history, effectiveContextLimit);
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
  // Extension-contributed AI tools first, then MCP tools, then built-ins.
  // Built-ins spread AFTER so an extension/MCP can never shadow a built-in
  // tool name (e.g. bash_run).
  const tools = {
    ...buildExtensionTools(opts.toolContext),
    ...opts.mcpTools,
    ...buildTools(opts.toolContext),
  };

  // Forced spawn: a soft orchestration mandate in the prompt is unreliable -
  // many models start reading files inline instead of calling run_subagents.
  // opencode's orchestrator solves this by DENYING inline tools so the model can
  // only delegate; we apply the same idea per-turn, model-agnostically: when the
  // request matches the mandate's intent and the feature is on, pin step 0 to
  // run_subagents only and require a tool call. Endpoints that honor toolChoice
  // then emit a well-formed multi-task spawn; those that don't are unaffected.
  // Only step 0 is constrained, so the model still synthesizes the summaries
  // itself afterwards (TEDI's run_subagents fans out the whole batch in one go).
  const forceSpawnStep0 =
    usePreferencesStore.getState().subagentsEnabled &&
    "run_subagents" in tools &&
    ORCHESTRATION_INTENT.test(latestUserText);

  // Debug capture: snapshot the assembled request (no secrets) when the user
  // turned Debug on, so they can inspect / download exactly what TEDI sends.
  if (usePreferencesStore.getState().debugEnabled) {
    useDebugStore.getState().add({
      kind: "main",
      sessionId: opts.toolContext.getSessionId(),
      model: { id: modelInfo.id, provider, label: modelInfo.label },
      params: {
        ...(coreTemperature !== undefined ? { temperature: coreTemperature } : {}),
        maxSteps: MAX_AGENT_STEPS,
      },
      system: systemText,
      messages: finalMessages,
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: (t as { description?: string } | undefined)?.description,
      })),
    });
  }

  return streamText({
    model,
    messages: finalMessages,
    ...(coreTemperature !== undefined ? { temperature: coreTemperature } : {}),
    tools,
    // SDK infers a specific ToolSet from `tools` and refuses our generic
    // `StopCondition<ToolSet>[]`. Predicates only touch common fields, so
    // a structural cast is safe.
    stopWhen: trackingStopWhen as never,
    // Pin the first step to a run_subagents call when the user explicitly asked
    // for sub-agents (see forceSpawnStep0). No-op otherwise; later steps are
    // always unconstrained. Cast for the same reason as stopWhen above.
    prepareStep: (({ stepNumber }: { stepNumber: number }) =>
      forceSpawnStep0 && stepNumber === 0
        ? { activeTools: ["run_subagents"], toolChoice: "required" }
        : {}) as never,
    abortSignal: opts.abortSignal,
    // streamText errors surface during stream consumption — after this function
    // returns — so the transport's synchronous retry/recovery can't observe
    // them. Route an over-context streaming failure to the recovery hook so the
    // persisted history is compacted for the user's next send.
    onError: ({ error }) => {
      if (classifyError(error) === TediErrorCode.OVER_CONTEXT) opts.onOverContext?.();
    },
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
