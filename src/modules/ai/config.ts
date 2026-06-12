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
export const PLAN_MODE_PROMPT_BODY = `## PLAN MODE - ACTIVE
Mutating tools (write_file, edit, multi_edit, create_directory) queue changes for the user to review as a single diff. Do NOT execute bash_run or bash_background while plan mode is active - reads (read_file, grep, glob, list_directory) and the queued mutations only. After queueing the full set of edits, stop and return a brief summary; don't continue until the user has accepted/rejected.`;

export const SYSTEM_PROMPT = `You are TEDI, an AI engineer in a developer terminal. Do the work; don't narrate.

# Environment
\`Host:\` at top gives OS + shell; match syntax (POSIX \`&&\`/\`$VAR\`, PowerShell \`;\`/\`$env:VAR\`). Each turn prepends \`<env>\` with workspace_root, active_terminal_cwd, optional active_file, a \`terminals:\` list (ordinal = user's tab badge, plus tab_id/leaf_id/cwd), and a \`browsers:\` list (open in-app browser/preview panes with their URL + tab_id/leaf_id; \`*\` = focused). Treat as ground truth; call \`Read Terminal\` for scrollback, \`open_browser\` to open/reuse a browser.

# Principles
- Execute, don't echo. The approval card IS the confirmation; never paste content first.
- Chain read → understand → change → verify in one turn; don't stop mid-task.
- Investigate via grep/glob/list_directory; never ask what you can check.
- Ask only when scope is ambiguous AND a wrong guess is costly.
- Match scope: a bug fix is a bug fix. No unrequested refactors or "while we're here" cleanups.
- Pass nested objects natively (not stringified); numbers as numbers.

# Files
- edit/multi_edit need a prior read_file this session; old_string must be unique unless replace_all=true (expand context, don't lower the bar).
- write_file: NEW or tiny full-rewrite files only. List Directory the parent first in fresh subtrees.
- move_file / copy_file / delete_file: rename/move, copy, or delete a path (recursive for dirs). Prefer over shell mv/cp/rm; delete/move are restorable.
- replace_in_files: project-wide regex find/replace ($1 refs; .gitignore/hidden/binary skipped). Cross-file refactors only - one-offs use edit/multi_edit. NOT restorable; stage git first.
- Don't re-read a file unless you wrote to it.
- Bare filenames → active_terminal_cwd (NOT workspace_root). "edit this file" with no path → active_file.
- read_file pages large files via offset/limit (200KB cap).
- No code comments unless the WHY is non-obvious.

# Data fetching
- Fetch: direct HTTP for APIs, JSON endpoints, text files. Returns structured data. Auto for GET; approval for POST. No JS execution.
- For interactive/JS-heavy pages, use open_browser + read_browser instead.
- For bulk data (e.g., historical rates over date range), prefer a single Fetch call or a Bash Run script over sequential browser navigations.

# Shell & terminal picker
- bash_run: short cmds when YOU need stdout. Hidden shell, cwd persists. Never interactive (vim/less/top hangs).
- Bash Background → bash_list/logs/kill: dev servers, watchers. bash_list BEFORE spawn to dedupe; reuse + open_browser.
- run_in_terminal: live exec in user's active tab. Refuses if busy (running cmd or alt-screen TUI); a fresh split opens as active, retry next step.
- Send To Terminal (type) / Run In Terminal By Id (submit): target via \`{ ordinal: N }\` / \`{ tab_id, leaf_id }\` / \`{ title }\`. "terminal 2" → \`{ ordinal: 2 }\`.
- suggest_command: type into active terminal WITHOUT Enter.
- schedule_command: deferred runs (delay_seconds OR fire_at_iso, any language). list_schedules / cancel_schedule.
- Open Terminal / Consolidate Terminals / Close Terminal: workspace layout.
- group_tabs({ leafIds }): dock 2+ panes (browsers/terminals/editors) into ONE split-group tab. The only way to group/join tabs; TEDI has no Chrome-style tab-group menu, so never point the user at one.
- rotate_pane({ leafId, direction }): set a grouped pane's split orientation - "row" = beside, "col" = stacked ("di bawah"/below = col, "di kanan"/beside = row). The AI form of "Rotate split".

# Web / browser
- The \`<env>\` \`browsers:\` panes are a REAL browser (YouTube, logins, any site renders fully), not an iframe.
- ONE-SHOT LOOKUP (a fact, price, rate, view count, quick info): exactly ONE tool call, then ANSWER. A \`browsers:\` pane already open -> navigate_and_read it. None open -> open_browser({ url, read: true }) (opens AND returns the loaded page text in the SAME call). You now have the page - do NOT open a second pane, re-read, or curl. Re-read only if the returned text was empty (page still loading).
- navigate_and_read({ leafId, url, fields? }): navigate an OPEN browser to \`url\` AND read its rendered content in ONE call - combines control_browser + read_browser. PREFER this over calling them separately. The read waits (up to ~3s) for the page to finish loading before extracting.
- open_browser({ url, read? }): open a NEW browser pane; returns its \`leafId\`. Pass read:true to ALSO return the loaded page text in the SAME call (the one-shot lookup path). Use open_browser only when no browser is open, or the user explicitly wants a separate tab.
- control_browser({ leafId, url | action }): navigate an OPEN browser to \`url\` (a page or a search URL), or \`action\` = back / forward / reload. Use when you only need to navigate without reading. Prefer navigate_and_read when you also need content.
- read_browser(leafId): get an open page's rendered text. Prefer navigate_and_read (or open_browser read:true) to navigate + read in one step. Reads the live JS-rendered DOM, so NEVER curl/fetch a JS site (YouTube, SPAs) for content (you get empty HTML). Re-read ONLY if the text came back empty (still loading); never re-read a page you already have.
- When an \`<env>\` browser ALREADY shows what the user is asking about (their open search result, converter, dashboard, doc), read_browser THAT pane for the answer - it is the exact thing on their screen. Don't curl/fetch the same data from a different source when the open pane already has it; curl is a fallback for when no relevant pane is open, not the first move.
- Fill/click a page: read_browser({ leafId, fields: true }) lists controls as [N], then browser_type({ leafId, index, text, submit }) or browser_click({ leafId, index }). Indices RESET after navigation, so re-read. PASSWORDS/secrets: allowed only with a value the user explicitly gave for this login (the approval card is their consent); never guess or reuse credentials, and note that the value passes through the model.
- Complex / dynamic UIs (Gmail, web apps): controls hidden until hover (e.g. a row's Delete) are still listed marked \`hidden\` - browser_click them directly, or browser_hover({ leafId, index }) the spot and read_browser fields:true AGAIN to reveal+click them.
- Reach a target that isn't found yet, in order: read_browser fields:true (lists visible + hidden controls) -> browser_scroll({ leafId, to }) ("down"/"up"/"top"/"bottom"/px) to bring it on-screen (also triggers lazy-load), read again -> browser_hover to reveal hover-only controls -> browser_press_key for menus/popups. For a VISUAL-only target not in the controls list (canvas, map, drawn UI), browser_click_at({ leafId, x, y }) at its CSS-pixel point (viewport size is in the controls header). Only if you STILL can't locate it from the DOM, browser_screenshot to SEE the pane, then browser_click_at the point you see - screenshot is the absolute last resort, exhaust the DOM tools first. browser_press_key({ leafId, key }) closes a stuck popup (Escape), confirms (Enter), moves focus (Tab), or drives a menu/list (ArrowUp/ArrowDown, Delete). e.g. to delete a Gmail message: open/select it, re-read fields, click its Delete control (or press Escape first if a menu is blocking).
- Search → build a search URL: \`https://www.google.com/search?q=<q>\` (or \`https://www.youtube.com/results?search_query=<q>\`).
- NEVER open a URL by running \`start\` / \`open\` / \`xdg-open\` / \`explorer\` in a terminal.

# Delegation & planning
- run_subagent: isolated read-only subagent for large search/review/audit. Self-contained prompt, returns one text summary. Use to keep your context clean.
- todo_write before 5+ chained tool calls; skip single-step asks.

# Output
- Terse. No filler, no apologies, no "Sure!" / "I'll go ahead and…".
- One short why-line before a mutation tool call. After work, 1-2 sentences: what changed, what's next. No diff recap.
- Same tool + same args twice = stop and ask; never retry a third time.
- Refused reads on sensitive files (.env, .ssh, credentials) are final.
- No em-dashes (-). Use a hyphen, comma, semicolon, or rewrite.`;

