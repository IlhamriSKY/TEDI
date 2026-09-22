import { useSyncExternalStore } from "react";
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
 * Uses the SAME endpoint and fetch as chat, so a green detection proves the chat
 * path reaches the API, not just that the host is up. The old mistake was a
 * reachability check that passed on a response chat could never use.
 *
 * No curated default list: there is no published catalogue, and invented ids
 * would put models in the picker that 404 on send.
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
 * AgentRouter's two 401 shapes look identical but mean opposite things:
 *
 *  - `unauthorized_client_error` is the User-Agent gate, NOT the key. Since we
 *    always send an approved UA, seeing it means the allowlist moved. Calling
 *    this "check your key" is what misdirected the last investigation.
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

/**
 * DeepSeek on AgentRouter sometimes makes a tool call with NO reasoning, then
 * refuses the next step with "The `content[].thinking` in the thinking mode must
 * be passed back to the API", because that step has nothing to pass back. The AI
 * SDK omits empty reasoning, and an empty string is refused too; any non-empty
 * value is accepted (measured 2026-09-21). So such a step goes out with a
 * one-space placeholder. DeepSeek only: a Claude upstream would read the field as
 * a thinking block with no signature.
 */
export function fillEmptyReasoning(body: string): string {
  if (!body.includes('"tool_calls"')) return body;
  let req: { model?: unknown; messages?: Array<Record<string, unknown>> };
  try {
    req = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof req.model !== "string" || !/deepseek/i.test(req.model)) return body;
  let changed = false;
  for (const m of req.messages ?? []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && !m.reasoning_content) {
      m.reasoning_content = " ";
      changed = true;
    }
  }
  return changed ? JSON.stringify(req) : body;
}

/** Refused before any generation, so a retry costs nothing but a round trip. */
const PASSBACK_REFUSAL = "must be passed back to the API";
const PASSBACK_ATTEMPTS = 4;

/**
 * Fills the placeholder above, and retries the same refusal when it comes back
 * anyway: the gateway load-balances across upstreams and about one request in
 * five draws one that refuses a body the rest accept (the identical body,
 * replayed, measured 2026-09-21).
 */
export function withReasoningPassback(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const req =
      typeof init?.body === "string" ? { ...init, body: fillEmptyReasoning(init.body) } : init;
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(input, req);
      if (res.status !== 400 || attempt >= PASSBACK_ATTEMPTS) return res;
      if (!(await res.clone().text()).includes(PASSBACK_REFUSAL)) return res;
    }
  };
}

const LANGUAGE_NOTE =
  "<system-reminder>\nThe user may write in any language or in informal English, and may mix languages in one message. That is normal input: read it as written. Reply in the language of the user's latest message unless they ask for another, and keep code, commands, file paths and identifiers exactly as they are.\n</system-reminder>";

/** Puts `LANGUAGE_NOTE` at the head of the FIRST user message. */
export function addLanguageNote(body: string): string {
  let req: { messages?: Array<{ role?: unknown; content?: unknown }> };
  try {
    req = JSON.parse(body);
  } catch {
    return body;
  }
  const first = req.messages?.find((m) => m.role === "user");
  if (typeof first?.content === "string") {
    first.content = `${LANGUAGE_NOTE}\n\n${first.content}`;
  } else if (Array.isArray(first?.content)) {
    first.content.unshift({ type: "text", text: LANGUAGE_NOTE });
  } else {
    return body;
  }
  return JSON.stringify(req);
}

/**
 * AgentRouter refuses user text it reads as a language other than English,
 * Chinese, French or German (`400 content-blocked`), and misreads slangy English
 * as one of them. Measured 2026-09-22 with a fake key: the note above, in the
 * first user message, let
 * short and medium Indonesian, Japanese and slang through, over 12 turns; the
 * same note on every message, or a short one, did not; a long all-Indonesian
 * paragraph is refused regardless. The refusal comes back in ~80 ms, before any
 * generation, so only a refused request is re-sent with the note and every
 * request the gateway already takes goes out unchanged.
 */
export function withLanguageNote(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await fetchFn(input, init);
    if (res.status !== 400 || typeof init?.body !== "string") return res;
    if (!(await res.clone().text()).includes("content-blocked")) return res;
    const body = addLanguageNote(init.body);
    return body === init.body ? res : fetchFn(input, { ...init, body });
  };
}

/** Reset AgentRouter state on key removal. Nothing stays in the registry: with
 *  no curated list there is nothing meaningful to show without a key. */
export function clearAgentRouterModels(): void {
  setDetectedModels("agentrouter", []);
  state = { status: "idle", error: null, models: [], fetchedAt: null };
  emit();
}

/** React hook for the AgentRouter fetch state. `useSyncExternalStore` rather
 *  than useState + useEffect: the hand-rolled pair reads `state` at render but
 *  only subscribes afterwards, so a detection landing in that gap is missed.
 *  `state` is replaced wholesale on every change and never mutated, so
 *  returning it directly is a stable snapshot. */
export function useAgentRouterModels(): FetchState {
  return useSyncExternalStore(subscribeAgentRouterModels, () => state);
}
