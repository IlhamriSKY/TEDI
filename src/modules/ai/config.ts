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
  | "agentrouter"
  | "openai-compatible"
  | "lmstudio"
  | "chatgpt";
export type ProviderInfo = {
  id: ProviderId;
  label: string;
  keyringAccount: string;
  keyPrefix: string | null;
  consoleUrl: string;
};

// Flat arrays over verbose objects; all fields are positional and used by index
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
    id: "agentrouter",
    label: "AgentRouter",
    keyringAccount: "agentrouter-api-key",
    // No prefix claim: ProviderKeyCard REFUSES to save a key that doesn't match,
    // so guessing here would lock the user out of a perfectly valid token.
    keyPrefix: null,
    consoleUrl: "https://agentrouter.org/console/token",
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
  {
    // Signed in with a ChatGPT account, not a pasted key. `keyringAccount` is
    // still where the credential lives (the whole OAuth token set as JSON), so
    // the keychain stays the one home for secrets - but nothing types a key in,
    // which is why `providerNeedsKey` excludes it.
    id: "chatgpt",
    label: "ChatGPT account",
    keyringAccount: "chatgpt-oauth",
    keyPrefix: null,
    consoleUrl: "https://chatgpt.com/",
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
  ownedBy?: string;
};
// 4-field tuples unpacked to ModelInfo; saves ~200 lines of repeated key names
const M = (id: string, p: ProviderId, label: string, hint: string): ModelInfo => ({
  id,
  provider: p,
  label,
  hint,
});
export const MODELS = [
  M("gpt-5.6-sol", "openai", "GPT-5.6 Sol", "Frontier"),
  M("gpt-5.6-terra", "openai", "GPT-5.6 Terra", "Balanced"),
  M("gpt-5.6-luna", "openai", "GPT-5.6 Luna", "Fast"),
  M("gpt-5.5", "openai", "GPT-5.5", "Higher quality"),
  M("gpt-5.4-mini", "openai", "GPT-5.4 mini", "Fast, default"),
  M("gpt-5.4-nano", "openai", "GPT-5.4 nano", "Cheapest"),
  M("gpt-5.3-codex", "openai", "GPT-5.3 Codex", "Coding"),
  M("claude-fable-5", "anthropic", "Claude Fable 5", "Best"),
  M("claude-opus-4-8", "anthropic", "Claude Opus 4.8", "Most capable"),
  M("claude-sonnet-5", "anthropic", "Claude Sonnet 5", "Balanced"),
  M("claude-opus-4-7", "anthropic", "Claude Opus 4.7", "Previous Opus"),
  M("claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6", "Previous Sonnet"),
  M("claude-haiku-4-5", "anthropic", "Claude Haiku 4.5", "Fast"),
  M("gemini-3.1-pro-preview", "google", "Gemini 3.1 Pro", "Best"),
  M("gemini-3.5-flash", "google", "Gemini 3.5 Flash", "Balanced"),
  M("gemini-3-flash-preview", "google", "Gemini 3 Flash", "Fast"),
  M("gemini-3.1-flash-lite", "google", "Gemini 3.1 Flash Lite", "Fastest"),
  M("gemini-2.5-flash", "google", "Gemini 2.5 Flash", "Most Efficient"),
  M("gemma-4-31b-it", "google", "Gemma 4 31B", "Lean & Powerfull"),
  M("grok-4.5", "xai", "Grok 4.5", "Flagship"),
  M("grok-4.3", "xai", "Grok 4.3", "Long context"),
  M("grok-4.20-0309-reasoning", "xai", "Grok 4.20 Reasoning", "Reasoning"),
  M("grok-4.20-0309-non-reasoning", "xai", "Grok 4.20", "Fast"),
  M("grok-build-0.1", "xai", "Grok Build 0.1", "Coding"),
  M("grok-4.20-reasoning", "xai", "Grok 4.20 Reasoning (legacy id)", "Reasoning"),
  M("grok-4.20-non-reasoning", "xai", "Grok 4.20 (legacy id)", "Fast"),
  M("gpt-oss-120b", "cerebras", "GPT-OSS 120B", "Cerebras · ultra-fast"),
  M("openai/gpt-oss-120b", "groq", "GPT-OSS 120B", "Groq · reasoning"),
  M("openai/gpt-oss-20b", "groq", "GPT-OSS 20B", "Groq · ultra-fast"),
  M("llama-3.1-8b-instant", "groq", "Llama 3.1 8B", "Groq · fastest"),
  M("deepseek-v4-flash", "deepseek", "DeepSeek V4 Flash", "Fast"),
  M("deepseek-v4-pro", "deepseek", "DeepSeek V4 Pro", "Best"),
  M("lmstudio-local", "lmstudio", "LM Studio (local)", "Custom local model"),
  // ChatGPT-account models. These run against the ChatGPT backend's Responses
  // endpoint on the subscription, so no API credit is spent; the ids are the
  // ones that endpoint accepts, which is a SHORTER list than the API's.
  //
  // The accepted set is also PLAN-gated, and the endpoint's only signal is a
  // 400 `"The '<id>' model is not supported when using Codex with a ChatGPT
  // account."`. Measured 2026-08-26 on a ChatGPT Go account: terra and luna
  // answer, every `*-codex` id and sol are refused. So the plan-agnostic pair
  // goes FIRST - the head of this list is what a fresh sign-in lands on, and
  // defaulting to a Codex id 400s for anyone below Plus.
  M("gpt-5.6-terra", "chatgpt", "GPT-5.6 Terra", "Subscription · balanced"),
  M("gpt-5.6-luna", "chatgpt", "GPT-5.6 Luna", "Subscription · fast"),
  M("gpt-5.6-sol", "chatgpt", "GPT-5.6 Sol", "Subscription · frontier (Plus/Pro)"),
  M("gpt-5.3-codex", "chatgpt", "GPT-5.3 Codex", "Subscription · coding (Plus/Pro)"),
  M("gpt-5.3-codex-mini", "chatgpt", "GPT-5.3 Codex mini", "Subscription · fast (Plus/Pro)"),
] as const satisfies readonly ModelInfo[];