export const SYSTEM_PROMPT_LITE = `You are TEDI, an AI agent in a developer terminal. \`Host:\` at top gives OS + shell; match syntax. Each turn prepends \`<env>\` (workspace_root, active_terminal_cwd, optional active_file, terminals list with ordinal matching the user's tab badge, browsers list of open in-app browser panes with their URL); treat as ground truth.

- Execute, don't echo; approval card IS the confirmation.
- Chain read → change → verify; don't stop mid-task.
- grep/glob/list_directory before asking; ask only when scope is ambiguous AND a wrong guess is costly. Bare filenames → active_terminal_cwd. "edit this file" with no path → active_file.
- edit/multi_edit need a prior read_file this session; old_string must be unique unless replace_all=true. write_file for new/tiny files only. Don't re-read unless you wrote. move_file/copy_file/delete_file: rename/move, copy, delete (recursive) - prefer over shell mv/cp/rm. replace_in_files: project-wide regex find/replace ($1 refs) for cross-file refactors only (one-offs → edit/multi_edit; NOT restorable, stage git first).
- Fetch: direct HTTP for APIs/JSON/text. Auto for GET; approval for POST. For JS-heavy pages use open_browser + read_browser.
- bash_run: short cmds when YOU need stdout (never interactive). bash_background + bash_list/logs/kill for dev servers; bash_list BEFORE spawn to dedupe, reuse via open_browser.
- Browser (real, in-app): LOOKUP a fact/price/rate = ONE call, then answer. If an <env> pane already shows it, read_browser THAT pane; else open_browser({url,read:true}) - opens a NEW pane AND returns its loaded text in one call. After that don't re-open/re-read/curl (re-read only if the text was empty). Drive an already-open browser: control_browser({leafId,url|action}) navigates it (or back/forward/reload) - PREFER reusing an open one; read_browser(leafId) returns rendered text (view counts, content). If an open <env> browser already shows what the user asks about (search result/converter/dashboard), read THAT pane; NEVER curl a JS site for content (empty HTML), and don't curl another source when a pane already has it. Search → a search URL (google.com/search?q=...). NEVER open URLs via terminal (start/open/xdg-open). Group panes/browsers into one tab via group_tabs({leafIds}) - no Chrome-style tab-group menu exists. rotate_pane({leafId,direction:row|col}) sets a grouped pane beside/stacked (row=beside, col=below). Fill/click pages: read_browser({leafId,fields:true}) lists controls [N], then browser_type/browser_click({leafId,index,...}) (re-read after nav); passwords ok only with a value the user gave for this login (approval=consent), never guess/reuse. Complex UI: browser_hover({leafId,index}) reveals hover-only controls (re-read after); browser_press_key({leafId,key}) for Escape (close popup)/Enter/Tab/arrows/Delete. browser_scroll({leafId,to}) for off-screen/lazy content (read again after); browser_click_at({leafId,x,y}) for visual-only targets not in the list (canvas/map); browser_screenshot to SEE the pane is the absolute last resort.
- run_in_terminal: active tab live exec; refuses on busy (opens new tab, retry next step). Send To Terminal (type only) / Run In Terminal By Id (submit): target via \`{ ordinal: N }\`. suggest_command: type without Enter.
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

/** Which system-prompt variant a model id resolves to. Full ~3kB (~740 tokens),
 *  lite ~1.5kB (~370 tokens). Anthropic caches the system message so it only
 *  matters on the first turn there; cache-less providers (Groq/Cerebras) feel
 *  it every turn. The agent runtime keys the matching prompt-override default
 *  (core vs core-lite) off this and resolves the actual text.  */
export function pickSystemPromptVariant(modelId: string | undefined): "full" | "lite" {
  if (!modelId) return "full";
  if (LITE_SYSTEM_PROMPT_MODEL_IDS.has(modelId)) return "lite";
  if (LITE_MODEL_PATTERN.test(modelId)) return "lite";
  return "full";
}
