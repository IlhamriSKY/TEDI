/**
 * Self-check for the streaming idle-timeout wrapper (withStreamIdleTimeout).
 * Run: `npx tsx scripts/stream-idle-timeout-verify.ts`.
 *
 * The wrapper must:
 *  1. STALL -> ERROR: a body that goes silent past idleMs errors with an
 *     "idle timeout" message (so classifyError -> PROVIDER_UNAVAILABLE), not hang.
 *  2. LIVE STREAM PASSES: chunks arriving with gaps < idleMs stream to completion
 *     untouched (the timer resets per chunk).
 *  3. OUTER ABORT PROPAGATES: aborting the caller's signal aborts the wrapped
 *     request (and does not masquerade as an idle timeout).
 *  4. CONNECT STALL: a baseFetch that never resolves is abandoned after idleMs.
 *  5. HTML ON 2xx -> ERROR: a gateway whose base URL is missing its `/v1` answers
 *     200 with its own landing page; the SSE parser finds no `data:` lines there,
 *     so without this the turn ends as a silent EMPTY reply. A non-2xx HTML body
 *     must still pass through, so the provider's own status error wins.
 */
import { withStreamIdleTimeout } from "../src/modules/ai/lib/httpProxy";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function drain(res: Response): Promise<{ text: string; error: Error | null }> {
  let text = "";
  try {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    return { text, error: null };
  } catch (e) {
    return { text, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** A baseFetch that streams `chunks`, waiting `gapMs` before EACH chunk. A gap
 *  of Infinity means "never send this chunk" (a mid-stream stall). Honors
 *  `init.signal` during the gap exactly as a real `fetch` does: an abort rejects
 *  the in-flight read. */
function fakeFetch(chunks: string[], gapMs: number): typeof globalThis.fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const next = chunks.shift();
        if (next === undefined) {
          c.close();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const sig = init?.signal;
          if (sig?.aborted) return reject(new Error("aborted"));
          const t =
            gapMs === Infinity
              ? undefined
              : setTimeout(() => {
                  sig?.removeEventListener("abort", onAbort);
                  resolve();
                }, gapMs);
          function onAbort() {
            if (t) clearTimeout(t);
            reject(new Error("aborted"));
          }
          sig?.addEventListener("abort", onAbort, { once: true });
        });
        c.enqueue(enc.encode(next));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
}

async function main() {
  const IDLE = 120; // ms, tiny for the test

  console.log("[1] mid-stream stall -> 'idle timeout' error (not a hang)");
  {
    // Emit one chunk fast, then wedge forever (second chunk has an Infinite gap).
    const enc = new TextEncoder();
    let sent = false;
    const stallingBase = (async (_i: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(enc.encode("hello"));
            return;
          }
          await new Promise<void>((_r, rej) =>
            init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;
    const wrapped = withStreamIdleTimeout(stallingBase, IDLE);
    const t0 = Date.now();
    const { text, error } = await drain(await wrapped("http://x"));
    const dt = Date.now() - t0;
    assert(text === "hello", `got first chunk before stall (text="${text}")`);
    assert(!!error && /idle timeout/i.test(error.message), `errored with idle timeout (${error?.message})`);
    assert(dt < IDLE * 4, `errored promptly (~${dt}ms, budget ${IDLE}ms)`);
  }

  console.log("\n[2] live stream with sub-idle gaps passes untouched");
  {
    const wrapped = withStreamIdleTimeout(fakeFetch(["a", "b", "c"], IDLE / 3), IDLE);
    const { text, error } = await drain(await wrapped("http://x"));
    assert(error === null, "no error on a live stream");
    assert(text === "abc", `full body streamed ("${text}")`);
  }

  console.log("\n[3] outer abort propagates and is NOT mislabelled as idle timeout");
  {
    const ac = new AbortController();
    const wrapped = withStreamIdleTimeout(fakeFetch(["x", "y", "z"], 1000), IDLE * 100);
    const p = drain(await wrapped("http://x", { signal: ac.signal }));
    await sleep(30);
    ac.abort();
    const { error } = await p;
    assert(!!error, "aborting the outer signal errors the stream");
    assert(!!error && !/idle timeout/i.test(error.message), `not mislabelled as idle timeout (${error?.message})`);
  }

  console.log("\n[4] connect stall (baseFetch never resolves) -> idle timeout");
  {
    const neverResolves = (async (_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      })) as typeof globalThis.fetch;
    const wrapped = withStreamIdleTimeout(neverResolves, IDLE);
    const t0 = Date.now();
    let error: Error | null = null;
    try {
      await wrapped("http://x");
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    const dt = Date.now() - t0;
    assert(!!error && /idle timeout/i.test(error.message), `connect stall -> idle timeout (${error?.message})`);
    assert(dt < IDLE * 4, `abandoned promptly (~${dt}ms)`);
  }

  console.log("\n[5] status/statusText/content-type preserved; framing headers dropped");
  {
    const base = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: hi\n\n"));
          c.close();
        },
      });
      return new Response(body, {
        status: 201,
        statusText: "Created",
        headers: {
          "content-type": "text/event-stream",
          "content-length": "999",
          "content-encoding": "gzip",
        },
      });
    }) as typeof globalThis.fetch;
    const wrapped = withStreamIdleTimeout(base, IDLE);
    const res = await wrapped("http://x");
    assert(res.status === 201, `status preserved (${res.status})`);
    assert(res.statusText === "Created", `statusText preserved (${res.statusText})`);
    assert(res.headers.get("content-type") === "text/event-stream", "content-type preserved");
    assert(res.headers.get("content-length") === null, "content-length dropped");
    assert(res.headers.get("content-encoding") === null, "content-encoding dropped");
    const { text } = await drain(res);
    assert(text === "data: hi\n\n", "body streamed intact");
  }

  console.log("\n[6] HTML on 2xx -> error naming the base URL; HTML on non-2xx passes through");
  {
    const htmlAt = (status: number) =>
      (async () =>
        new Response('<!doctype html>\n<html lang="zh">…', {
          status,
          headers: { "content-type": "text/html; charset=utf-8" },
        })) as typeof globalThis.fetch;

    let error: Error | null = null;
    try {
      await withStreamIdleTimeout(htmlAt(200), IDLE)("https://agentrouter.org/chat/completions");
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    assert(!!error, "200 + text/html rejects instead of streaming an empty reply");
    assert(
      !!error && /html page/i.test(error.message) && /\/v1/.test(error.message),
      `error names the cause and the fix (${error?.message})`,
    );
    assert(
      !!error && error.message.includes("https://agentrouter.org/chat/completions"),
      "error names WHICH endpoint answered (multiple can be configured)",
    );
    // classifyError must land on UNKNOWN (non-retryable): a misconfigured base
    // URL never fixes itself, so retrying it three times only hides the message.
    assert(
      !!error && !/\b(401|429|unauthorized|rate limit|timeout|network)\b/i.test(error.message),
      "message does not trip classifyError into a retryable/auth code",
    );

    // 404/500 HTML error pages are common and carry a real status: leave them
    // to the provider's own error handling rather than masking it.
    let passed = true;
    try {
      const res = await withStreamIdleTimeout(htmlAt(404), IDLE)("http://x");
      passed = res.status === 404;
    } catch {
      passed = false;
    }
    assert(passed, "non-2xx HTML passes through untouched");
  }

  if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
  console.log("\nALL PASS");
}

void main();