export type ModelId = (typeof MODELS)[number]["id"];
export type DynamicModelId = ModelId | (string & {});
const dynamicModels = new Map<string, ModelInfo>();
export function setDetectedModels(p: ProviderId, models: ModelInfo[]): void {
  for (const [id, i] of dynamicModels) if (i.provider === p) dynamicModels.delete(id);
  for (const m of models) dynamicModels.set(m.id, m);
}
export function setDetectedModelsForInstance(instanceId: string, models: ModelInfo[]): void {
  for (const [id, i] of dynamicModels) {
    if (i.provider !== "openai-compatible") continue;
    const parsed = parseOpenAICompatibleModelId(id);
    if (parsed?.instanceId === instanceId) dynamicModels.delete(id);
  }
  for (const m of models) dynamicModels.set(m.id, m);
}
export function getDetectedModels(p: ProviderId): ModelInfo[] {
  const o: ModelInfo[] = [];
  for (const m of dynamicModels.values()) if (m.provider === p) o.push(m);
  return o;
}
export function getModel(id: DynamicModelId): ModelInfo {
  const m = MODELS.find((x) => x.id === id) ?? dynamicModels.get(id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}
export function tryGetModel(id: DynamicModelId): ModelInfo | undefined {
  return MODELS.find((x) => x.id === id) ?? dynamicModels.get(id);
}
// Every provider that serves a model with this exact id (static table + dynamic registry). Lets the model builder fall back to a configured provider when an id is shared across providers (e.g. deepseek-v4-pro on native DeepSeek and SumoPod).
export function providersServingModel(id: DynamicModelId): ProviderId[] {
  const out: ProviderId[] = [];
  const seen = new Set<ProviderId>();
  for (const m of MODELS)
    if (m.id === id && !seen.has(m.provider)) {
      seen.add(m.provider);
      out.push(m.provider);
    }
  const dyn = dynamicModels.get(id);
  if (dyn && !seen.has(dyn.provider)) out.push(dyn.provider);
  return out;
}

// ModelInfo for a picked (id, provider). Returns the known catalogue entry only when it belongs to the chosen provider; otherwise a synthetic entry under that provider, so an id shared across providers routes to the one actually selected (not the id-lookup winner). Shared by runAgentStream + runSubagent.
export function resolveModelInfo(
  id: DynamicModelId,
  provider: ProviderId,
  known: ModelInfo | undefined = tryGetModel(id),
): ModelInfo {
  return known && known.provider === provider
    ? known
    : { id, provider, label: known?.label ?? id, hint: known?.hint ?? "" };
}

// OpenAI-style `/models` response, and the valid {id, owned_by} rows it carries. Shared by the SumoPod + OpenAI-compatible detectors.
export type OpenAIModelsResponse = { data?: Array<{ id?: string; owned_by?: string }> };
export function parseModelsList(
  json: OpenAIModelsResponse | null | undefined,
): Array<{ id: string; owned_by?: string }> {
  const out: Array<{ id: string; owned_by?: string }> = [];
  for (const m of json?.data ?? [])
    if (typeof m?.id === "string" && m.id.length > 0) out.push({ id: m.id, owned_by: m.owned_by });
  return out;
}
// Friendly label for a raw model id: strip any path prefix ("openai/gpt-4o" -> "gpt-4o"), spacers to spaces, case common maker names.
export function friendlyModelLabel(rawId: string): string {
  const tail = rawId.includes("/") ? rawId.slice(rawId.lastIndexOf("/") + 1) : rawId;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\bclaude\b/gi, "Claude")
    .replace(/\bgemini\b/gi, "Gemini")
    .replace(/\bdeepseek\b/gi, "DeepSeek")
    .replace(/\bllama\b/gi, "Llama")
    .replace(/\bqwen\b/gi, "Qwen")
    .replace(/\bmistral\b/gi, "Mistral")
    .replace(/\s+/g, " ")
    .trim();
}

