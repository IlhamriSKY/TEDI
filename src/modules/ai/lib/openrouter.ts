import { useEffect, useState } from "react";
import { OPENROUTER_BASE_URL, setDetectedModels, type ModelInfo } from "../config";

// OpenRouter is a gateway that fronts ~300 models from many makers, each
// model id namespaced as "<maker>/<model>" (e.g. "openai/gpt-5-mini",
// "anthropic/claude-opus-4"). The /v1/models response is OpenAI-compatible
// but enriches each entry with `name`, `context_length`, and `pricing` —
// we keep the canonical id (with namespace) for the model picker so a
// user-saved selection survives across catalogue refreshes, and surface
// the maker as the hint chip so the chat tag reads "via OpenAI" / "via
// Anthropic" instead of a blank "OpenRouter" badge.

type ModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    /** Some entries expose maker via `top_provider.name`; falling back to the
     *  namespace prefix on the id is more reliable. */
    top_provider?: { name?: string };
  }>;
};

/** Curated defaults shown before the catalogue fetch resolves. Picked to
 *  cover the common asks ("just give me a good Claude / GPT / Gemini")
 *  without paginating through hundreds of OpenRouter rows. Order = display
 *  order in the dropdown. Ids are the canonical OpenRouter slugs. */
const OPENROUTER_DEFAULT_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
}> = [
  {
    id: "anthropic/claude-opus-4",
    label: "Claude Opus 4",
    hint: "via Anthropic · best",
  },
  {
    id: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    hint: "via Anthropic · balanced",
  },
  {
    id: "openai/gpt-5",
    label: "GPT-5",
    hint: "via OpenAI · best",
  },
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 mini",
    hint: "via OpenAI · fast",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "via Google · long context",
  },
  {
    id: "deepseek/deepseek-chat-v3",
    label: "DeepSeek Chat V3",
    hint: "via DeepSeek · cheap",
  },
  {
    id: "x-ai/grok-4",
    label: "Grok 4",
    hint: "via xAI · reasoning",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    hint: "via Meta · open weights",
  },
] as const;

function defaultModelInfos(): ModelInfo[] {
  return OPENROUTER_DEFAULT_MODELS.map((m) => ({
    id: m.id,
    provider: "openrouter" as const,
    label: m.label,
    hint: m.hint,
    // Derive maker from the "<maker>/<model>" id namespace so the chat chip
    // can credit Anthropic / OpenAI / Google instead of the OpenRouter
    // gateway even before the live catalogue resolves.
    ownedBy: makerOf(m.id, {}),
  }));
}

/** Merge curated defaults with API-detected models by id. Defaults first;
 *  API duplicates are dropped, new entries appended. Mirrors sumopod.ts. */
function mergeWithDefaults(detected: ModelInfo[]): ModelInfo[] {
  const out: ModelInfo[] = defaultModelInfos();
  const seen = new Set(out.map((m) => m.id));
  for (const m of detected) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

type FetchState = {
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  models: ModelInfo[];
  /** epoch ms */
  fetchedAt: number | null;
};

const INITIAL: FetchState = {
  status: "idle",
  error: null,
  models: defaultModelInfos(),
  fetchedAt: null,
};

// Seed the dynamic-model registry on module load. Means `tryGetModel(id)`
// resolves the curated defaults even before the user pastes a key, so the
// last-picked model survives a restart against a blank keychain.
setDetectedModels("openrouter", INITIAL.models);

let state: FetchState = INITIAL;
const listeners = new Set<(s: FetchState) => void>();

function emit() {
  for (const l of listeners) l(state);
}

export function getOpenrouterModelsState(): FetchState {
  return state;
}

export function subscribeOpenrouterModels(cb: (s: FetchState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => {
    listeners.delete(cb);
  };
}

/** Pretty model name. Keeps the "maker/" namespace as a prefix chip so
 *  three claude variants don't all look like just "Claude". */
function labelFor(id: string, raw: { name?: string }): string {
  // Prefer OpenRouter's `name` if it ships one — they already strip the
  // namespace and use cased words (e.g. "OpenAI: GPT-5"). Fall back to a
  // best-effort derivation from the id.
  if (raw.name && raw.name.trim().length > 0) {
    // OpenRouter writes "OpenAI: GPT-5"; strip the maker prefix so the
    // hint chip ("via OpenAI") doesn't duplicate the info.
    return raw.name.replace(/^[^:]+:\s*/, "").trim();
  }
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
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

/** Lowercase maker key, e.g. "anthropic", "openai", "x-ai". Used to drive
 *  the chat chip's owner badge (capitalised at render). */
function makerOf(id: string, raw: { top_provider?: { name?: string } }): string {
  const fromTop = raw.top_provider?.name?.trim();
  if (fromTop) return fromTop;
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  return "openrouter";
}

function hintFor(id: string, raw: { top_provider?: { name?: string } }): string {
  // x-ai → xAI, openai → OpenAI, deepseek → DeepSeek, etc.
  const maker = makerOf(id, raw);
  const cased = maker
    .split("-")
    .map((s) => (s.length <= 2 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("");
  return `via ${cased}`;
}

/** Fetch the OpenRouter model catalogue. Safe to call repeatedly; cancels
 *  in-flight requests via `signal`. Errors leave the curated defaults in
 *  place so the dropdown is never empty during a transient failure. */
export async function refreshOpenrouterModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  state = { ...state, status: "loading", error: null };
  emit();
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        // OpenRouter encourages identifying the calling app for their
        // dashboard / rankings. Not required for /models or completions.
        "HTTP-Referer": "https://github.com/IlhamriSKY/TEDI",
        "X-Title": "TEDI",
      },
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OpenRouter /models returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as ModelsResponse;
    const raws: Array<{ id: string; name?: string; top_provider?: { name?: string } }> = [];
    for (const m of json?.data ?? []) {
      if (typeof m?.id === "string" && m.id.length > 0) {
        raws.push({ id: m.id, name: m.name, top_provider: m.top_provider });
      }
    }
    const detected: ModelInfo[] = raws
      .map((raw) => ({
        id: raw.id,
        provider: "openrouter" as const,
        label: labelFor(raw.id, raw),
        hint: hintFor(raw.id, raw),
        // Surface the maker so the chat chip credits the brand
        // ("Anthropic") instead of the gateway ("OpenRouter").
        ownedBy: makerOf(raw.id, raw),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const models = mergeWithDefaults(detected);
    setDetectedModels("openrouter", models);
    state = {
      status: "ok",
      error: null,
      models,
      fetchedAt: Date.now(),
    };
    emit();
    return models;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      return state.models;
    }
    state = {
      ...state,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
    emit();
    return [];
  }
}

/** Reset on key removal. Curated defaults stay in the registry so the
 *  dropdown shows greyed-out options to hint at what's available. */
export function clearOpenrouterModels(): void {
  const defaults = defaultModelInfos();
  setDetectedModels("openrouter", defaults);
  state = {
    status: "idle",
    error: null,
    models: defaults,
    fetchedAt: null,
  };
  emit();
}

/** React hook mirroring `useSumopodModels`. */
export function useOpenrouterModels(): FetchState {
  const [snapshot, setSnapshot] = useState<FetchState>(state);
  useEffect(() => subscribeOpenrouterModels(setSnapshot), []);
  return snapshot;
}
