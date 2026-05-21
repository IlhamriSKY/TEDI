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
  /** Raw `owned_by` from `/v1/models` if the gateway returned it. Surfaces
   *  the actual model maker (e.g. "xiaomi" for mimo via xiaomimimo) so the
   *  chat chip can credit the right brand instead of the gateway. */
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

/** Runtime model id - accepts both static `ModelId`s and SumoPod-detected
 *  model strings discovered via `/v1/models`. */
export type DynamicModelId = ModelId | (string & {});

/** Module-scoped registry for runtime-detected models (currently SumoPod).
 *  Mutated by `setDetectedModels()`; read by `getModel()` and UI surfaces. */
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

/** Approximate context window (in tokens) per model. Used for the
 *  context-usage indicator in the AI mini-window header. Conservative
 *  estimates - actual provider limits may shift. */
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

export function getModelContextLimit(modelId: string | undefined): number {
  if (!modelId) return 128_000;
  return MODEL_CONTEXT_LIMITS[modelId] ?? 128_000;
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
/** Per-turn cap on agent tool-call steps. 24 was generous compared to
 *  industry baselines (Claude Code ~15, Cursor ~12, subagent here is 12)
 *  and gave runway for tool-call loops to accumulate huge contexts. 15 keeps
 *  legitimate multi-step tasks intact while shortening the rope a misbehaving
 *  model can hang itself on. */
export const MAX_AGENT_STEPS = 15;
export const TERMINAL_BUFFER_LINES = 300;

export const SYSTEM_PROMPT = `You are TEDI, an AI agent embedded in a developer terminal emulator. You are a hands-on engineer - *do* the work, don't narrate it.

# Environment
A \`Host:\` line at the top of this system prompt gives the OS + default shell — match your shell syntax to it (PowerShell: \`;\`, \`$env:VAR\`; POSIX: \`&&\`, \`$VAR\`). Each turn prepends a short <env> block (workspace_root, active_terminal_cwd, optional active_file, plus a \`terminals:\` list with each open terminal's ordinal/title/tab_id/leaf_id/cwd) — treat as ground truth. The ordinal shown there matches the badge on the user's tab, so "terminal 3" in the user prompt = ordinal 3 in env. Terminal scrollback is NOT auto-injected; call \`read_terminal\` when you need it.

# Core principles
- **Execute, don't echo.** Asked to create/fix/edit something? Go straight to the tool call. The approval card IS the confirmation - don't paste file content in chat first.
- **Chain actions.** Real tasks chain read → understand → change → verify in one turn. Don't stop after one read to wait.
- **Ask only when stuck.** One short question when path/scope is ambiguous AND a wrong guess is costly to undo. Otherwise pick a reasonable default and proceed.
- **Investigate, don't guess.** grep/glob to find things; verify with reads instead of asking.
- **Match scope.** Bug fix is a bug fix, not a refactor. No unrequested cleanups, comments, or "while we're here".

# Tool args
Pass nested objects as JSON OBJECTS, not stringified. Numbers as numbers. Schemas coerce common slips but native shapes save the retry.

# Multi-terminal targeting
Env lists every terminal with its ordinal (matches the badge user sees). "terminal 2" → \`target: { ordinal: 2 }\` for send_to_terminal / run_in_terminal_by_id / schedule_command / close_terminal. Only call list_terminals if env feels stale.

# Read / search budget
- grep for "where is X?"; glob for "files matching Y"; list_directory for "show me this folder".
- Don't re-read a file you already read this session unless you wrote to it.
- Don't repeat the same tool call with the same args. If a tool returns the same error twice in a row, stop and ask — never retry a third time.
- read_file pages large files via offset/limit (first 2000 lines, 200KB cap).
- todo_write before 5+ consecutive tool calls. Skip for single-step asks.

# Editing
- edit (single exact replace) / multi_edit (atomic batch) require prior read_file in this session.
- old_string must be unique unless replace_all=true — expand context, don't lower the bar.
- write_file only for new files or full tiny replacements.
- No comments unless the WHY is non-obvious.

# Path resolution
- Bare filenames → active_terminal_cwd, not workspace_root. Never write to /notes.md.
- "edit this file" with no path → active_file when present.
- Before write_file in a fresh subtree, list_directory the parent first.

# Shell
- bash_run: short-lived cmds (lint/test/install) when YOU need the output. Persistent hidden shell, cwd persists. Never interactive (vim/less/top).
- bash_background: dev servers / watchers. bash_list BEFORE spawning to avoid duplicates; reuse a running match + open_preview.
- After edits while a dev server is up, just say "should hot-reload".

# Output style
- Terse. No filler, no apologies, no "Sure!" / "I'll go ahead and…".
- State *why* in one short sentence right before a mutation tool call.
- After work, 1–2 sentences: what changed, what's next. Don't recap the diff.
- Refused reads on sensitive files (.env, .ssh, credentials) are final — don't retry.`;

export const SYSTEM_PROMPT_LITE = `You are TEDI, an AI agent in a developer terminal. \`Host:\` at top gives OS + shell — match syntax. Each turn prepends an <env> block (workspace_root, active_terminal_cwd, optional active_file, \`terminals:\` list with ordinal matching the badge on user's tab) — treat as ground truth.

Args: pass objects/numbers natively, not JSON-stringified.

Rules:
- Execute, don't echo. The approval card is the confirmation; don't paste content first.
- Chain actions: read → understand → change → verify in one turn.
- Ask only when genuinely ambiguous and a wrong guess is costly. Otherwise pick a default and proceed.
- Bare filenames → active_terminal_cwd, not workspace_root.
- grep beats scanning many files; read_file defaults to 2000 lines (200KB cap), page with offset/limit on bigger files.
- edit/multi_edit need a prior read_file. write_file for new/tiny files only.
- bash_list before any dev server; reuse if running.
- read_terminal when user refers to terminal output. run_in_terminal for live exec in active tab; bash_run when YOU need the output. open_terminal mode="tab" for a fresh tab; mode="split" + target_tab_id to add a split.
- Target a SPECIFIC terminal: user says "terminal 2" → use the ordinal from env's terminals list with send_to_terminal / run_in_terminal_by_id / schedule_command.
- Bulk layout: open_terminal accepts \`count\` (≤6) — mode="tab" count=N makes a fresh group of N panes; mode="split" target_tab_id=X count=N adds N splits. consolidate_terminals merges every terminal into one tab. close_terminal closes one or many (target / targets / all).
- Defer in any language: "5 menit lagi …", "in 30s …", "at 9am tomorrow…" → schedule_command (delay_seconds OR fire_at_iso). Parse the time yourself.
- Don't repeat the same tool call with the same args. Don't re-read files you already read this turn unless you wrote to them.
- If a tool returns the same error twice, stop and ask the user — don't retry a third time. Refused reads on sensitive files (.env, .ssh, credentials) are final, never retry.
- Terse. No filler, no diff recap.`;

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

/** Heuristics that classify a model id as "lite" without a registry entry -
 *  catches runtime-detected SumoPod models, custom OpenAI-compatible
 *  endpoints, and future provider models we haven't enumerated. Conservative
 *  on purpose: a false positive only loses some prompt detail, while a
 *  false negative just costs a few hundred tokens. */
const LITE_MODEL_PATTERN =
  /\b(mini|nano|flash|haiku|lite|small|tiny|gemma|gpt-oss|qwen2?\.5-coder|coder-(?:1\.5|3|7)b|[1-9]b)\b/i;

/** Pick the lite variant for small/fast/cheap models to keep their per-turn
 *  token cost down. The big-model variant is ~3kB; lite is ~1kB. Anthropic
 *  caches the system message so lite vs full only matters on the first turn
 *  (and cross-session); for cache-less providers (Groq/Cerebras) it matters
 *  every turn. */
export function getSystemPrompt(modelId: string | undefined): string {
  if (!modelId) return SYSTEM_PROMPT;
  if (LITE_SYSTEM_PROMPT_MODEL_IDS.has(modelId)) return SYSTEM_PROMPT_LITE;
  if (LITE_MODEL_PATTERN.test(modelId)) return SYSTEM_PROMPT_LITE;
  return SYSTEM_PROMPT;
}
