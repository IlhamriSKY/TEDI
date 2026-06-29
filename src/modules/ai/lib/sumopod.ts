import { useEffect, useState } from "react";
import { setDetectedModels, SUMOPOD_BASE_URL, type ModelInfo } from "../config";

type ModelsResponse = {
  data?: Array<{ id?: string; owned_by?: string }>;
};

/** Curated defaults shown right after key entry, before `/v1/models` resolves. */
const SUMOPOD_DEFAULT_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
}> = [
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", hint: "Fast, cheap" },
  { id: "gpt-4.1", label: "GPT-4.1", hint: "Balanced" },
  { id: "gpt-5.4", label: "GPT-5.4", hint: "Default" },
  { id: "gpt-5.2", label: "GPT-5.2", hint: "Reasoning" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", hint: "Best" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced" },
  {
    id: "gemini/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Long context",
  },
] as const;

function defaultModelInfos(): ModelInfo[] {
  return SUMOPOD_DEFAULT_MODELS.map((m) => ({
    id: m.id,
    provider: "sumopod" as const,
    label: m.label,
    hint: m.hint,
  }));
}

/** Merge curated defaults with API-detected models by id. Defaults first;
 *  API duplicates are dropped, new entries appended. */
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

// Publish defaults into the registry on load so `tryGetModel()` resolves
// them even before a key is entered. Cleared on key removal.
setDetectedModels("sumopod", INITIAL.models);

let state: FetchState = INITIAL;
const listeners = new Set<(s: FetchState) => void>();

function emit() {
  for (const l of listeners) l(state);
}

export function subscribeSumopodModels(cb: (s: FetchState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => {
    listeners.delete(cb);
  };
}

/** Friendly label for a SumoPod model id (e.g. "gpt-4o-mini" -> "GPT-4o mini"). */
function labelFor(id: string): string {
  // Strip provider/path prefixes ("openai/gpt-4o" -> "gpt-4o").
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

function hintFor(_raw: { owned_by?: string }): string {
  // SumoPod returns `owned_by: "openai"` regardless of the real maker, so the
  // upstream value is misleading. Always show "via SumoPod".
  return "via SumoPod";
}

/** Fetch the SumoPod model catalogue and publish into the dynamic registry.
 *  Safe to call repeatedly. Pass `signal` to cancel. */
export async function refreshSumopodModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  state = { ...state, status: "loading", error: null };
  emit();
  try {
    const res = await fetch(`${SUMOPOD_BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `SumoPod /models returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as ModelsResponse;
    const raws: Array<{ id: string; owned_by?: string }> = [];
    for (const m of json?.data ?? []) {
      if (typeof m?.id === "string" && m.id.length > 0) {
        raws.push({ id: m.id, owned_by: m.owned_by });
      }
    }

    // Omit `ownedBy` so the chat chip credits SumoPod (the gateway) rather
    // than the upstream maker. Matches the "via SumoPod" hint in the dropdown.
    const detected: ModelInfo[] = raws
      .map((raw) => ({
        id: raw.id,
        provider: "sumopod" as const,
        label: labelFor(raw.id),
        hint: hintFor(raw),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // Defaults first, then extra detected models.
    const models = mergeWithDefaults(detected);
    setDetectedModels("sumopod", models);
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
      // Cancelled; keep current state.
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

/** Reset SumoPod state on key removal. Curated defaults stay in the registry
 *  (as disabled items) so users see what's available before pasting a key. */
export function clearSumopodModels(): void {
  const defaults = defaultModelInfos();
  setDetectedModels("sumopod", defaults);
  state = {
    status: "idle",
    error: null,
    models: defaults,
    fetchedAt: null,
  };
  emit();
}

/** React hook for the SumoPod fetch state. */
export function useSumopodModels(): FetchState {
  const [snapshot, setSnapshot] = useState<FetchState>(state);
  useEffect(() => subscribeSumopodModels(setSnapshot), []);
  return snapshot;
}
