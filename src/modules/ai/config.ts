export const KEYRING_SERVICE = "tedi";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "cerebras"
  | "groq"
  | "deepseek"
  | "sumopod"
  | "openai-compatible"
  | "lmstudio";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  keyringAccount: string;
  keyPrefix: string | null;
  consoleUrl: string;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    keyringAccount: "openai-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyringAccount: "anthropic-api-key",
    keyPrefix: "sk-ant-",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google",
    keyringAccount: "google-api-key",
    keyPrefix: null,
    consoleUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "xai",
    label: "xAI",
    keyringAccount: "xai-api-key",
    keyPrefix: "xai-",
    consoleUrl: "https://console.x.ai/",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    keyringAccount: "cerebras-api-key",
    keyPrefix: "csk-",
    consoleUrl: "https://cloud.cerebras.ai/",
  },
  {
    id: "groq",
    label: "Groq",
    keyringAccount: "groq-api-key",
    keyPrefix: "gsk_",
    consoleUrl: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyringAccount: "deepseek-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "sumopod",
    label: "SumoPod",
    keyringAccount: "sumopod-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://sumopod.com",
  },
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    keyringAccount: "openai-compatible-api-key",
    keyPrefix: null,
    consoleUrl: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl: "https://lmstudio.ai/docs/basics/server",
  },
] as const;

export function getProvider(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export type ModelInfo = {
  id: string;
  provider: ProviderId;
  label: string;
  hint: string;
  /** Raw `owned_by` from `/v1/models` when the gateway returns it. Lets the
   *  chip credit the maker (e.g. "xiaomi" for mimo) instead of the gateway. */
  ownedBy?: string;
};

export const MODELS = [
  // OpenAI
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    hint: "Fast, default",
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    hint: "Higher quality",
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    label: "GPT-5.3 Codex",
    hint: "Coding",
  },
  // Anthropic
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    hint: "Fast",
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    hint: "Balanced",
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
    hint: "Best",
  },
  // Google
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
    hint: "Best",
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash",
    hint: "Fast",
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    label: "Gemini 2.5 Flash",
    hint: "Most Efficient",
  },
  {
    id: "gemma-4-31b-it",
    provider: "google",
    label: "Gemma 4 31B",
    hint: "Lean & Powerfull",
  },
  // xAI
  {
    id: "grok-4.20-reasoning",
    provider: "xai",
    label: "Grok 4.20 Reasoning",
    hint: "Reasoning",
  },
  {
    id: "grok-4.20-non-reasoning",
    provider: "xai",
    label: "Grok 4.20",
    hint: "Fast",
  },
  // Cerebras (autocomplete-tier)
  {
    id: "gpt-oss-120b",
    provider: "cerebras",
    label: "GPT-OSS 120B",
    hint: "Cerebras · ultra-fast",
  },
  // Groq (autocomplete-tier)
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    hint: "Groq · ultra-fast",
  },
  // DeepSeek
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    hint: "Fast",
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    hint: "Best",
  },
  // LM Studio (local; model id is user-supplied at runtime)
  {
    id: "lmstudio-local",
    provider: "lmstudio",
    label: "LM Studio (local)",
    hint: "Custom local model",
  },
] as const satisfies readonly ModelInfo[];

export type ModelId = (typeof MODELS)[number]["id"];

/** Runtime model id. Accepts static `ModelId`s plus models detected via `/v1/models`. */
export type DynamicModelId = ModelId | (string & {});

/** Module-scoped registry for runtime-detected models. Mutated by `setDetectedModels()`. */
const dynamicModels = new Map<string, ModelInfo>();

export function setDetectedModels(provider: ProviderId, models: ModelInfo[]): void {
  for (const [id, info] of dynamicModels) {
    if (info.provider === provider) dynamicModels.delete(id);
  }
  for (const m of models) dynamicModels.set(m.id, m);
}

export function getDetectedModels(provider: ProviderId): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of dynamicModels.values()) {
    if (m.provider === provider) out.push(m);
  }
  return out;
}

