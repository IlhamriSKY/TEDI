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

/** Replace the detected models for ONE openai-compatible instance, leaving
 *  other instances' models untouched. Instance ownership is read from each
 *  model id's `<instanceId>::` namespace. Use this instead of
 *  `setDetectedModels("openai-compatible", …)` so multiple endpoints coexist. */
export function setDetectedModelsForInstance(instanceId: string, models: ModelInfo[]): void {
  for (const [id, info] of dynamicModels) {
    if (info.provider !== "openai-compatible") continue;
    const parsed = parseOpenAICompatibleModelId(id);
    if (parsed?.instanceId === instanceId) dynamicModels.delete(id);
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

/**
 * Normalize a user-entered OpenAI-compatible base URL before it is fetched:
 *  - trims surrounding whitespace,
 *  - strips trailing slash(es) so `${url}/models` always joins cleanly,
 *  - rewrites a bare `localhost` host to the IPv4 literal `127.0.0.1`.
 *
 * The last rule is the load-bearing one. On Windows `localhost` resolves to
 * IPv6 `::1` first, but most local model servers (9Router, LM Studio,
 * llama.cpp, Ollama) bind only IPv4. The WebView's native `fetch` then tries
 * `::1`, is refused, and surfaces a bare "Failed to fetch" with no status -
 * exactly the detection failure local-router users hit. The IPv4 literal
 * sidesteps the resolution order. Only the exact `localhost` host is rewritten:
 * a user who truly needs IPv6 can type `[::1]`, and a domain merely containing
 * "localhost" (e.g. `localhost.example.com`) is left untouched.
 */
export function normalizeOpenAICompatibleBaseURL(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.replace(/^(https?:\/\/)localhost(?=[:/?#]|$)/i, "$1127.0.0.1");
}

/**
 * A single user-configured OpenAI-compatible endpoint. Multiple instances can
 * coexist (e.g. one for OpenRouter, one for a local router, one for a company
 * gateway). The provider TYPE stays `"openai-compatible"`; instances are the
 * concrete endpoints behind that type. `id` is stable and used to key the
 * keychain account (`openai-compatible-api-key:<id>`) and to namespace detected
 * model ids. `label` and `baseURL` are persisted in the settings store; the API
 * key lives only in the OS keychain.
 */
export type OpenAICompatibleInstance = {
  id: string;
  label: string;
  baseURL: string;
};

/** Stable id of the migrated single-endpoint instance. Keeps the legacy
 *  keychain account (`openai-compatible-api-key`, no suffix) addressable so a
 *  user who configured the single endpoint before this change keeps working. */
export const OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID = "default";

/** Keychain account for an instance's API key. The legacy/default instance
 *  reuses the original unsuffixed account so the pre-existing key is preserved;
 *  every other instance gets a per-id suffix. */
export function openaiCompatibleKeyringAccount(instanceId: string): string {
  return instanceId === OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID
    ? "openai-compatible-api-key"
    : `openai-compatible-api-key:${instanceId}`;
}

/** Separator between an instance id and the raw model id in a namespaced id.
 *  Picked as `::` to avoid colliding with provider-style `/` paths in model
 *  ids (e.g. `openai/gpt-oss-20b`) and the `:` some ids carry (e.g. `:free`). */
const OAI_COMPAT_MODEL_SEP = "::";

/** Build the namespaced runtime model id for a detected model on an instance. */
export function openaiCompatibleModelId(instanceId: string, rawModelId: string): string {
  return `${instanceId}${OAI_COMPAT_MODEL_SEP}${rawModelId}`;
}

/** Split a namespaced model id back into `{ instanceId, rawModelId }`, or
 *  `null` when the id is not namespaced (a plain model id). */
export function parseOpenAICompatibleModelId(
  modelId: string,
): { instanceId: string; rawModelId: string } | null {
  const idx = modelId.indexOf(OAI_COMPAT_MODEL_SEP);
  if (idx === -1) return null;
  return {
    instanceId: modelId.slice(0, idx),
    rawModelId: modelId.slice(idx + OAI_COMPAT_MODEL_SEP.length),
  };
}

/** Runtime resolution data for one openai-compatible instance: the base URL
 *  and (in-memory only) API key needed to build the language model. Populated
 *  by the detection layer when models are refreshed; never persisted here. */
type OpenAICompatibleRuntime = { baseURL: string; apiKey: string };
const oaiCompatRuntime = new Map<string, OpenAICompatibleRuntime>();

/** Register (or update) the runtime base URL + key for an instance so the
 *  agent can resolve them from a namespaced model id. Key stays in memory; it
 *  is sourced from the OS keychain by the caller, never written back to disk. */
export function setOpenAICompatibleRuntime(
  instanceId: string,
  baseURL: string,
  apiKey: string,
): void {
  oaiCompatRuntime.set(instanceId, { baseURL, apiKey });
}

/** Drop an instance's runtime resolution data (on key removal / instance delete). */
export function clearOpenAICompatibleRuntime(instanceId: string): void {
  oaiCompatRuntime.delete(instanceId);
}

/** Resolve `{ baseURL, apiKey }` for a namespaced openai-compatible model id.
 *  Returns `null` when the id isn't namespaced or the instance is unknown, so
 *  the caller can fall back to the legacy single-endpoint values. */
export function resolveOpenAICompatibleModel(
  modelId: string,
): (OpenAICompatibleRuntime & { instanceId: string; rawModelId: string }) | null {
  const parsed = parseOpenAICompatibleModelId(modelId);
  if (!parsed) return null;
  const rt = oaiCompatRuntime.get(parsed.instanceId);
  if (!rt) return null;
  return { ...rt, ...parsed };
}

/** Preset endpoints surfaced as quick-pick chips inside the OpenAI
 *  Compatible block in Settings → Models. Each entry pre-fills the base
 *  URL so a user pasting an OpenRouter or 9Router key doesn't have to
 *  remember the `/api/v1` (OpenRouter) or `127.0.0.1:20128/v1` (9Router)
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
    baseURL: "http://127.0.0.1:20128/v1",
    description: "Self-hosted router, default port",
  },
] as const;
/** Per-turn cap on agent tool-call steps. 15 (was 24) matches industry
 *  baselines (Claude Code ~15, Cursor ~12). Shorter rope for runaway loops. */
export const MAX_AGENT_STEPS = 15;
export const TERMINAL_BUFFER_LINES = 300;

/** Default plan-mode appendix. Lives here (with the other base prompt text) so
 *  both the agent runtime and the prompt-override settings UI can reference it
 *  as the reset-to-default baseline. The agent joins it to the system prompt
 *  with a blank-line separator; the stored override holds only this body. */
export const PLAN_MODE_PROMPT_BODY = `## PLAN MODE
Queue all mutations for one review diff. Do NOT use bash_run or bash_background. Allowed work: read_file, grep, glob, list_directory, and queued mutations only. After queueing the intended edits, stop and return a brief summary. Wait for accept/reject before continuing.`;

/** Appended to the system prompt whenever sub-agents are enabled
 *  (Settings -> Agents -> Sub-agents - a single on/off that also covers
 *  orchestration). Makes the agent decompose broad read-only work into parallel
 *  sub-agents with a synthesis step instead of exploring inline. Editable via the
 *  prompt-override settings UI ("orchestration"). */
export const ORCHESTRATION_PROMPT_BODY = `## SUB-AGENT ORCHESTRATION
MANDATE: when the user asks you to study, explore, understand, review, audit, map, explain, scope a refactor or migration, analyze tests or docs, or trace a bug - anything touching more than one file - your FIRST tool call MUST be a single \`run_subagents\` call that fans the work out. Do NOT read or list files one by one for these tasks. At most one cheap orienting step is allowed first: a single root \`list_directory\`, or \`git diff\` / \`git status\` for a review.

Example - asked to "study this project", your first call is \`run_subagents\` with parallel tasks: {comet: app and UI structure}, {comet: core modules and services}, {comet: build and tooling config}, {nebula: key dependencies}. Then you synthesize their summaries. You never open files one at a time for this.

Principle: work from the goal, not a recipe. Default to delegation and parallel execution; do not stop until the result is verified. Stay efficient: do small, single-file, or trivial work inline.

\`run_subagent\` runs ONE isolated question; \`run_subagents\` fans out in parallel and may use \`depends_on\` for scatter -> gather. Each runs with a fresh history and its own tools, so every prompt must be self-contained.

Roster - delegate to the agent that fits each task:
- comet (exploration, read-only): find files, code, and patterns in THIS codebase.
- nebula (exploration, read-only): understand third-party libraries and dependencies from their installed source and docs.
- nova (advisor, read-only): hard debugging, architecture decisions, multi-system trade-offs, security/perf concerns, self-review of significant work.
- orbit (advisor, read-only): pre-planning analysis of an ambiguous or complex request (intent, scope, risks) before you plan.
- eclipse (advisor, read-only): review a plan or proposed changes for executability before you commit to them.
- odyssey (worker): autonomously IMPLEMENT a well-scoped change end to end - it edits/creates/moves/deletes files and runs commands, then verifies. It runs without approval cards (changes are checkpointed), so hand it a tight, self-contained brief.

Delegate by area, module, or concern, picking the agent that fits each task. Do not survey the codebase inline.

To carry out implementation work without cluttering your own context, or to apply several independent changes at once, delegate to \`odyssey\`. If you run workers in parallel, give each a disjoint set of files so their edits cannot collide.

Synthesize returned summaries yourself. Add a final gather task only when the synthesis must read more files. This rule also applies in plan mode before queueing mutations.

Work inline only for small single-file or single-symbol questions or edits, command execution, or trivial requests.`;

/** Compact orchestration prompt for lite/fast models (gpt-5-mini, flash, haiku)
 *  where context budget is tight. Covers the same delegation semantics in ~50%
 *  fewer tokens. */
export const ORCHESTRATION_PROMPT_BODY_LITE = `## SUB-AGENT ORCHESTRATION (enabled)
MANDATE: for ANY task touching more than one file (study, explore, understand, review, audit, explain, refactor/migration scope, test or doc analysis, bug tracing), your FIRST tool call MUST be ONE \`run_subagents\` call - do NOT read files one by one. e.g. "study this project" -> \`run_subagents\` with a parallel explore task per area, then synthesize.
Agents: comet (this codebase), nebula (dependencies), nova (hard debugging/architecture/self-review), orbit (pre-planning scope), eclipse (plan/change review) - all read-only; odyssey (worker) edits files + runs commands to IMPLEMENT a scoped change (autonomous, checkpointed). Delegate implementation to odyssey; parallel workers touch disjoint files. Synthesize results yourself. Do small/single-file work inline.`;

export const SYSTEM_PROMPT = `You are TEDI, an AI engineer in a developer terminal. Do the work; do not narrate.

# Environment
\`Host:\` at top gives OS + shell; match syntax. Each turn prepends \`<env>\` with \`workspace_root\`, \`active_terminal_cwd\`, optional \`active_file\`, a \`terminals:\` list (ordinal matches the user's tab badge), and a \`browsers:\` list (open in-app browser panes with URL; \`*\` = focused). Treat it as ground truth. Use \`Read Terminal\` for scrollback and \`open_browser\` to open or reuse a browser.

# Principles
- Execute, do not echo. The approval card is the confirmation.
- Prefer one turn: read → understand → change → verify.
- Check with grep/glob/list_directory before asking. Ask only when ambiguity is costly.
- Keep scope tight. No unrequested refactors or side quests.
- Pass objects and numbers natively.

# Files
- \`edit\` / \`multi_edit\` need a prior \`read_file\` this session; \`old_string\` must be unique unless \`replace_all=true\`.
- \`write_file\` is for new or tiny full rewrites. List the parent first in fresh subtrees.
- Prefer \`move_file\` / \`copy_file\` / \`delete_file\` over shell mv/cp/rm. Use \`replace_in_files\` only for cross-file regex refactors; it is not restorable.
- Do not re-read a file unless you wrote it. Bare filenames resolve from \`active_terminal_cwd\`. "edit this file" with no path means \`active_file\`.
- \`read_file\` supports paging. Add code comments only when the why is non-obvious.

# Fetch and shell
- \`Fetch\` is for APIs, JSON, and text: GET auto, POST approval, no JS execution. Use browser tools for JS-heavy pages.
- For bulk retrieval, prefer one Fetch call or one \`bash_run\` script over many page navigations.
- \`bash_run\` is for short stdout commands, never interactive. Use Bash Background plus \`bash_list\` / logs / kill for servers and watchers; check \`bash_list\` first.
- \`run_in_terminal\` uses the live active tab and may refuse if busy. Target terminal actions by ordinal, \`tab_id\`, \`leaf_id\`, or title. \`suggest_command\` types without Enter. \`schedule_command\` defers work. \`group_tabs\` joins panes; \`rotate_pane\` sets row or col splits.

# Browser
- \`<env>\` browsers are real pages, not iframes.
- Fact lookup: exactly ONE browser call, then answer. Reuse an open pane with \`navigate_and_read\`; otherwise use \`open_browser({ url, read: true })\`. Do not open duplicates or curl the same page. Re-read only if the page was still loading.
- Prefer \`navigate_and_read\` when you need both navigation and content. Reuse one research tab by default; \`new_tab:true\` only when the user asks or a separate tab is required.
- \`read_browser\` returns rendered DOM text, so do not curl or fetch JS-heavy sites for content. If an open pane already shows the answer, read that pane instead of another source.
- For forms or clicks: \`read_browser({ fields: true })\` then \`browser_type\` / \`browser_click\`. Re-read after navigation because indices reset. Use passwords only when the user explicitly gave them for that login.
- For complex UI: scroll → read again → hover → press key. Use \`browser_click_at\` only for visual-only targets. \`browser_screenshot\` is the last resort.
- Search by opening a search URL. Never open URLs via terminal commands.

# Delegation and output
- Use \`run_subagent\` / \`run_subagents\` for broad read-only analysis; prefer parallel \`run_subagents\` for multi-scope work. Use \`todo_write\` before 5+ chained tool calls.
- Be terse. No filler or apologies.
- Before a mutation tool, give one short why-line. After work, give 1-2 sentences covering what changed and what is next.
- If the same tool with the same args fails twice, stop and ask. Refused reads on sensitive files (.env, .ssh, credentials) are final.
- In prose and docstrings, do not use em dash punctuation. Use a hyphen, comma, semicolon, colon, or rewrite. In code, keep exact punctuation only when it is literally required.`;

export const SYSTEM_PROMPT_LITE = `You are TEDI, an AI agent in a developer terminal. \`Host:\` gives OS + shell; match syntax. Each turn prepends \`<env>\` with \`workspace_root\`, \`active_terminal_cwd\`, optional \`active_file\`, terminal ordinals, and open browser panes. Treat it as ground truth.

- Execute, do not echo; the approval card is the confirmation.
- Prefer read → change → verify in one turn. Check with grep/glob/list_directory before asking; ask only when ambiguity is costly.
- Bare filenames resolve from \`active_terminal_cwd\`. "edit this file" with no path means \`active_file\`.
- \`edit\` / \`multi_edit\` need a prior \`read_file\`; \`old_string\` must be unique unless \`replace_all=true\`. \`write_file\` is for new or tiny full rewrites. Do not re-read unless you wrote. Prefer \`move_file\` / \`copy_file\` / \`delete_file\` over shell mv/cp/rm. Use \`replace_in_files\` only for cross-file regex refactors.
- Use \`Fetch\` for APIs, JSON, and text; use browser tools for JS-heavy pages. Use \`bash_run\` only for short non-interactive stdout commands. Use Bash Background plus \`bash_list\` / logs / kill for long-lived processes.
- Browser: one lookup call, then answer. If an open pane already has the answer, read it. Otherwise use \`open_browser({ url, read: true })\` or \`navigate_and_read\`. Reuse one research tab by default. Do not duplicate panes or curl JS-heavy pages. For forms: \`read_browser({ fields: true })\` then \`browser_type\` / \`browser_click\`, re-reading after navigation. For complex UI: scroll → read again → hover → press key. \`browser_click_at\` only for visual-only targets; screenshot is last resort. Never open URLs via terminal commands.
- \`run_in_terminal\` uses the live tab and may refuse if busy; target terminal actions by ordinal. \`suggest_command\` types without Enter. \`schedule_command\` defers work. \`group_tabs\` joins panes; \`rotate_pane\` sets row or col splits.
- Use \`run_subagent\` / \`run_subagents\` for broad read-only work; prefer parallel \`run_subagents\`.
- Pass objects and numbers natively. If the same tool with the same args fails twice, stop. Refused reads on sensitive files are final.
- Be terse. In prose and docstrings, do not use em dash punctuation; use a hyphen, comma, semicolon, colon, or rewrite. In code, keep exact punctuation only when it is literally required.`;

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

/** Which system-prompt variant a model id resolves to. Full keeps richer tool
 *  guidance; lite trims detail for tighter budgets. Anthropic caches the system
 *  message so the cost mostly matters on turn one there; cache-less providers
 *  (Groq/Cerebras) feel it every turn. The agent runtime keys the matching
 *  prompt-override default (core vs core-lite) off this and resolves the actual
 *  text. */
export function pickSystemPromptVariant(modelId: string | undefined): "full" | "lite" {
  if (!modelId) return "full";
  if (LITE_SYSTEM_PROMPT_MODEL_IDS.has(modelId)) return "lite";
  if (LITE_MODEL_PATTERN.test(modelId)) return "lite";
  return "full";
}