export const DEFAULT_MODEL_ID: ModelId = "gpt-5.4-mini";

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.5": 2_000_000,
  // Claude documents 1M on the current line, but a 1M window is tier-gated, so
  // these stay at the previous 400K. Consistent with the fallback's stated
  // trade: over-compacting costs a little retained context, under-compacting
  // costs a failed turn. Haiku is lowered to its real 200K.
  "claude-fable-5": 400_000,
  "claude-opus-4-8": 400_000,
  "claude-sonnet-5": 400_000,
  "claude-opus-4-7": 400_000,
  "claude-sonnet-4-6": 400_000,
  "claude-haiku-4-5": 200_000,
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-3.5-flash": 1_048_576,
  "gemini-3-flash-preview": 1_048_576,
  "gemini-2.5-flash": 2_000_000,
  "gemma-4-31b-it": 512_000,
  "grok-4.5": 500_000,
  "grok-4.3": 1_000_000,
  "grok-4.20-0309-reasoning": 1_000_000,
  "grok-4.20-0309-non-reasoning": 1_000_000,
  "grok-build-0.1": 256_000,
  "grok-4.20-reasoning": 1_000_000,
  "grok-4.20-non-reasoning": 1_000_000,
  "gpt-oss-120b": 256_000,
  "openai/gpt-oss-120b": 131_072,
  "openai/gpt-oss-20b": 131_072,
  "llama-3.1-8b-instant": 131_072,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "lmstudio-local": 128_000,
  // SumoPod curated defaults whose real window is comfortably large, so the
  // lowered fallback below doesn't over-compact them.
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gemini/gemini-2.5-pro": 1_000_000,
};
// Fallback for runtime-detected ids. Conservative on purpose so compaction fires
// BEFORE the gateway's real limit rather than overflowing into OVER_CONTEXT. A
// large unknown model just compacts slightly early (elide-first, near-lossless);
// a small one stops erroring.
const FALLBACK_CONTEXT_LIMIT = 256_000;
export function getModelContextLimit(id: string | undefined): number {
  if (!id) return FALLBACK_CONTEXT_LIMIT;
  // OpenAI-compatible selections are namespaced as instance::raw-model. Context
  // capability belongs to the raw model, not the configured endpoint id.
  const raw = parseOpenAICompatibleModelId(id)?.rawModelId ?? id;
  const exact = MODEL_CONTEXT_LIMITS[id] ?? MODEL_CONTEXT_LIMITS[raw];
  if (exact) return exact;
  // Runtime catalogues frequently add snapshots/suffixes not present in the
  // static table. Infer only model families whose window is known and stable;
  // unknown families retain the conservative fallback.
  const normalized = raw.toLowerCase();
  if (/^gpt-5\.6(?:[-.:]|$)/.test(normalized)) return 1_050_000;
  if (/^gpt-5\.5(?:[-.:]|$)/.test(normalized)) return 2_000_000;
  if (/^gpt-5\.[34](?:[-.:]|$)/.test(normalized)) return 400_000;
  return FALLBACK_CONTEXT_LIMIT;
}

// "Keyless" here means "the user never pastes a key", not "no credential".
// LM Studio is a local server that wants none; ChatGPT signs in over OAuth and
// keeps its tokens in the keychain. Both must skip the paste-a-key gate, or
// `buildLanguageModel` refuses to build them.
export const KEYLESS_PROVIDERS: readonly ProviderId[] = ["lmstudio", "chatgpt"] as const;
export function providerNeedsKey(id: ProviderId): boolean {
  return !KEYLESS_PROVIDERS.includes(id);
}

/**
 * Placeholder stored in `ProviderKeys.chatgpt` while a ChatGPT account is
 * signed in. NOT a credential: the real tokens stay in the keychain under
 * `chatgpt-oauth` and rotate on refresh, so putting one here would be stale
 * within the hour. It exists so every "is this provider connected" gate that
 * already reads `apiKeys` keeps working for a provider you sign into.
 */
export const CHATGPT_CONNECTED_MARKER = "oauth:chatgpt";

/**
 * Can the user actually pick this provider right now?
 *
 * `providerNeedsKey` answers "does it take a pasted key", which is a different
 * question and was the wrong gate for `chatgpt`: it takes no key, so every gate
 * read it as ready and offered its models to someone who had never signed in.
 * Picking one then failed at request time, which is the definition of a control
 * that looks live and is not.
 */
export function providerIsConnected(
  id: ProviderId,
  keys: Partial<Record<ProviderId, string | null>>,
): boolean {
  if (id === "chatgpt") return !!keys.chatgpt;
  if (!providerNeedsKey(id)) return true;
  return !!keys[id];
}
// Inline completion runs on the SAME provider stack as chat (buildLanguageModel
// handles every id), so every BYOK provider is offered here: the big online
// ones, and local servers via LM Studio or any OpenAI-compatible endpoint.
// Previously restricted to cerebras/groq/lmstudio, which left a user holding
// only an OpenAI/Anthropic/local-OAC key with no ghost text at all.
export type AutocompleteProviderId = ProviderId;
export const AUTOCOMPLETE_PROVIDERS: readonly AutocompleteProviderId[] = PROVIDERS.map((p) => p.id);
// Defaults favour the fastest model per provider: completion latency is felt
// per keystroke, so a "best" model is the wrong trade here.
export const DEFAULT_AUTOCOMPLETE_MODEL: Record<AutocompleteProviderId, string> = {
  openai: "gpt-5.4-nano",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.1-flash-lite",
  xai: "grok-4.20-0309-non-reasoning",
  cerebras: "gpt-oss-120b",
  groq: "llama-3.1-8b-instant",
  deepseek: "deepseek-v4-flash",
  sumopod: "gpt-4.1-mini",
  agentrouter: "gpt-5.6-sol",
  "openai-compatible": "qwen3-coder:30b",
  lmstudio: "qwen3-coder-30b",
  // Codex models are reasoning-heavy and metered against the subscription, so
  // per-keystroke ghost text is the wrong place for them. Kept only because the
  // Record must be exhaustive; the picker offers the whole provider list.
  chatgpt: "gpt-5.3-codex-mini",
};
export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";