export function getModel(id: DynamicModelId): ModelInfo {
  const m = MODELS.find((x) => x.id === id) ?? dynamicModels.get(id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}

export function tryGetModel(id: DynamicModelId): ModelInfo | undefined {
  return MODELS.find((x) => x.id === id) ?? dynamicModels.get(id);
}

export const DEFAULT_MODEL_ID: ModelId = "gpt-5.4-mini";

/** Approximate context window (tokens) per model. Drives the context-usage indicator. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.4-mini": 400_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.3-codex": 400_000,
  "claude-haiku-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemma-4-31b-it": 265_000,
  "grok-4.20-reasoning": 2_000_000,
  "grok-4.20-non-reasoning": 2_000_000,
  "gpt-oss-120b": 128_000,
  "openai/gpt-oss-20b": 128_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "lmstudio-local": 32_000,
};

/** Fallback context window for unknown/runtime-detected models. 256k since most
 *  providers now ship at least that; lower estimates fire compaction prematurely.
 *  Hard-capped models (e.g. `gpt-oss-*` at 128k) stay accurate via `MODEL_CONTEXT_LIMITS`. */
const FALLBACK_CONTEXT_LIMIT = 256_000;

export function getModelContextLimit(modelId: string | undefined): number {
  if (!modelId) return FALLBACK_CONTEXT_LIMIT;
  return MODEL_CONTEXT_LIMITS[modelId] ?? FALLBACK_CONTEXT_LIMIT;
}

/** Providers that do not require an API key (e.g. local servers). */
export const KEYLESS_PROVIDERS: readonly ProviderId[] = ["lmstudio"] as const;

export function providerNeedsKey(id: ProviderId): boolean {
  return !KEYLESS_PROVIDERS.includes(id);
}

/** Providers eligible for the editor's inline autocomplete (latency-critical). */
export type AutocompleteProviderId = "cerebras" | "groq" | "lmstudio";

export const AUTOCOMPLETE_PROVIDERS: readonly AutocompleteProviderId[] = [
  "cerebras",
  "groq",
  "lmstudio",
] as const;

export const DEFAULT_AUTOCOMPLETE_MODEL: Record<AutocompleteProviderId, string> = {
  cerebras: "gpt-oss-120b",
  groq: "openai/gpt-oss-20b",
  lmstudio: "qwen2.5-coder-7b-instruct",
};

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
export const SUMOPOD_BASE_URL = "https://ai.sumopod.com/v1";
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Preset endpoints surfaced as quick-pick chips inside the OpenAI
 *  Compatible block in Settings → Models. Each entry pre-fills the base
 *  URL so a user pasting an OpenRouter or 9Router key doesn't have to
 *  remember the `/api/v1` (OpenRouter) or `localhost:20128/v1` (9Router)
 *  paths. The presets are pure UX - TEDI still routes everything through
 *  the openai-compatible code path. */
export const OPENAI_COMPATIBLE_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  baseURL: string;
  description: string;
}> = [
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    description: "Official OpenAI API",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    description: "Cloud gateway for 300+ models",
  },
  {
    id: "9router",
    label: "9Router (local)",
    baseURL: "http://localhost:20128/v1",
    description: "Self-hosted router, default port",
  },
] as const;
/** Per-turn cap on agent tool-call steps. 15 (was 24) matches industry
 *  baselines (Claude Code ~15, Cursor ~12). Shorter rope for runaway loops. */
export const MAX_AGENT_STEPS = 15;
export const TERMINAL_BUFFER_LINES = 300;

export const SYSTEM_PROMPT = `You are TEDI, an AI engineer in a developer terminal. Do the work; don't narrate.

# Environment
\`Host:\` at top gives OS + shell; match syntax (POSIX \`&&\`/\`$VAR\`, PowerShell \`;\`/\`$env:VAR\`). Each turn prepends \`<env>\` with workspace_root, active_terminal_cwd, optional active_file, and \`terminals:\` list (ordinal = user's tab badge, plus tab_id/leaf_id/cwd). Treat as ground truth; call \`read_terminal\` for scrollback.

# Principles
- Execute, don't echo. The approval card IS the confirmation; never paste content first.
- Chain read → understand → change → verify in one turn; don't stop mid-task.
- Investigate via grep/glob/list_directory; never ask what you can check.
- Ask only when scope is ambiguous AND a wrong guess is costly.
- Match scope: a bug fix is a bug fix. No unrequested refactors or "while we're here" cleanups.
- Pass nested objects natively (not stringified); numbers as numbers.

# Files
- edit/multi_edit need a prior read_file this session; old_string must be unique unless replace_all=true (expand context, don't lower the bar).
- write_file: NEW or tiny full-rewrite files only. list_directory the parent first in fresh subtrees.
- Don't re-read a file unless you wrote to it.
- Bare filenames → active_terminal_cwd (NOT workspace_root). "edit this file" with no path → active_file.
- read_file pages large files via offset/limit (200KB cap).
- No code comments unless the WHY is non-obvious.

# Shell & terminal picker
- bash_run: short cmds when YOU need stdout. Hidden shell, cwd persists. Never interactive (vim/less/top hangs).
- bash_background → bash_list/logs/kill: dev servers, watchers. bash_list BEFORE spawn to dedupe; reuse + open_preview.
- run_in_terminal: live exec in user's active tab. Refuses if busy (running cmd or alt-screen TUI); a fresh split opens as active, retry next step.
- send_to_terminal (type) / run_in_terminal_by_id (submit): target via \`{ ordinal: N }\` / \`{ tab_id, leaf_id }\` / \`{ title }\`. "terminal 2" → \`{ ordinal: 2 }\`.
- suggest_command: type into active terminal WITHOUT Enter.
- schedule_command: deferred runs (delay_seconds OR fire_at_iso, any language). list_schedules / cancel_schedule.
- open_terminal / consolidate_terminals / close_terminal: workspace layout.

# Delegation & planning
- run_subagent: isolated read-only subagent for large search/review/audit. Self-contained prompt, returns one text summary. Use to keep your context clean.
- todo_write before 5+ chained tool calls; skip single-step asks.

# Output
- Terse. No filler, no apologies, no "Sure!" / "I'll go ahead and…".
- One short why-line before a mutation tool call. After work, 1-2 sentences: what changed, what's next. No diff recap.
- Same tool + same args twice = stop and ask; never retry a third time.
- Refused reads on sensitive files (.env, .ssh, credentials) are final.
- No em-dashes (-). Use a hyphen, comma, semicolon, or rewrite.`;

