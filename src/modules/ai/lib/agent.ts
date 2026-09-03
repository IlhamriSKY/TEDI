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
import { findLastIndex } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AGENTROUTER_BASE_URL,
  AGENTROUTER_HEADERS,
  buildCorePrompt,
  CHATGPT_BASE_URL,
  CHATGPT_HEADERS,
  CHAT_MODE_PROMPT,
  DEFAULT_MODEL_ID,
  getModelContextLimit,
  isLoopbackBaseURL,
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
  tryGetModel,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
} from "../config";
import { getChatGptAccess } from "./chatgptAuth";
import { classifyError, TediErrorCode } from "./errors";
import type { ProviderKeys } from "./keyring";
import { corsFallbackFetch, proxyOnlyFetch, withStreamIdleTimeout } from "./httpProxy";
import { buildExtensionTools } from "../tools/extensions";
import { buildTools, type ToolContext } from "../tools/tools";
import { applyToolFilter, mcpSummaryFor } from "../tools/catalog";
import type { Tool } from "ai";
import {
  applyCacheBreakpoints,
  applyStepCacheBreakpoints,
  noteProviderCacheRead,
  providerRequestOptions,
} from "./cache";
import {
  compactModelMessagesDetailed,
  compactStepMessages,
  stripToolTraffic,
  type CompactStages,
} from "./compact";
import { wantsForcedFanout } from "./orchestrationIntent";
import { HOST_PROMPT_LINE } from "./osTag";
import { resolvePromptText, resolvePromptTemperature } from "./prompts";
import { getPromptOverrides } from "../store/promptsStore";
import { useDebugStore } from "../store/debugStore";
import { activeGoalText } from "../store/goalStore";
import { GOAL_DONE_MARKER } from "./goalRunner";

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
  // Panes, terminals and the browser are served by TEDI's own in-process MCP
  // server, so their labels are keyed on the `mcp__<server>__<tool>` key the SDK
  // reports. Without these the step line reads "Calling mcp__tedi__sh" instead
  // of naming the command, which is the whole point of this map.
  mcp__tedi__sh: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
  mcp__tedi__read: (i) => `Reading ${String(i.source ?? "terminal")}`,
  mcp__tedi__state: () => `Reading the window`,
  mcp__tedi__wait_for_terminal: (i) =>
    i.text ? `Waiting for "${ellipsize(String(i.text), 40)}"` : `Waiting for the prompt`,
  mcp__tedi__pane: (i) => `Pane ${String(i.action ?? "")}`,
  mcp__tedi__focus_pane: (i) => `Focusing pane ${String(i.leafId ?? "")}`,
  todo_write: (i) => `Updating plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`,
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

/** Human label for an agent step from its latest tool call (or free text),
 *  using the shared TOOL_LABELS map. Shared by the main agent's onStepFinish
 *  and the subagent loop so the two label the same way. */
