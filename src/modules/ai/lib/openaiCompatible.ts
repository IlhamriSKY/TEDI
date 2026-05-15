import { useEffect, useState } from "react";
import { setDetectedModels, type ModelInfo } from "../config";

type ModelsResponse = {
  data?: Array<{ id?: string; owned_by?: string }>;
};

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
  models: [],
  fetchedAt: null,
};

let state: FetchState = INITIAL;
const listeners = new Set<(s: FetchState) => void>();

function emit() {
  for (const l of listeners) l(state);
}

export function getOpenAICompatibleModelsState(): FetchState {
  return state;
}

export function subscribeOpenAICompatibleModels(
  cb: (s: FetchState) => void,
): () => void {
  listeners.add(cb);
  cb(state);
  return () => {
    listeners.delete(cb);
  };
}

function labelFor(id: string): string {
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

function hintFor(raw: { owned_by?: string }): string {
  return raw.owned_by ? `via ${raw.owned_by}` : "OpenAI Compatible";
}

export async function refreshOpenAICompatibleModels(
  apiKey: string,
  baseURL: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const trimmedURL = baseURL.replace(/\/$/, "");
  if (!trimmedURL) {
    state = { ...state, status: "error", error: "Base URL is empty" };
    emit();
    return [];
  }
  state = { ...state, status: "loading", error: null };
  emit();
  try {
    const res = await fetch(`${trimmedURL}/models`, {
      method: "GET",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        Accept: "application/json",
      },
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `/models returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as ModelsResponse;
    const raws: Array<{ id: string; owned_by?: string }> = [];
    for (const m of json?.data ?? []) {
      if (typeof m?.id === "string" && m.id.length > 0) {
        raws.push({ id: m.id, owned_by: m.owned_by });
      }
    }
    const detected: ModelInfo[] = raws
      .map((raw) => ({
        id: raw.id,
        provider: "openai-compatible" as const,
        label: labelFor(raw.id),
        hint: hintFor(raw),
        ownedBy: raw.owned_by,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    setDetectedModels("openai-compatible", detected);
    state = {
      status: "ok",
      error: null,
      models: detected,
      fetchedAt: Date.now(),
    };
    emit();
    return detected;
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

export function clearOpenAICompatibleModels(): void {
  setDetectedModels("openai-compatible", []);
  state = {
    status: "idle",
    error: null,
    models: [],
    fetchedAt: null,
  };
  emit();
}

export function useOpenAICompatibleModels(): FetchState {
  const [snapshot, setSnapshot] = useState<FetchState>(state);
  useEffect(() => subscribeOpenAICompatibleModels(setSnapshot), []);
  return snapshot;
}