export const SYSTEM_PROMPT_LITE = `You are TEDI, an AI agent in a developer terminal. \`Host:\` at top gives OS + shell; match syntax. Each turn prepends \`<env>\` (workspace_root, active_terminal_cwd, optional active_file, terminals list with ordinal matching the user's tab badge); treat as ground truth.

- Execute, don't echo; approval card IS the confirmation.
- Chain read → change → verify; don't stop mid-task.
- grep/glob/list_directory before asking; ask only when scope is ambiguous AND a wrong guess is costly. Bare filenames → active_terminal_cwd. "edit this file" with no path → active_file.
- edit/multi_edit need a prior read_file this session; old_string must be unique unless replace_all=true. write_file for new/tiny files only. Don't re-read unless you wrote.
- bash_run: short cmds when YOU need stdout (never interactive). bash_background + bash_list/logs/kill for dev servers; bash_list BEFORE spawn to dedupe, reuse via open_preview.
- run_in_terminal: active tab live exec; refuses on busy (opens new tab, retry next step). send_to_terminal (type only) / run_in_terminal_by_id (submit): target via \`{ ordinal: N }\`. suggest_command: type without Enter.
- schedule_command: deferred runs in any language (delay_seconds OR fire_at_iso). list_schedules / cancel_schedule.
- run_subagent for large search/audit; isolated context.
- Pass objects/numbers natively. Same tool + same args twice = stop. Refused reads on .env/.ssh/credentials are final.
- Terse. No em-dashes (-); use hyphen, comma, semicolon.`;

const LITE_SYSTEM_PROMPT_MODEL_IDS = new Set<string>([
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemma-4-31b-it",
  "claude-haiku-4-5",
  "openai/gpt-oss-20b",
  "gpt-oss-120b",
  "deepseek-v4-flash",
  "grok-4.20-non-reasoning",
]);

/** Heuristic that classifies a model id as "lite" without a registry entry.
 *  Catches runtime-detected SumoPod models, custom OpenAI-compatible endpoints,
 *  and unknown providers. False positives only trim prompt detail. */
const LITE_MODEL_PATTERN =
  /\b(mini|nano|flash|haiku|lite|small|tiny|gemma|gpt-oss|qwen2?\.5-coder|coder-(?:1\.5|3|7)b|[1-9]b)\b/i;

/** Pick the lite system prompt for small/fast/cheap models. Full ~3kB (~740
 *  tokens), lite ~1.5kB (~370 tokens). Anthropic caches the system message
 *  so it only matters on the first turn there; cache-less providers
 *  (Groq/Cerebras) feel it every turn. */
export function getSystemPrompt(modelId: string | undefined): string {
  if (!modelId) return SYSTEM_PROMPT;
  if (LITE_SYSTEM_PROMPT_MODEL_IDS.has(modelId)) return SYSTEM_PROMPT_LITE;
  if (LITE_MODEL_PATTERN.test(modelId)) return SYSTEM_PROMPT_LITE;
  return SYSTEM_PROMPT;
}