export function describeStep(step: {
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
  // An openai-compatible instance carries its own key and base URL, and a local
  // server (Ollama / llama.cpp / vLLM) needs no key at all. Resolve that first so
  // a keyless loopback endpoint is not rejected by the generic key gate below.
  const oaiCompatEarly =
    provider === "openai-compatible" ? resolveOpenAICompatibleModel(resolvedModelId) : null;
  const oaiCompatBaseEarly =
    oaiCompatEarly?.baseURL ||
    (provider === "openai-compatible" ? (options.openaiCompatibleBaseURL ?? "") : "");
  // True when the instance supplies its own credentials, or needs none because
  // it is local. Not "keyless" in the literal sense: it means the generic key
  // gate below does not apply to this request.
  const oaiCompatSelfKeyed =
    provider === "openai-compatible" &&
    (!!oaiCompatEarly?.apiKey || isLoopbackBaseURL(oaiCompatBaseEarly));

  if (providerNeedsKey(provider) && !keys[provider] && !oaiCompatSelfKeyed) {
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
  // Fold the resolved instance's base URL + key into the cache key so rotating
  // one instance's key invalidates only its client.
  // Resolved against the POST-gate provider on purpose: the `alt` fallback can
  // reroute INTO openai-compatible, and the pre-gate value is null exactly then.
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
        // Idle-timeout the native fetch so a gateway that stalls mid-SSE fails
        // with a retryable error instead of hanging the turn forever.
        fetch: withStreamIdleTimeout(globalThis.fetch),
        // Ask for usage in the streaming response so the app can see input/
        // cached-token counts (else the streamed final chunk carries none and
        // the context/cache-hit UI is dead for this provider).
        includeUsage: true,
      })(resolvedModelId);
      break;
    }
    case "sumopod": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "sumopod",
        baseURL: SUMOPOD_BASE_URL,
        apiKey: key,
        // SumoPod uses the native fetch (it sends CORS headers, so the Rust
        // proxy's idle guard never runs). Wrap it so a wedged mid-stream request
        // aborts with a retryable error instead of hanging the turn forever -
        // the single most common mid-stream stall on this gateway.
        fetch: withStreamIdleTimeout(globalThis.fetch),
        // Surface streaming usage so the context/cache-hit indicator reflects
        // real spend on SumoPod (without this the endpoint isn't asked for usage
        // and the app is blind to its own token cost).
        includeUsage: true,
      })(resolvedModelId);
      break;
    }
    case "agentrouter": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "agentrouter",
        baseURL: AGENTROUTER_BASE_URL,
        apiKey: key,
        // Why this is its own provider and not an OpenAI-Compatible endpoint:
        // AgentRouter allowlists an exact User-Agent and 401s everything else,
        // and a WebView fetch drops that header silently. `proxyOnlyFetch` is
        // REQUIRED, not an optimisation.
        headers: { ...AGENTROUTER_HEADERS },
        fetch: withStreamIdleTimeout(proxyOnlyFetch),
        // Real spend in the context/cache indicator instead of zero every turn.
        includeUsage: true,
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      // A namespaced id (`<instanceId>::<rawId>`) carries its instance, so the
      // resolver returns that instance's URL/key plus the raw upstream id. A
      // plain id falls back to the legacy single endpoint.
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
        // Native-first CORS fallback so self-hosted endpoints without CORS
        // headers still stream. Idle-timeout because a cloud gateway takes the
        // native path and so bypasses the Rust proxy's own guard.
        fetch: withStreamIdleTimeout(corsFallbackFetch),
        // Ask for streaming usage so token/cache accounting works for custom
        // OpenAI-compatible endpoints too.
        includeUsage: true,
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
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL,
        fetch: withStreamIdleTimeout(corsFallbackFetch),
      })(resolvedModelId);
      break;
    }
    case "chatgpt": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const auth = await getChatGptAccess();
      if (!auth) {
        throw new Error(
          "Not signed in with a ChatGPT account. Open Settings → AI and sign in, or pick an API-key model.",
        );
      }
      // `.responses()`, not the default chat model: this endpoint speaks the
      // Responses API and nothing else. The AI SDK posts to `<baseURL>/responses`,
      // which is exactly the Codex path.
      //
      // `proxyOnlyFetch` is REQUIRED, not an optimisation: chatgpt.com sends no
      // CORS headers for this route, and the webview also refuses to send the
      // `originator` header, so the native path fails twice over.
      built = createOpenAI({
        baseURL: CHATGPT_BASE_URL,
        apiKey: auth.accessToken,
        headers: {
          ...CHATGPT_HEADERS,
          // Omitted rather than sent empty when the claim was missing: an empty
          // header reads as "account none" and 401s less clearly than absence.
          ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        },
        fetch: withStreamIdleTimeout(proxyOnlyFetch),
      }).responses(resolvedModelId);
      // Deliberately NOT cached: the access token rotates on refresh, and the
      // cache key is computed before this point, so a cached model would keep
      // serving an expired token until the app restarted. Rebuilding is a few
      // object literals.
      return built;
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
  /** Plain chat: one-line system prompt, no tools, no project context. */
  chatMode?: boolean;
  projectMemory?: string | null;
  /** Concatenated `.tedi/memory/*.md` (durable project memory). */
  memory?: string | null;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

