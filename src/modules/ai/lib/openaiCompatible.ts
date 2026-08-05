import { useEffect, useState } from "react";
import { corsFallbackFetch } from "./httpProxy";
import {
  clearOpenAICompatibleRuntime,
  friendlyModelLabel,
  isLoopbackBaseURL,
  normalizeOpenAICompatibleBaseURL,
  OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
  openaiCompatibleModelId,
  parseModelsList,
  type OpenAIModelsResponse,
  setDetectedModelsForInstance,
  setOpenAICompatibleRuntime,
  type ModelInfo,
} from "../config";

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

// Detected and hand-typed ids are tracked apart so that neither wipes the other:
// a re-detect must not drop the ids the user typed, and typing one must not
// require a successful detection. What reaches the picker is always the union.
const detectedByInstance = new Map<string, ModelInfo[]>();
const manualByInstance = new Map<string, string[]>();

function manualInfo(instanceId: string, rawId: string, label?: string): ModelInfo {
  return {
    id: openaiCompatibleModelId(instanceId, rawId),
    provider: "openai-compatible" as const,
    label: friendlyModelLabel(rawId),
    hint: hintFor({}, label),
  };
}

/** Publish detected + hand-typed models for one instance, detected first, and
 *  return the union so the caller can record it as the instance's model list. */
function publishModels(instanceId: string, label?: string): ModelInfo[] {
  const detected = detectedByInstance.get(instanceId) ?? [];
  const seen = new Set(detected.map((m) => m.id));
  const manual = (manualByInstance.get(instanceId) ?? [])
    .map((raw) => manualInfo(instanceId, raw, label))
    .filter((m) => !seen.has(m.id));
  const all = [...detected, ...manual];
  setDetectedModelsForInstance(instanceId, all);
  return all;
}

/**
 * Register hand-typed model ids for an instance and publish them, with no
 * network call. This is the only way to use an endpoint whose `/models` cannot
 * be read, so it deliberately does not require a successful detection first.
 */
export function setManualOpenAICompatibleModels(
  instanceId: string,
  baseURL: string,
  apiKey: string,
  ids: readonly string[],
  label?: string,
): void {
  const clean = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
  manualByInstance.set(instanceId, clean);
  const url = normalizeOpenAICompatibleBaseURL(baseURL);
  // Register the runtime too: a model picked from a manual id still needs a
  // client, and detection may never have run for this instance.
  if (url) setOpenAICompatibleRuntime(instanceId, url, apiKey);
  const all = publishModels(instanceId, label);
  const prev = stateFor(instanceId);
  states.set(instanceId, { ...prev, models: all });
  emit();
}

export function getOpenAICompatibleModelsState(
  instanceId: string = OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
): FetchState {
  return stateFor(instanceId);
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
 * Can this instance be detected and used? A base URL always; a key only for
 * REMOTE endpoints. Local servers authenticate with nothing, and gating them on
 * a key cleared the instance before it could register, so its models never
 * appeared and its namespaced ids never resolved.
 */
export function isOpenAICompatibleInstanceReady(baseURL: string, key: string | null): boolean {
  if (!baseURL) return false;
  return !!key || isLoopbackBaseURL(normalizeOpenAICompatibleBaseURL(baseURL));
}

/**
 * Publish one instance's `/models` into the dynamic registry under namespaced
 * ids (`<instanceId>::<rawId>`), so endpoints never collide, and record its URL
 * + key in the runtime resolver so the agent can build the right client.
 * Idempotent; `signal` cancels.
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
    states.set(instanceId, {
      ...stateFor(instanceId),
      status: "error",
      error: "Base URL is empty",
    });
    emit();
    return [];
  }
  // Register runtime resolution up-front so a model picked before detection
  // finishes still resolves to the right endpoint.
  setOpenAICompatibleRuntime(instanceId, trimmedURL, apiKey);
  states.set(instanceId, { ...stateFor(instanceId), status: "loading", error: null });
  emit();
  try {
    // corsFallbackFetch tries the native fetch first, then routes through the
    // Rust proxy when the WebView blocks a cross-origin gateway with no CORS
    // headers (the "Failed to fetch" local/tunnelled routers hit).
    const res = await corsFallbackFetch(`${trimmedURL}/models`, {
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
    // A base URL missing its `/v1` (or pointing at the site rather than the API)
    // answers 200 with the marketing page, and `res.json()` then fails with a
    // bare "Unexpected token '<'" that says nothing about the cause.
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error(
        `${trimmedURL}/models returned a web page, not JSON - check the base URL (it usually ends in /v1)`,
      );
    }
    let payload: OpenAIModelsResponse | null;
    try {
      payload = JSON.parse(text) as OpenAIModelsResponse | null;
    } catch {
      throw new Error(`/models did not return JSON: ${text.slice(0, 120)}`);
    }
    const raws = parseModelsList(payload);
    const detected: ModelInfo[] = raws
      .map((raw) => ({
        // Namespace the id so the agent can route the model to this instance,
        // and so two endpoints exposing the same model id stay distinct.
        id: openaiCompatibleModelId(instanceId, raw.id),
        provider: "openai-compatible" as const,
        label: friendlyModelLabel(raw.id),
        hint: hintFor(raw, label),
        ownedBy: raw.owned_by,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    detectedByInstance.set(instanceId, detected);
    const published = publishModels(instanceId, label);
    states.set(instanceId, {
      status: "ok",
      error: null,
      models: published,
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
  // Both halves, or a re-added endpoint would inherit the old instance's ids.
  // The persisted `manualModels` is the source of truth and republishes on load.
  detectedByInstance.delete(instanceId);
  manualByInstance.delete(instanceId);
  states.set(instanceId, { status: "idle", error: null, models: [], fetchedAt: null });
  emit();
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
