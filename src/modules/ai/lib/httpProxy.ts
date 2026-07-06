import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * CORS-bypassing HTTP fetch for AI provider calls.
 *
 * The WebView enforces CORS: a `fetch` from the app origin
 * (`http://tauri.localhost` on Windows, `tauri://localhost` elsewhere) to a
 * cross-origin OpenAI-compatible gateway that does NOT return an
 * `Access-Control-Allow-Origin` header is blocked before JS can read the
 * response, surfacing as a bare `TypeError: Failed to fetch` with no status.
 * Self-hosted / tunnelled routers (e.g. 9Router over Tailscale, some local
 * llama.cpp / LM Studio setups) typically don't send CORS headers, so the
 * native `fetch` fails for them even when the endpoint is perfectly reachable.
 *
 * `corsFallbackFetch` tries the WebView's native `fetch` first - cloud gateways
 * that already send CORS headers (OpenAI, OpenRouter, ...) keep the fast native
 * path with zero behaviour change - and only on a `Failed to fetch` (a
 * `TypeError`) falls back to a Rust/reqwest proxy (`http_stream`), which runs in
 * the native HTTP stack and is not subject to browser CORS. The proxy streams
 * the response body back over an IPC `Channel`, so SSE chat keeps its
 * token-by-token rendering.
 */

type StreamEvent =
  | { type: "meta"; status: number; headers: [string, string][] }
  | { type: "chunk"; data: string }
  | { type: "error"; message: string }
  | { type: "end" };