export type McpToolRecord = Record<string, Tool>;

/** Build the full system message. Carries no dynamic data (cwd, terminal
 *  output) so the prefix is byte-stable across turns for prompt caching.
 *
 *  `toolNames` is the set the turn actually sends, AFTER the picker's off-list
 *  and every merge. Every capability claim below is gated on it: a prompt that
 *  describes tools the model was not given is billed on every message and is a
 *  guaranteed failed call. */
function buildSystemPrompt(opts: {
  modelId: string;
  toolNames: ReadonlySet<string>;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  projectMemory?: string | null;
  memory?: string | null;
  planMode?: boolean;
  chatMode?: boolean;
  /** Standing session goal from `/goal`, or null. */
  goal?: string | null;
}): string {
  const overrides = getPromptOverrides();
  const has = (t: string): boolean => opts.toolNames.has(t);
  const personaBlock = opts.agentPersona?.instructions.trim()
    ? `\n\n## ACTIVE AGENT - ${opts.agentPersona.name}\n${opts.agentPersona.instructions.trim()}`
    : "";
  const customBlock = opts.customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS - follow unless they conflict with safety rules above\n${opts.customInstructions.trim()}`
    : "";

  // Plain chat sends no tools, so memory/MCP/orchestration text describes
  // capabilities the model does not have, billed every message. Persona and
  // custom instructions stay - the user wrote those.
  if (opts.chatMode) {
    return `${resolvePromptText(overrides, "chat", CHAT_MODE_PROMPT)}${personaBlock}${customBlock}`;
  }

  // Resolve the core prompt: the user can override the full or compact variant
  // independently, so the byte-stable lite/full token split survives overrides.
  const variant = pickSystemPromptVariant(opts.modelId);
  // The built-in default is composed from only the sections whose tools survive.
  // An override is the user's own text, so it goes out verbatim: they wrote it,
  // TEDI does not get to prune it.
  const builtinBase = buildCorePrompt(variant, has);
  const base = resolvePromptText(overrides, variant === "lite" ? "core-lite" : "core", builtinBase);
  // Host tag is captured once at boot; prepending it keeps the prefix
  // byte-stable across turns for prompt caching.
  const hostBlock = HOST_PROMPT_LINE ? `${HOST_PROMPT_LINE}\n\n` : "";
  const memoryBlock =
    opts.projectMemory && opts.projectMemory.trim().length > 0
      ? `\n\n## PROJECT - TEDI.md\n${opts.projectMemory.trim()}`
      : "";
  // Persistent memory (Claude-CLI style): files under .tedi/memory are loaded as
  // durable context. The saved content is context and always goes out; the
  // "write a file there" half is a capability, so it needs `write_file` to be on
  // - otherwise the block is an instruction the model cannot carry out. With
  // neither, drop it entirely.
  const savedMemory = opts.memory?.trim() ? `\n\nSaved memory:\n${opts.memory.trim()}` : "";
  const memBlock =
    savedMemory || has("write_file")
      ? `\n\n## MEMORY\nDurable project memory lives in \`.tedi/memory/*.md\`, auto-loaded here when present.${
          has("write_file")
            ? ` To remember a fact across sessions, write or update a short markdown file there (create the folder if missing).`
            : ""
        }${savedMemory}`
      : "";
  // Derived from the tools that survived rather than from the live servers, so a
  // server whose tools are all unticked (or that failed to connect) is not
  // advertised as "available in your tool list". Names only, no tool count: the
  // count moved when a server finished listing between turns, and that re-priced
  // this whole prefix as a cache miss for the rest of the session.
  const mcpBlock = mcpSummaryFor(opts.toolNames);
  const planBody = resolvePromptText(overrides, "plan-mode", PLAN_MODE_PROMPT_BODY);
  const planBlock = opts.planMode ? `\n\n${planBody}` : "";
  // Auto-orchestration nudge, appended only when the spawn tool will actually be
  // sent. Keyed on the assembled tool set rather than the picker preference: a
  // prompt telling the model to delegate, next to a tool set that has no spawn
  // tool, is pure wasted tokens and a guaranteed failed call. Stable across a
  // turn, so the cached prefix holds until the user changes the picker.
  const orchestrationOn = has("run_subagents");
  const orchestrationDefault =
    variant === "lite" ? ORCHESTRATION_PROMPT_BODY_LITE : ORCHESTRATION_PROMPT_BODY;
  const orchestrationBody = resolvePromptText(overrides, "orchestration", orchestrationDefault);
  const orchestrationBlock = orchestrationOn ? `\n\n${orchestrationBody}` : "";
  // Standing goal from `/goal`. Last, so it is the final thing read before the
  // conversation, and stable across turns until the user changes it, which keeps
  // the cached prefix byte-stable the same way planBlock does.
  const goalBlock = opts.goal?.trim()
    ? `\n\n## SESSION GOAL\n${opts.goal.trim()}\n\nThis stands for the whole session, not just one message. Keep it in view: when a request is ambiguous, resolve it toward this goal. Do not restate it back to the user unprompted.\n\nDrive it to completion on your own. You will be asked to continue automatically after each turn, so do not stop to ask whether to proceed, and do not end a turn with a plan you could have executed. Stop early only if you are BLOCKED on something only the user can decide or authorize, and then say plainly what you need.\n\nWhen the goal is fully met AND you have verified it (tests, a build, or reading back what you changed), end that message with this exact line and nothing after it:\n${GOAL_DONE_MARKER}\nNever write that line for any other reason - it is what stops the run.`
    : "";
  return `${hostBlock}${base}${memoryBlock}${memBlock}${mcpBlock}${personaBlock}${customBlock}${planBlock}${orchestrationBlock}${goalBlock}`;
}