// ChatGPT-account transport. The Responses API lives at `<base>/responses`, so
// this base plus the AI SDK's OpenAI `.responses()` model resolves to exactly
// the endpoint the Codex client uses. It is NOT api.openai.com: that one bills
// API credits, this one draws on the ChatGPT subscription.
export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
// The endpoint gates on these. `originator` identifies the caller as the Codex
// client, which is what it accepts; `OpenAI-Beta` opts into the Responses shape.
// The per-request `chatgpt-account-id` is added in buildLanguageModel, since it
// comes from the signed-in token rather than from a constant.
export const CHATGPT_HEADERS: Record<string, string> = {
  originator: "codex_cli_rs",
  "OpenAI-Beta": "responses=experimental",
};
export const SUMOPOD_BASE_URL = "https://ai.sumopod.com/v1";

// AgentRouter. The `/v1` is load-bearing: the bare origin is an SPA with a
// catch-all route, so `POST /chat/completions` answers 200 + the landing page
// instead of 404 and the SSE parser silently yields an empty reply.
export const AGENTROUTER_BASE_URL = "https://agentrouter.org/v1";

// AgentRouter gates on User-Agent; anything else 401s `unauthorized_client_error`,
// which reads like a bad key. Measured 2026-07-31: PREFIX match, so trailing junk
// is fine (the SDK appends its own), but the approved client must come FIRST and
// `claude-cli/<v>` alone is rejected without "(external, cli". See
// scripts/ai/agentrouter-verify.ts. Requests must use `proxyOnlyFetch` - a WebView
// fetch drops `User-Agent` silently.
export const AGENTROUTER_USER_AGENT = "claude-cli/1.0.0 (external, cli)";
export const AGENTROUTER_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": AGENTROUTER_USER_AGENT,
};
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function normalizeOpenAICompatibleBaseURL(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  return t.replace(/^(https?:\/\/)localhost(?=[:/?#]|$)/i, "$1127.0.0.1");
}
// Local inference servers accept any bearer token or none, so demanding a key
// would block a valid local-only BYOK setup; remote endpoints still need one so
// cloud gateways keep the actionable "add a key" error. Strictly loopback: a LAN
// or `.local` host is someone else's machine. `URL.hostname` brackets IPv6,
// hence "[::1]".
export function isLoopbackBaseURL(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === "localhost" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

// `manualModels` holds model ids the user typed in by hand. Needed because a
// gateway is only usable here if its catalogue can be read, and plenty cannot
// be: some don't implement GET /models at all, and some refuse it while still
// serving /chat/completions. Without this such an endpoint saves fine and then
// offers zero models, which reads as "I cannot add it".
export type OpenAICompatibleInstance = {
  id: string;
  label: string;
  baseURL: string;
  manualModels?: string[];
};
export const OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID = "default";
export function openaiCompatibleKeyringAccount(id: string): string {
  return id === OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID
    ? "openai-compatible-api-key"
    : `openai-compatible-api-key:${id}`;
}
const OAI_COMPAT_MODEL_SEP = "::";
export function openaiCompatibleModelId(instanceId: string, rawModelId: string): string {
  return `${instanceId}${OAI_COMPAT_MODEL_SEP}${rawModelId}`;
}
export function parseOpenAICompatibleModelId(
  modelId: string,
): { instanceId: string; rawModelId: string } | null {
  const i = modelId.indexOf(OAI_COMPAT_MODEL_SEP);
  return i === -1
    ? null
    : {
        instanceId: modelId.slice(0, i),
        rawModelId: modelId.slice(i + OAI_COMPAT_MODEL_SEP.length),
      };
}
// Group detected openai-compatible models per configured instance, headed by the instance label; several OAC endpoints can be added so the picker groups by label, not the shared provider name.
export function groupOpenAICompatibleByInstance(
  models: readonly ModelInfo[],
  instances: readonly OpenAICompatibleInstance[],
): Array<{ instanceId: string; label: string; models: ModelInfo[] }> {
  return instances.map((inst) => ({
    instanceId: inst.id,
    label: inst.label,
    models: models.filter((m) => parseOpenAICompatibleModelId(m.id)?.instanceId === inst.id),
  }));
}
// Instance label for a namespaced openai-compatible model id; null if not OAC or the instance is gone. Credits the chat chip to the endpoint.
export function openAICompatibleInstanceLabel(
  modelId: string,
  instances: readonly OpenAICompatibleInstance[],
): string | null {
  const p = parseOpenAICompatibleModelId(modelId);
  if (!p) return null;
  return instances.find((i) => i.id === p.instanceId)?.label ?? null;
}

type OAIRuntime = { baseURL: string; apiKey: string };
const oaiCompatRuntime = new Map<string, OAIRuntime>();
export function setOpenAICompatibleRuntime(id: string, baseURL: string, apiKey: string): void {
  oaiCompatRuntime.set(id, { baseURL, apiKey });
}
export function clearOpenAICompatibleRuntime(id: string): void {
  oaiCompatRuntime.delete(id);
}
export function resolveOpenAICompatibleModel(
  modelId: string,
): (OAIRuntime & { instanceId: string; rawModelId: string }) | null {
  const p = parseOpenAICompatibleModelId(modelId);
  if (!p) return null;
  const rt = oaiCompatRuntime.get(p.instanceId);
  return rt ? { ...rt, ...p } : null;
}

// Presets are just base URLs; any OpenAI-compatible server works without one.
// The local entries cover the three common self-hosted runtimes so a local-only
// BYOK setup is a two-click affair instead of a port lookup.
export const OPENAI_COMPATIBLE_PRESETS = [
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
    id: "ollama",
    label: "Ollama (local)",
    baseURL: "http://127.0.0.1:11434/v1",
    description: "Local models, default port. Leave the key blank",
  },
  {
    id: "llamacpp",
    label: "llama.cpp (local)",
    baseURL: "http://127.0.0.1:8080/v1",
    description: "llama-server, default port. Leave the key blank",
  },
  {
    id: "vllm",
    label: "vLLM (local)",
    baseURL: "http://127.0.0.1:8000/v1",
    description: "vLLM OpenAI server, default port",
  },
  {
    id: "9router",
    label: "9Router (local)",
    baseURL: "http://127.0.0.1:20128/v1",
    description: "Self-hosted router, default port",
  },
] as const;

export const MAX_AGENT_STEPS = 15;
export const PLAN_MODE_PROMPT_BODY = `## PLAN MODE\nQueue all mutations for one review diff. Do NOT use bash_run or bash_background. Allowed work: read_file, grep, glob, list_directory, and queued mutations only. After queueing the intended edits, stop and return a brief summary. Wait for accept/reject before continuing.`;
export const ORCHESTRATION_PROMPT_BODY = `## SUB-AGENT ORCHESTRATION\nMANDATE: when the user asks you to study, explore, understand, review, audit, map, explain, scope a refactor or migration, analyze tests or docs, or trace a bug - anything touching more than one file - your FIRST tool call MUST be a single \`run_subagents\` call that fans the work out. Do NOT read or list files one by one for these tasks. At most one cheap orienting step is allowed first: a single root \`list_directory\`, or \`git diff\` / \`git status\` for a review.\nDo NOT narrate the plan in prose and stop. Saying you will use sub-agents is not using them: emit the \`run_subagents\` tool call as your actual first action this turn, without asking permission.\n\nExample - asked to "study this project", your first call is \`run_subagents\` with several parallel exploration tasks (one per area: app/UI, core modules, build/tooling) plus a dependency-research task. Then you synthesize their summaries. You never open files one at a time for this.\n\nPrinciple: work from the goal, not a recipe. Default to delegation and parallel execution; do not stop until the result is verified. Stay efficient: do small, single-file, or trivial work inline.\n\n\`run_subagent\` runs ONE isolated question; \`run_subagents\` fans out in parallel and may use \`depends_on\` for scatter -> gather. Each runs with a fresh history and its own tools, so every prompt must be self-contained.\n\nRoster - the available sub-agents, their categories, and specialties are listed in the \`run_subagents\` / \`run_subagent\` tool description; pick the one whose id fits each task by its category:\n- exploration (read-only): locate files, code, and patterns in this codebase, or research third-party libraries and dependencies from their installed source and docs.\n- advisor (read-only): hard debugging, architecture and trade-off decisions, security/perf concerns, self-review, pre-planning analysis of an ambiguous request, producing a decision-complete plan, or reviewing a plan / proposed changes before you commit.\n- utility (read-only): analyze images, screenshots, diagrams, and charts - anything whose answer is in a picture rather than in text.\n- specialist: autonomously IMPLEMENT changes end to end - edits/creates/moves/deletes files and runs commands, then verifies. Variants range from one focused change to executing a whole multi-step plan. Runs without approval cards (changes are checkpointed), so hand it a tight, self-contained brief.\n\nDelegate by area, module, or concern, picking the agent that fits each task. Do not survey the codebase inline.\n\nTo carry out implementation work without cluttering your own context, delegate to worker agents. MANDATE for a multi-file build, or any task with several independent files/modules: do NOT hand the whole build to one worker - one worker implements serially and is the SLOW path. Split it into MULTIPLE worker tasks in ONE \`run_subagents\` call, each owning a DISJOINT set of files (one per module or layer - e.g. markup, styles, content, logic, assets), so they implement in PARALLEL. Add a final \`depends_on\` integration or review task only when the pieces must be wired together at the end. Reserve a single worker for a genuinely single-file or tightly-coupled change.\n\nSynthesize returned summaries yourself. Add a final gather task only when the synthesis must read more files. This rule also applies in plan mode before queueing mutations.\n\nWork inline only for small single-file or single-symbol questions or edits, command execution, or trivial requests.`;
export const ORCHESTRATION_PROMPT_BODY_LITE = `## SUB-AGENT ORCHESTRATION (enabled)\nMANDATE: for ANY task touching more than one file (study, explore, understand, review, audit, explain, refactor/migration scope, test or doc analysis, bug tracing), your FIRST tool call MUST be ONE \`run_subagents\` call - do NOT read files one by one. e.g. "study this project" -> \`run_subagents\` with a parallel explore task per area, then synthesize. Do NOT just say you will use sub-agents: emit the \`run_subagents\` call as your actual first action, without asking permission.\nAgents are listed in the \`run_subagents\` tool: read-only exploration agents (search this codebase or research dependencies), advisor agents (debugging/architecture, pre-planning, planning, plan/change review), a visual analyst (images/screenshots/diagrams), and autonomous workers that edit files + run commands to IMPLEMENT changes (from one focused change up to a full multi-step plan; checkpointed). For a multi-file build, split implementation across PARALLEL workers in one \`run_subagents\` call - each owns a DISJOINT file set (one per module/layer); handing a whole build to one serial worker is the slow path. A single worker only for a single-file or tightly-coupled change. Synthesize results yourself. Do small/single-file work inline.`;

/**
 * One tool-tagged piece of the core prompt.
 *
 * `needs` lists the tools the text talks about; the piece is emitted only when
 * at least one of them is actually in this turn's tool set. No `needs` means
 * tool-agnostic prose that always goes out. This is the whole fix for a prompt
 * that told a model to use `run_subagents` and `read_browser` while the tool
 * picker had switched both off - instructions for tools that are not there are
 * billed every turn and are a guaranteed failed call.
 */
export type PromptSection = { needs?: readonly string[]; text: string };

/** A heading and its sections. The heading disappears with its last surviving
 *  section, so filtering everything out cannot leave a bare `# Browser` behind. */
export type PromptBlock = {
  heading?: string;
  /** Join sections with a space rather than a newline (prose, not bullets). */
  inline?: boolean;
  sections: readonly PromptSection[];
};

/** Render the blocks whose tools survive `has`. Byte-stable for a fixed tool
 *  set, which is what keeps the provider prompt cache hitting across turns. */
export function composePrompt(
  blocks: readonly PromptBlock[],
  has: (tool: string) => boolean,
): string {
  const out: string[] = [];
  for (const b of blocks) {
    const kept = b.sections.filter((s) => !s.needs || s.needs.some(has));
    if (kept.length === 0) continue;
    const body = kept.map((s) => s.text).join(b.inline ? " " : "\n");
    out.push(b.heading ? `${b.heading}\n${body}` : body);
  }
  return out.join("\n\n");
}

// Tool-name groups the sections are tagged with. These are the same names the
// picker stores in `disabledTools`; `scripts/ai/prompt-tools-verify.ts` checks them
// against the real built-in tool set so a rename cannot silently orphan a tag.
const EDIT_TOOLS = ["edit", "multi_edit"] as const;
const FS_MOVE_TOOLS = ["move_file", "copy_file", "delete_file"] as const;
const SEARCH_TOOLS = ["grep", "glob", "list_directory"] as const;
const PATH_TOOLS = [
  ...EDIT_TOOLS,
  ...FS_MOVE_TOOLS,
  ...SEARCH_TOOLS,
  "read_file",
  "write_file",
  "replace_in_files",
  "create_directory",
] as const;
const SHELL_TOOLS = ["bash_run", "bash_background", "bash_logs", "bash_kill", "bash_list"] as const;
// Terminal, pane and browser control are MCP tools served by TEDI's own
// in-process server (`lib/tediMcpServer.ts`), so the tags carry the key the
// model actually sees: `mcp__<server>__<tool>`. They are still ordinary entries
// in the assembled tool set, so `has()` and the picker's off-list govern them
// exactly as they did the native tools these replaced.
const TERMINAL_READ = "mcp__tedi__read";
const TERMINAL_TOOLS = [
  "mcp__tedi__sh",
  "mcp__tedi__pane",
  "mcp__tedi__wait_for_terminal",
  "mcp__tedi__focus_pane",
] as const;
const BROWSER_TOOLS = ["mcp__tedi__browser"] as const;
const SUBAGENT_TOOLS = ["run_subagent", "run_subagents"] as const;

const CORE_BLOCKS: readonly PromptBlock[] = [
  {
    sections: [
      {
        text: `You are TEDI, an AI engineer in a developer terminal. Do the work; do not narrate.`,
      },
    ],
  },
  {
    heading: "# Environment",
    inline: true,
    sections: [
      {
        text: `\`Host:\` at top gives OS + shell; match syntax. Every user message is prefixed with an \`<env>\` block: \`workspace_root\`, \`active_terminal_cwd\`, optional \`active_file\`, a \`terminals:\` list (ordinal matches the user's tab badge; name a terminal as \`#<ordinal>\` in your replies, the user can click it to jump there), and a \`browsers:\` list (open in-app browser panes with URL; \`*\` = focused). The LAST \`<env>\` is ground truth; earlier ones are the state at that past turn, so never act on a stale path from one.`,
      },
      { needs: [TERMINAL_READ], text: `Use \`read\` for scrollback, open editors and DOM text.` },
      { needs: BROWSER_TOOLS, text: `Use \`browser\` to open or reuse a browser pane.` },
    ],
  },
  {
    heading: "# Principles",
    sections: [
      { text: `- Execute, do not echo. The approval card is the confirmation.` },
      { text: `- Prefer one turn: read → understand → change → verify.` },
      {
        needs: SEARCH_TOOLS,
        text: `- Check with grep/glob/list_directory before asking. Ask only when ambiguity is costly.`,
      },
      { text: `- Keep scope tight. No unrequested refactors or side quests.` },
      { text: `- Pass objects and numbers natively.` },
      // The em-dash / emoji ban lives ONCE, in `# Delegation and output`. It was
      // stated here too, untagged, so both copies shipped on every full-variant
      // request. The surviving copy is the later one: it carries the "in code,
      // keep exact punctuation" carve-out this one lacked, and it lands last.
    ],
  },
  {
    heading: "# Files",
    sections: [
      {
        needs: EDIT_TOOLS,
        text: `- \`edit\` / \`multi_edit\` need a prior \`read_file\` this session; \`old_string\` must be unique unless \`replace_all=true\`.`,
      },
      {
        needs: ["write_file"],
        text: `- \`write_file\` is for new or tiny full rewrites. List the parent first in fresh subtrees.`,
      },
      {
        needs: FS_MOVE_TOOLS,
        text: `- Prefer \`move_file\` / \`copy_file\` / \`delete_file\` over shell mv/cp/rm.`,
      },
      {
        needs: ["replace_in_files"],
        text: `- Use \`replace_in_files\` only for cross-file regex refactors; it is not restorable.`,
      },
      {
        needs: ["read_file"],
        text: `- Do not re-read a file unless you wrote it. \`read_file\` supports paging.`,
      },
      {
        needs: PATH_TOOLS,
        text: `- Bare filenames resolve from \`active_terminal_cwd\`. "edit this file" with no path means \`active_file\`.`,
      },
      {
        needs: [...EDIT_TOOLS, "write_file"],
        text: `- Add code comments only when the why is non-obvious.`,
      },
    ],
  },
  {
    heading: "# Fetch and shell",
    sections: [
      {
        needs: ["fetch"],
        text: `- \`Fetch\` is for APIs, JSON, and text: GET auto, POST approval, no JS execution. For bulk retrieval, prefer one Fetch call over many page navigations.`,
      },
      {
        needs: SHELL_TOOLS,
        text: `- \`bash_run\` is for short stdout commands, never interactive. Use Bash Background plus \`bash_list\` / logs / kill for servers and watchers; check \`bash_list\` first.`,
      },
    ],
  },
  {
    heading: "# Terminal and panes",
    sections: [
      {
        needs: TERMINAL_TOOLS,
        text: `- \`sh\` runs a command in the USER'S visible terminal and waits for the prompt; it refuses a busy pane, so pass another \`leafId\` or open one. \`bash_run\` stays the tool for your own work - \`sh\` is for the user's shell, cwd, env and SSH session. \`wait_for_terminal\` instead of polling: no \`text\` waits for the prompt, \`text\` waits for a string, which is the only signal for something that never returns.`,
      },
      {
        needs: ["mcp__tedi__pane"],
        text: `- \`pane\` opens, closes, groups, rotates and consolidates panes. It is how you "join tabs" and how you change a split between row (beside) and col (stacked); TEDI has no tab-group menu and no drag shortcut, so never tell the user to use one.`,
      },
      {
        needs: ["mcp__tedi__state"],
        text: `- \`state\` names the \`leafId\` every pane tool takes, for EVERY tab rather than just the active one. \`<env>\` already lists the terminals and browsers of the current tab, so call \`state\` when you need a pane it does not mention.`,
      },
      { needs: ["schedule_command"], text: `- \`schedule_command\` defers work.` },
    ],
  },
  {
    heading: "# Browser",
    sections: [
      {
        needs: BROWSER_TOOLS,
        text: `- \`browser\` drives real pages, not iframes, so use it instead of curl/fetch for JS-heavy sites. Fact lookup is ONE call: \`browser({ action: "open", url, read: true })\` opens (reusing your research pane) and returns the text together. Search by opening a search URL; never open URLs through terminal commands, and do not curl the same page afterwards. Re-read only if it was still loading.`,
      },
      {
        needs: BROWSER_TOOLS,
        text: `- To act on a page: \`read\` with \`fields: true\` for the \`[N]\` list, then \`click\` / \`type\` by index. Indices RESET after any navigation, so read again. For complex UI: \`scroll\` -> read -> \`hover\` -> \`key\`. \`click_at\` is only for visual-only targets and \`screenshot\` is the last resort. Passwords only when the user gave them for that login.`,
      },
      {
        needs: BROWSER_TOOLS,
        text: `- Debugging your own app: after opening or reloading a dev-server page, use \`action: "console"\` for the real JS errors rather than inferring them. It captures from page load and drains, so call it right after the action you want to check. A blank or half-rendered page is a console question, not a screenshot question.`,
      },
    ],
  },
  {
    heading: "# Delegation and output",
    sections: [
      {
        needs: SUBAGENT_TOOLS,
        text: `- Use \`run_subagent\` / \`run_subagents\` for broad read-only analysis; prefer parallel \`run_subagents\` for multi-scope work.`,
      },
      { needs: ["todo_write"], text: `- Use \`todo_write\` before 5+ chained tool calls.` },
      { text: `- Be terse. No filler or apologies.` },
      {
        text: `- Before a mutation tool, give one short why-line. After work, give 1-2 sentences covering what changed and what is next.`,
      },
      {
        text: `- If the same tool with the same args fails twice, stop and ask. Refused reads on sensitive files (.env, .ssh, credentials) are final.`,
      },
      {
        text: `- Never use em dash punctuation (—) or emoji in any output. Use hyphen (-), colon (:), pipe (|), comma, or semicolon. In code, keep exact punctuation only when required.`,
      },
    ],
  },
];

const CORE_BLOCKS_LITE: readonly PromptBlock[] = [
  {
    sections: [
      {
        text: `You are TEDI, an AI agent in a developer terminal. \`Host:\` gives OS + shell; match syntax. Every user message is prefixed with an \`<env>\` block: \`workspace_root\`, \`active_terminal_cwd\`, optional \`active_file\`, terminal ordinals, and open browser panes. The LAST one is ground truth; earlier ones are that past turn's state. Name a terminal as \`#<ordinal>\`; the user can click it to jump there.`,
      },
      { text: `- Execute, do not echo; the approval card is the confirmation.` },
      { text: `- Prefer read → change → verify in one turn.` },
      { needs: SEARCH_TOOLS, text: `- Check with grep/glob/list_directory before asking.` },
      {
        needs: PATH_TOOLS,
        text: `- Bare filenames resolve from \`active_terminal_cwd\`. "edit this file" with no path means \`active_file\`.`,
      },
      {
        needs: EDIT_TOOLS,
        text: `- \`edit\` / \`multi_edit\` need a prior \`read_file\`; \`old_string\` must be unique unless \`replace_all=true\`.`,
      },
      { needs: ["write_file"], text: `- \`write_file\` is for new or tiny full rewrites.` },
      { needs: ["read_file"], text: `- Do not re-read unless you wrote.` },
      { needs: ["fetch"], text: `- Use \`Fetch\` for APIs, JSON, and text.` },
      {
        needs: SHELL_TOOLS,
        text: `- Use \`bash_run\` only for short non-interactive stdout. Use Bash Background plus \`bash_list\` for long-lived processes.`,
      },
      {
        needs: BROWSER_TOOLS,
        text: `- \`browser\` for JS-heavy pages: \`open\` with \`read:true\` is one lookup call. \`read\` with \`fields:true\` then \`click\`/\`type\` by [N]; indices reset after navigation. \`console\` for real JS errors.`,
      },
      {
        needs: TERMINAL_TOOLS,
        text: `- \`sh\` runs in the user's visible terminal (\`bash_run\` is your own). \`pane\` opens and arranges panes; \`wait_for_terminal\` instead of polling.`,
      },
      {
        needs: SUBAGENT_TOOLS,
        text: `- Use \`run_subagent\` / \`run_subagents\` for broad read-only work.`,
      },
      {
        text: `- Pass objects and numbers natively. If the same tool fails twice, stop. Refused reads on sensitive files are final.`,
      },
      {
        text: `- Never use em dash punctuation (—) or emoji in any output. Use hyphen (-), colon (:), pipe (|), comma, or semicolon.`,
      },
      { text: `- Be terse.` },
    ],
  },
];

/**
 * Every tool name the core prompt is tagged with.
 *
 * Exported for `scripts/ai/prompt-tools-verify.ts`: a tool renamed without its tag
 * being renamed too would leave its instructions in the prompt forever, which is
 * exactly the failure this whole structure exists to prevent.
 */
export const PROMPT_TAGGED_TOOLS: readonly string[] = [
  ...new Set(
    [...CORE_BLOCKS, ...CORE_BLOCKS_LITE].flatMap((b) =>
      b.sections.flatMap((sec) => sec.needs ?? []),
    ),
  ),
].sort();

/** The prompt with every tool on. This is what Settings shows as the editable
 *  default, and what a session with nothing switched off actually sends. */
export const SYSTEM_PROMPT = composePrompt(CORE_BLOCKS, () => true);
export const SYSTEM_PROMPT_LITE = composePrompt(CORE_BLOCKS_LITE, () => true);

/** The core prompt for the tools this turn is really sending. */
export function buildCorePrompt(variant: "full" | "lite", has: (tool: string) => boolean): string {
  return composePrompt(variant === "lite" ? CORE_BLOCKS_LITE : CORE_BLOCKS, has);
}

/** Sent instead of SYSTEM_PROMPT when chat mode is on. No tools go out with it,
 *  so every line above about files, shells, browsers, and delegation would be
 *  dead weight the user pays for on each message. Kept to one paragraph on
 *  purpose: this prompt exists so a "hi" costs like a "hi". */
export const CHAT_MODE_PROMPT = `You are TEDI, a helpful assistant. You have no tools this turn, so answer from what you know and ask the user to paste anything you need to see. Be direct and concise. Never use em dash punctuation (—) or emoji in any output; use hyphen (-), colon (:), pipe (|), comma, or semicolon.`;

const LITE_SYSTEM_PROMPT_MODEL_IDS = new Set<string>([
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemma-4-31b-it",
  "claude-haiku-4-5",
  "openai/gpt-oss-20b",
  "gpt-oss-120b",
  "llama-3.1-8b-instant",
  "deepseek-v4-flash",
  "grok-4.20-non-reasoning",
  "grok-4.20-0309-non-reasoning",
]);
const LITE_MODEL_PATTERN =
  /\b(mini|nano|flash|haiku|lite|small|tiny|gemma|gpt-oss|qwen2?\.5-coder|coder-(?:1\.5|3|7)b|[1-9]b)\b/i;
export function pickSystemPromptVariant(modelId: string | undefined): "full" | "lite" {
  if (!modelId) return "full";
  if (LITE_SYSTEM_PROMPT_MODEL_IDS.has(modelId)) return "lite";
  if (LITE_MODEL_PATTERN.test(modelId)) return "lite";
  return "full";
}