// Unique per request so `http_abort` can target the right in-flight stream.
// `crypto.randomUUID` is gated to secure contexts (the app origin is plain
// http), so derive an id from a counter + time + random instead.
let idCounter = 0;
function newRequestId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `req-${Date.now()}-${idCounter}-${Math.floor(Math.random() * 1e9)}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function headerEntries(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([k, v]) => [k, v] as [string, string]);
  return Object.entries(headers);
}

async function bodyToString(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (body instanceof Blob) return await body.text();
  if (body instanceof URLSearchParams) return body.toString();
  // ReadableStream / FormData / other: drain via a throwaway Response.
  try {
    return await new Response(body as BodyInit).text();
  } catch {
    return null;
  }
}

/** Run one request through the Rust streaming proxy and rebuild a streaming
 *  web `Response` from the channel events. */
async function rustProxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const asRequest = input instanceof Request ? input : null;
  const url = asRequest ? asRequest.url : typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? asRequest?.method ?? "GET").toUpperCase();
  const headers = headerEntries(init?.headers ?? asRequest?.headers);
  const body = await bodyToString(init?.body ?? undefined);
  const signal = init?.signal ?? asRequest?.signal ?? undefined;

  // Already aborted before we started: reject without launching the request.
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const id = newRequestId();
  const channel = new Channel<StreamEvent>();

  let resolveMeta!: (m: { status: number; headers: Headers }) => void;
  let rejectMeta!: (e: unknown) => void;
  const metaReady = new Promise<{ status: number; headers: Headers }>((res, rej) => {
    resolveMeta = res;
    rejectMeta = rej;
  });

  let metaSettled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyDone = false;

  const failBody = (err: Error) => {
    if (bodyDone) return;
    bodyDone = true;
    try {
      controller?.error(err);
    } catch {
      /* stream already closed/cancelled */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // Consumer (or the AI SDK on Stop) dropped the body: tell Rust to stop
      // pulling upstream.
      void invoke("http_abort", { id }).catch(() => {});
    },
  });

  channel.onmessage = (ev) => {
    switch (ev.type) {
      case "meta": {
        // Build Headers before flipping the settle flag: if the constructor ever
        // threw, flipping first would strand `metaReady` unsettled (the error
        // branch would take failBody instead of rejectMeta).
        let headers: Headers;
        try {
          headers = new Headers(ev.headers);
        } catch {
          headers = new Headers();
        }
        metaSettled = true;
        resolveMeta({ status: ev.status, headers });
        break;
      }
      case "chunk":
        if (bodyDone) break;
        try {
          controller?.enqueue(base64ToBytes(ev.data));
        } catch {
          /* stream already closed/cancelled */
        }
        break;
      case "error": {
        const err = new Error(ev.message || "Request failed");
        if (!metaSettled) {
          metaSettled = true;
          rejectMeta(err);
        } else {
          failBody(err);
        }
        break;
      }
      case "end":
        if (bodyDone) break;
        bodyDone = true;
        try {
          controller?.close();
        } catch {
          /* stream already closed/cancelled */
        }
        break;
    }
  };

  // Abort handling must settle `metaReady` ourselves: when the request is
  // cancelled before headers arrive, Rust returns without emitting any event,
  // so nothing else would resolve the awaited Response. Surface a real
  // AbortError (name-checked by detection's catch) for parity with fetch().
  const onAbort = () => {
    void invoke("http_abort", { id }).catch(() => {});
    const err = new DOMException("The operation was aborted.", "AbortError");
    if (!metaSettled) {
      metaSettled = true;
      rejectMeta(err);
    } else {
      failBody(err);
    }
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  // Fire the request. It resolves only when the whole body has streamed, so
  // don't await it here; failures before `meta` reject `metaReady`, failures
  // mid-stream error the body.
  void invoke("http_stream", { id, method, url, headers, body, onEvent: channel }).catch((e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (!metaSettled) {
      metaSettled = true;
      rejectMeta(err);
    } else {
      failBody(err);
    }
  });

  const meta = await metaReady;
  // A 204/304 response must not carry a body per the Response contract.
  const noBody = meta.status === 204 || meta.status === 304;
  return new Response(noBody ? null : stream, { status: meta.status, headers: meta.headers });
}

/** Drop-in `fetch`: native first (no change for CORS-friendly cloud gateways),
 *  Rust proxy only when the native call fails with a `Failed to fetch`. */
export const corsFallbackFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  try {
    return await globalThis.fetch(input, init);
  } catch (e) {
    // A genuine CORS/network block surfaces as `TypeError: Failed to fetch`.
    // An aborted request throws an `AbortError` (DOMException), which must NOT
    // trigger a retry - rethrow those untouched.
    if (e instanceof TypeError) return await rustProxyFetch(input, init);
    throw e;
  }
};

/** Idle a stream can go without a byte before we treat the upstream as dead.
 *  Mirrors the Rust proxy's guard (net.rs IDLE_TIMEOUT); generous so a slow
 *  reasoning model with long gaps between tokens is never falsely cut. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Wrap a `fetch` so a request that connects but then produces no body bytes for
 * `idleMs` is aborted, surfacing a clear retryable error instead of hanging the
 * turn forever. The timer measures ONLY time spent waiting on the upstream (it
 * is armed around each `reader.read()` and cleared once bytes arrive), so a slow
 * consumer / backpressure never trips it, and a legitimately slow-but-live SSE
 * stream is unaffected - only a truly wedged connection.
 *
 * The Rust proxy (`net.rs`) already guards its own path; this covers the NATIVE
 * `fetch` path that SumoPod and cloud OpenAI-compatible gateways take (the Rust
 * guard never runs for those because native fetch succeeds first). The error
 * message carries "idle timeout" so `classifyError` maps it to
 * PROVIDER_UNAVAILABLE (retryable) rather than a user abort.
 */
export function withStreamIdleTimeout(
  baseFetch: typeof globalThis.fetch,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): typeof globalThis.fetch {
  return async function idleGuardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const outer =
      init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    const stalled = { hit: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const arm = () => {
      clear();
      timer = setTimeout(() => {
        stalled.hit = true;
        // Release the socket; the awaiting read/connect below turns this into a
        // clear "idle timeout" error.
        controller.abort();
      }, idleMs);
    };

    if (outer) {
      if (outer.aborted) controller.abort((outer as { reason?: unknown }).reason);
      else
        outer.addEventListener(
          "abort",
          () => controller.abort((outer as { reason?: unknown }).reason),
          { once: true },
        );
    }

    // Guard connect + time-to-headers. Call via `.call(globalThis, ...)` so a
    // bare `globalThis.fetch` reference keeps its required `this` binding (an
    // arrow like corsFallbackFetch ignores it).
    arm();
    let res: Response;
    try {
      res = await baseFetch.call(globalThis, input, { ...init, signal: controller.signal });
    } catch (e) {
      clear();
      if (stalled.hit) throw new Error("upstream stalled before response (idle timeout)");
      throw e;
    }
    clear();
    if (!res.body) return res;

    const reader = res.body.getReader();
    const guarded = new ReadableStream<Uint8Array>({
      async pull(out) {
        arm();
        try {
          const { done, value } = await reader.read();
          clear();
          if (done) {
            out.close();
            return;
          }
          out.enqueue(value);
        } catch (e) {
          clear();
          out.error(stalled.hit ? new Error("upstream stalled mid-stream (idle timeout)") : e);
        }
      },
      cancel(reason) {
        clear();
        void reader.cancel(reason).catch(() => {});
      },
    });
    // Drop framing headers: the body is re-streamed, so the upstream
    // content-length / encoding no longer describe it and would make the rebuilt
    // Response inconsistent (mirrors the Rust proxy's header filter in net.rs).
    const headers = new Headers();
    res.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (
        k === "content-length" ||
        k === "content-encoding" ||
        k === "transfer-encoding" ||
        k === "connection"
      )
        return;
      headers.append(key, value);
    });
    return new Response(guarded, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } as typeof globalThis.fetch;
}