/** Appended for the turn when the user writes "ultrathink": a provider-agnostic
 *  push for deeper reasoning (TEDI runs many model families, so this is a prompt
 *  directive rather than a per-provider thinking-budget knob). */
const ULTRATHINK_DIRECTIVE = `\n\n## ULTRATHINK\nThe user asked you to think hard this turn. Before any tool call or final answer, reason step by step and exhaustively: restate the problem, weigh multiple approaches and their trade-offs, check edge cases and failure modes, and verify your plan against the actual code. Prioritize correctness over speed.`;

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
export async function runAgentStream(opts: RunAgentOptions & { mcpTools?: McpToolRecord }) {
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
  const chatMode = opts.chatMode === true;

  // The SDK only aborts the HTTP fetch, so tools need the signal too. Mutate the
  // stable ctx rather than spreading a fresh one: tools read `abortSignal`
  // lazily, and the same identity keeps buildTools' WeakMap cache hitting.
  opts.toolContext.abortSignal = opts.abortSignal;

  // Built-ins spread LAST so an extension/MCP can never shadow one (bash_run).
  // Chat mode builds none: ~77 schemas is the biggest fixed per-step cost and a
  // conversation cannot use them. Filtering here, after every source is merged,
  // is the only place a picker-disabled tool cannot slip through another path.
  // Built FIRST: the system prompt is composed from what survives here, and the
  // history conversion below needs it too - see there.
  const tools = chatMode
    ? undefined
    : applyToolFilter(
        {
          ...buildExtensionTools(opts.toolContext),
          ...opts.mcpTools,
          ...buildTools(opts.toolContext),
        },
        new Set(usePreferencesStore.getState().disabledTools),
      );
  const allToolNames = new Set(Object.keys(tools ?? {}));

  // Every assembled tool is sent. Nothing is withheld per turn: browser control
  // is one tool that opens its own pane, so there is no pane-bound definition to
  // hold back and no gate that has to stay stable across a turn to keep the
  // provider's tools cache warm.
  //
  // THE PROMPT DESCRIBES THIS SAME SET. `PromptSection.needs` exists precisely
  // so the prompt never instructs a tool the turn does not send.
  const toolNames = allToolNames;

  const systemText = buildSystemPrompt({
    modelId: modelInfo.id,
    toolNames,
    customInstructions: opts.customInstructions,
    agentPersona: opts.agentPersona,
    projectMemory: opts.projectMemory,
    memory: opts.memory,
    planMode: opts.planMode,
    chatMode,
    goal: activeGoalText(opts.toolContext.getSessionId()),
  });

  // Optional main-agent temperature override. Only sent when the user set one,
  // so reasoning models that reject sampling params stay untouched by default.
  const coreTemperature = resolvePromptTemperature(getPromptOverrides(), "core");

  // The reasoning level the user picked FOR THIS MODEL, or "" for the provider's
  // own default. Read here, per turn, so a change applies to the next prompt the
  // same way a model swap does. Keyed by provider AND id because the same id can
  // be served by two providers with different accepted values.
  const reasoningChoice =
    usePreferencesStore.getState().modelReasoning[`${provider}::${modelInfo.id}`] ?? "";

  // `tools` is what applies each tool's `toModelOutput` to REPLAYED history, not
  // just to this turn's live results. Without it the SDK re-sends the raw
  // `execute` return for every past call. An unknown tool name (uninstalled
  // extension, dropped MCP server) just misses the lookup, so old sessions load.
  const rawHistory = await convertToModelMessages(opts.uiMessages, { tools });
  // Chat mode declares no tools, so a history still carrying tool calls and
  // results is both the bulk of the payload and, on Anthropic, a hard error
  // ("tool_use without tools"). Strip it whenever the toggle is flipped
  // mid-session; the text of the conversation survives.
  const history = chatMode ? stripToolTraffic(rawHistory) : rawHistory;
  // The system prompt and the per-turn <env> block are both added AFTER
  // compaction, so the compactor cannot see them. Reserve their cost or the
  // thresholds understate the real request. The floor caps the reservation at
  // half the window in case the system prompt is huge (a big TEDI.md).
  const fullContextLimit = getModelContextLimit(modelInfo.id);
  const systemTokenEstimate = Math.ceil(systemText.length / 4);
  const ENV_AND_OUTPUT_RESERVE = 2000;
  const effectiveContextLimit = Math.max(
    Math.floor(fullContextLimit / 2),
    fullContextLimit - systemTokenEstimate - ENV_AND_OUTPUT_RESERVE,
  );
  const compact = compactModelMessagesDetailed(history, effectiveContextLimit);
  if (compact.compacted && (compact.stages.elided > 0 || compact.stages.dropped > 0)) {
    // Lossless stale-read cleanup is routine request hygiene, not context
    // compaction. Keep it out of user-facing badges and history metadata.
    opts.onCompact?.({ droppedCount: compact.droppedCount, stages: compact.stages });
  }

  const baseMessages: ModelMessage[] = [
    { role: "system", content: systemText },
    ...compact.messages,
  ];
  // ULTRATHINK rides on the newest USER message, not the system one.
  //
  // It is turn-scoped text, and the system message is the cached prefix: BP1
  // marks that whole message, and on Anthropic a change to system content
  // invalidates the system cache AND every cached turn of the conversation
  // behind it - so one "ultrathink" re-processed the entire history uncached to
  // deliver 321 characters. Here the divergence is confined to the newest user
  // message, which is new bytes every turn anyway.
  //
  // The trade-off, stated because it is not free: the directive is NOT persisted
  // into the stored UI message, so next turn replays that message without it and
  // the prefix diverges at that point. For an occasional "ultrathink" among
  // ordinary turns - the common case - that is far cheaper than the two whole-
  // history rewrites the system-message placement cost. For a user who types it
  // on EVERY turn it is slightly worse, because the old placement kept the
  // system block byte-identical across consecutive ultrathink turns. If that
  // ever matters, the fix is the one `<env>` already uses: remember the block
  // per message id and replay it (`envContext.ts`), not a move back into system.
  if (ultrathink) {
    const i = findLastIndex(baseMessages, (m) => m.role === "user");
    const m = i >= 0 ? baseMessages[i] : null;
    if (m) {
      // `convertToModelMessages` emits either shape depending on the UI message,
      // and concatenating onto a parts array would stringify to "[object Object]".
      baseMessages[i] = {
        ...m,
        content:
          typeof m.content === "string"
            ? m.content + ULTRATHINK_DIRECTIVE
            : [...m.content, { type: "text", text: ULTRATHINK_DIRECTIVE }],
      } as ModelMessage;
    } else {
      // No user message survived compaction, so there is nowhere cheap to put
      // it. Fall back to the system message rather than dropping the directive
      // silently: the user asked for deeper reasoning and a no-op would look
      // like the model simply ignored them.
      baseMessages[0] = { role: "system", content: systemText + ULTRATHINK_DIRECTIVE };
    }
  }
  const finalMessages = applyCacheBreakpoints(baseMessages, provider);

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
  // A prompt-level orchestration mandate is unreliable: many models read files
  // inline instead of calling run_subagents. So pin step 0 to run_subagents and
  // require a tool call (opencode's trick, applied per-turn). Endpoints ignoring
  // toolChoice are unaffected. Only step 0, so the model still synthesizes.
  // `"run_subagents" in tools` already covers the picker: applyToolFilter ran
  // before this, so a switched-off spawn tool is simply absent.
  const forceSpawnStep0 = !!tools && "run_subagents" in tools && wantsForcedFanout(latestUserText);

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
        // The Debug view must report what was SENT; a reasoning level that never
        // reached the request would otherwise look applied.
        ...(reasoningChoice ? { reasoningEffort: reasoningChoice } : {}),
        ...(chatMode ? { chatMode: true } : {}),
      },
      system: systemText,
      messages: finalMessages,
      tools: Object.entries(tools ?? {}).map(([name, t]) => ({
        name,
        description: (t as { description?: string } | undefined)?.description,
      })),
    });
  }

  return streamText({
    model,
    messages: finalMessages,
    ...(coreTemperature !== undefined ? { temperature: coreTemperature } : {}),
    // Per-provider request options: ChatGPT's mandatory `store: false`, and
    // OpenAI's prompt-cache key + 24h retention. See `providerRequestOptions`.
    ...providerRequestOptions(
      provider,
      opts.toolContext.getSessionId(),
      modelInfo.id,
      reasoningChoice,
    ),
    tools,
    // SDK infers a specific ToolSet from `tools` and refuses our generic
    // `StopCondition<ToolSet>[]`. Predicates only touch common fields, so
    // a structural cast is safe.
    stopWhen: trackingStopWhen as never,
    // Two jobs per step:
    //  1. Compact BETWEEN steps. The turn-start pass cannot see the tool results
    //     the loop then piles up, and those are re-sent every later step. This is
    //     the main lever on cache-less providers.
    //  2. Pin step 0 to run_subagents when asked (forceSpawnStep0).
    prepareStep: (({
      stepNumber,
      messages: stepMessages,
    }: {
      stepNumber: number;
      messages: ModelMessage[];
    }) => {
      // Provider-aware: on a caching provider this only compacts once the
      // payload is genuinely large, because eliding an old result invalidates
      // the cached prefix after it.
      const compacted = compactStepMessages(stepMessages, provider);
      // Re-mark per step so the rolling BP3 has a tool tail to land on; at turn
      // start there is none, and the tail was re-sent uncached every step.
      const messages = applyStepCacheBreakpoints(compacted, provider);
      // Step 0 only, and it OVERRIDES the turn's `activeTools` on purpose: the
      // point is to force the first call to be a fan-out. Every later step falls
      // back to the turn-stable set passed to `streamText`.
      return forceSpawnStep0 && stepNumber === 0
        ? { messages, activeTools: ["run_subagents"], toolChoice: "required" }
        : { messages };
    }) as never,
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
      if (opts.onStep && (step.toolCalls?.length || step.text)) {
        opts.onStep(describeStep(step));
      }
      if (step.usage) {
        const u = step.usage;
        const cachedInputTokens = u.inputTokenDetails?.cacheReadTokens ?? 0;
        // A real cache read proves this endpoint caches, whatever the table
        // says. Recording it stops the per-step history rewrite that would
        // otherwise keep invalidating the prefix it just cached.
        if (cachedInputTokens > 0) noteProviderCacheRead(provider);
        opts.onUsage?.({
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cachedInputTokens,
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
