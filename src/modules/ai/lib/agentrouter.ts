import { useEffect, useState } from "react";
import {
  AGENTROUTER_BASE_URL,
  AGENTROUTER_HEADERS,
  friendlyModelLabel,
  parseModelsList,
  setDetectedModels,
  type ModelInfo,
  type OpenAIModelsResponse,
} from "../config";
import { proxyOnlyFetch } from "./httpProxy";

/**
 * AgentRouter model detection.
 *
 * Deliberately hits the SAME endpoint and the SAME fetch as chat
 * (`proxyOnlyFetch` + the spoofed `User-Agent`), so a green detection is proof
 * the chat path reaches the API rather than just proof the host is up. The
 * older mistake here was a reachability check that passed on a response chat
 * could never use.
 *
 * No curated default list: unlike SumoPod there is no published catalogue to
 * hard-code, and inventing ids would put models in the picker that 404 on send.
 */

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

export function subscribeAgentRouterModels(cb: (s: FetchState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Turn AgentRouter's two 401 shapes into messages that name the real cause.
 * They look identical to a user (both are "401") but mean opposite things:
 *
 *  - `unauthorized_client_error` ("unauthorized client detected") is the
 *    User-Agent gate, NOT the key. Seeing it here means the allowlist moved,
 *    since we always send an approved UA. Saying "check your key" for this is
 *    what sent the last investigation down the wrong path.
 *  - `new_api_error` / 无效的令牌 is a genuinely bad or expired key.
 */
function describeAuthFailure(status: number, body: string): string {
  if (/unauthorized_client/i.test(body)) {
    return `AgentRouter rejected the client, not the key (HTTP ${status}). It gates on the User-Agent and ours is no longer accepted; AGENTROUTER_USER_AGENT in config.ts needs updating.`;
  }
  if (status === 401 || /无效的令牌|invalid.*token/i.test(body)) {
    return `AgentRouter rejected the API key (HTTP ${status}). Check the key in Settings → AI.`;
  }
  return `AgentRouter /models returned ${status}${body ? `: ${body.slice(0, 200)}` : ""}`;
}

/** Fetch the AgentRouter catalogue and publish it into the dynamic registry.
 *  Safe to call repeatedly. Pass `signal` to cancel. */
export async function refreshAgentRouterModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  state = { ...state, status: "loading", error: null };
  emit();
  try {
    // proxyOnlyFetch, never the native fetch: the WebView silently drops the
    // `User-Agent` below and AgentRouter answers 401 without it.
    const res = await proxyOnlyFetch(`${AGENTROUTER_BASE_URL}/models`, {
      method: "GET",
      headers: {
        ...AGENTROUTER_HEADERS,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(describeAuthFailure(res.status, text));

    let payload: OpenAIModelsResponse | null;
    try {
      payload = JSON.parse(text) as OpenAIModelsResponse | null;
    } catch {
      throw new Error(`AgentRouter /models did not return JSON: ${text.slice(0, 120)}`);
    }
    const raws = parseModelsList(payload);

    // Omit `ownedBy` so the chat chip credits the gateway rather than the
    // upstream maker, matching the "via AgentRouter" hint in the dropdown.
    const models: ModelInfo[] = raws
      .map((raw) => ({
        id: raw.id,
        provider: "agentrouter" as const,
        label: friendlyModelLabel(raw.id),
        hint: "via AgentRouter",
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    setDetectedModels("agentrouter", models);
    state = { status: "ok", error: null, models, fetchedAt: Date.now() };
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

/** Reset AgentRouter state on key removal. Nothing stays in the registry: with
 *  no curated list there is nothing meaningful to show without a key. */
export function clearAgentRouterModels(): void {
  setDetectedModels("agentrouter", []);
  state = { status: "idle", error: null, models: [], fetchedAt: null };
  emit();
}

/** React hook for the AgentRouter fetch state. */
export function useAgentRouterModels(): FetchState {
  const [snapshot, setSnapshot] = useState<FetchState>(state);
  useEffect(() => subscribeAgentRouterModels(setSnapshot), []);
  return snapshot;
}
