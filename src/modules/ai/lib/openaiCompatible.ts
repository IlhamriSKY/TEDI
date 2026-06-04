import { useEffect, useState } from "react";
import {
  OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
  clearOpenAICompatibleRuntime,
  normalizeOpenAICompatibleBaseURL,
  openaiCompatibleModelId,
  setDetectedModelsForInstance,
  setOpenAICompatibleRuntime,
  type ModelInfo,
} from "../config";

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

// Per-instance fetch state. Keyed by instance id so multiple endpoints each
// track their own detection status independently.
const states = new Map<string, FetchState>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function stateFor(instanceId: string): FetchState {
  return states.get(instanceId) ?? INITIAL;
}

export function getOpenAICompatibleModelsState(
  instanceId: string = OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
): FetchState {
  return stateFor(instanceId);
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

// The dropdown subtitle. Prefer the provider's own configured label (e.g.
// "Xiomi", "9Router") so the user sees WHICH endpoint a model came from;
// `owned_by` from `/models` is a gateway-internal tag (often "cx") that means
// nothing to them. Fall back to `owned_by`, then a generic label.
function hintFor(raw: { owned_by?: string }, label?: string): string {
  const trimmed = label?.trim();
  if (trimmed) return `via ${trimmed}`;
  return raw.owned_by ? `via ${raw.owned_by}` : "OpenAI Compatible";
}

/**
 * Fetch one instance's `/models` catalogue and publish it into the dynamic
 * registry under namespaced ids (`<instanceId>::<rawId>`) so models from
 * different endpoints never collide. Also records the instance's base URL + key
 * in the runtime resolver so the agent can build the right client for a picked
 * model. Safe to call repeatedly. Pass `signal` to cancel.
 */
export async function refreshOpenAICompatibleInstance(
  instanceId: string,
  apiKey: string,
  baseURL: string,
  label?: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  // Normalize here (not at the call sites) so every detection path - bootstrap,
  // ModelsSection, the Detect button - and the runtime base URL registered just
  // below all go through the same localhost->127.0.0.1 rewrite. Otherwise the
  // WebView's native fetch below tries IPv6 ::1 first and fails with a bare
  // "Failed to fetch" against IPv4-only local routers.
  const trimmedURL = normalizeOpenAICompatibleBaseURL(baseURL);
  if (!trimmedURL) {
    states.set(instanceId, { ...stateFor(instanceId), status: "error", error: "Base URL is empty" });
    emit();
    return [];
  }
  // Register runtime resolution up-front so a model picked before detection
  // finishes still resolves to the right endpoint.
  setOpenAICompatibleRuntime(instanceId, trimmedURL, apiKey);
  states.set(instanceId, { ...stateFor(instanceId), status: "loading", error: null });
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
      throw new Error(`/models returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
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
        // Namespace the id so the agent can route the model to this instance,
        // and so two endpoints exposing the same model id stay distinct.
        id: openaiCompatibleModelId(instanceId, raw.id),
        provider: "openai-compatible" as const,
        label: labelFor(raw.id),
        hint: hintFor(raw, label),
        ownedBy: raw.owned_by,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    setDetectedModelsForInstance(instanceId, detected);
    states.set(instanceId, {
      status: "ok",
      error: null,
      models: detected,
      fetchedAt: Date.now(),
    });
    emit();
    return detected;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      return stateFor(instanceId).models;
    }
    states.set(instanceId, {
      ...stateFor(instanceId),
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    emit();
    return [];
  }
}

/** Reset one instance's detection state and registry entries (on key removal
 *  or instance delete). */
export function clearOpenAICompatibleInstance(instanceId: string): void {
  setDetectedModelsForInstance(instanceId, []);
  clearOpenAICompatibleRuntime(instanceId);
  states.set(instanceId, { status: "idle", error: null, models: [], fetchedAt: null });
  emit();
}

// --- Backward-compatible single-endpoint API --------------------------------
// Older call sites (App.tsx, ModelsSection.tsx) used these without an instance
// id. They now target the default instance.

export async function refreshOpenAICompatibleModels(
  apiKey: string,
  baseURL: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  return refreshOpenAICompatibleInstance(
    OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
    apiKey,
    baseURL,
    undefined,
    signal,
  );
}

export function clearOpenAICompatibleModels(): void {
  clearOpenAICompatibleInstance(OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID);
}

/** Subscribe to detection-state changes for any instance. The callback fires
 *  on every instance's update; consumers read the instances they care about. */
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  cb();
  return () => {
    listeners.delete(cb);
  };
}

/** React hook for one instance's fetch state. */
export function useOpenAICompatibleModels(
  instanceId: string = OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
): FetchState {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return stateFor(instanceId);
}
