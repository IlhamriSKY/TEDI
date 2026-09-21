/**
 * Self-check for the AgentRouter provider.
 * Run: `npx tsx scripts/ai/agentrouter-verify.ts`.
 *
 * AgentRouter resells Claude Code / Codex access and allowlists the `User-Agent`
 * by PREFIX; anything else gets 401 `unauthorized_client_error`, which reads
 * like a bad API key and sent the last investigation down the wrong path.
 * Measured 2026-07-31 against POST https://agentrouter.org/v1/chat/completions
 * ("passed" = reached token validation, i.e. cleared the client gate):
 *
 *   claude-cli/1.0.0 (external, cli)            -> passed
 *   claude-cli/1.0.0 (external, cli) extra/1.2  -> passed  (suffixes are fine)
 *   claude-cli/2.0.0 (external, cli)            -> passed  (version is free)
 *   claude-cli/1.0.0                            -> BLOCKED (needs "(external, cli")
 *   prefix claude-cli/1.0.0 (external, cli)     -> BLOCKED (must be at the START)
 *   codex_cli_rs/0.20.0 whatever                -> passed
 *   any browser UA | curl | no UA               -> BLOCKED
 *
 * Suffixes being allowed matters: the AI SDK appends its own agent string
 * ("ai-sdk/openai-compatible/... runtime/...") to whatever we set, so the header
 * on the wire is never exactly our constant.
 *
 * Two things must hold or the provider silently 401s, and BOTH are easy to
 * break with a well-meaning "simplification":
 *
 *  1. The UA has to survive all the way onto the wire. It is a custom header on
 *     an AI-SDK provider, so this asserts the SDK actually forwards it.
 *  2. The request must NOT go through the WebView's fetch. `User-Agent` is a
 *     forbidden header name there, so the browser drops it silently - no error,
 *     just a 401 from the gateway. Only the Rust proxy can send it.
 *
 * Checks 1-3 exercise the real AI SDK against a spy fetch; check 4 guards the
 * wiring in agent.ts, which no runtime test can reach without a Tauri host.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AGENTROUTER_BASE_URL,
  AGENTROUTER_HEADERS,
  AGENTROUTER_USER_AGENT,
} from "../../src/modules/ai/config";
import { fillEmptyReasoning, withReasoningPassback } from "../../src/modules/ai/lib/agentrouter";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

/** What a User-Agent must START with to clear AgentRouter's client gate. */
const ACCEPTED_UA_PREFIX = /^(claude-cli\/\S+ \(external, cli|codex_cli_rs\/\S+)/;

const SSE_BODY =
  [
    `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ha"}}]}`,
    `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"}}]}`,
    `data: [DONE]`,
  ].join("\n\n") + "\n\n";

type Seen = { url: string; headers: Headers; body: string };

/** Stand-in for the Rust proxy: records the request and replays an SSE reply. */
function spyFetch(seen: Seen[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers ?? {}),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(SSE_BODY, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
}

async function main() {
  console.log("[1] the approved User-Agent reaches the wire, and the URL keeps its /v1");
  const seen: Seen[] = [];
  const model = createOpenAICompatible({
    name: "agentrouter",
    baseURL: AGENTROUTER_BASE_URL,
    apiKey: "sk-test",
    headers: { ...AGENTROUTER_HEADERS },
    fetch: spyFetch(seen),
    includeUsage: true,
  })("gpt-5.6-sol");

  // Drive it through the real streaming entry point the app uses.
  let text = "";
  for await (const delta of streamText({ model, prompt: "hi" }).textStream) text += delta;

  assert(seen.length === 1, `exactly one request was made (${seen.length})`);
  const req = seen[0];
  assert(
    req?.url === "https://agentrouter.org/v1/chat/completions",
    `posts to /v1/chat/completions, not the SPA catch-all (${req?.url})`,
  );
  // The bare origin is an SPA whose catch-all answers 200 + HTML, so a dropped
  // `/v1` yields an empty reply rather than an error. Covered by case [6] of
  // stream-idle-timeout-verify; asserted here so the constant cannot regress.
  assert(AGENTROUTER_BASE_URL.endsWith("/v1"), `base URL keeps its /v1 (${AGENTROUTER_BASE_URL})`);
  // `startsWith`, not equality: the AI SDK appends its own agent string. That is
  // harmless (suffixes clear the gate) but it does mean the outgoing header is
  // never exactly our constant, so an equality assert here would fail for a
  // request the gateway is perfectly happy with.
  const sentUA = req?.headers.get("user-agent") ?? "";
  assert(
    sentUA.startsWith(AGENTROUTER_USER_AGENT),
    `the SDK forwarded our User-Agent as the PREFIX (${sentUA})`,
  );
  assert(
    ACCEPTED_UA_PREFIX.test(sentUA),
    `what actually goes on the wire clears the client gate (${sentUA})`,
  );
  assert(
    req?.headers.get("authorization") === "Bearer sk-test",
    "the API key still rides along as a bearer token",
  );

  console.log("\n[2] the SSE reply streams back as assistant text");
  assert(text === "halo", `streamed body decoded to text ("${text}")`);

  console.log("\n[3] the model id is sent upstream unchanged (no namespacing here)");
  assert(
    req?.body.includes(`"model":"gpt-5.6-sol"`),
    "request body carries the raw model id, not a namespaced one",
  );

  console.log("\n[4] agent.ts routes AgentRouter through the Rust proxy, never the WebView");
  const agentSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/modules/ai/lib/agent.ts"),
    "utf8",
  );
  const caseBody = agentSrc.slice(
    agentSrc.indexOf(`case "agentrouter":`),
    agentSrc.indexOf(`case "openai-compatible":`),
  );
  assert(caseBody.length > 0, "the agentrouter case exists in buildLanguageModel");
  assert(
    caseBody.includes("proxyOnlyFetch"),
    "uses proxyOnlyFetch (a WebView fetch would silently drop the User-Agent)",
  );
  assert(
    !caseBody.includes("corsFallbackFetch") && !caseBody.includes("globalThis.fetch"),
    "does NOT fall back to the native fetch (AgentRouter sends Allow-Origin: *, so the " +
      "native call would succeed, skip the proxy, and send no User-Agent)",
  );
  assert(
    caseBody.includes("AGENTROUTER_HEADERS"),
    "passes the User-Agent header block to the provider",
  );

  assert(
    caseBody.includes("withReasoningPassback(proxyOnlyFetch)"),
    "fills the reasoning DeepSeek there demands back for a tool call made without any",
  );

  console.log("\n[5] a DeepSeek tool call made with no reasoning goes back with a placeholder");
  // Measured 2026-09-21: the step after one like this 400s with "The
  // `content[].thinking` in the thinking mode must be passed back to the API",
  // and an empty string is refused just the same.
  const call = [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }];
  const body = (model: string, reasoning?: string) =>
    JSON.stringify({
      model,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: call, reasoning_content: reasoning },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    });
  const sent = (b: string) => JSON.parse(fillEmptyReasoning(b)).messages[1].reasoning_content;
  assert(sent(body("deepseek-v4-flash")) === " ", "a missing reasoning becomes one space");
  assert(sent(body("deepseek-v4-flash", "")) === " ", "an empty reasoning becomes one space");
  assert(sent(body("deepseek-v4-flash", "plan")) === "plan", "real reasoning is left alone");
  assert(
    sent(body("claude-opus-5")) === undefined,
    "a non-DeepSeek model is untouched (Claude would read it as an unsigned thinking block)",
  );
  const plain = JSON.stringify({ model: "deepseek-v4-flash", messages: [] });
  assert(fillEmptyReasoning(plain) === plain, "a body with no tool calls passes through as is");

  console.log("\n[6] the same refusal is retried, any other error is not");
  // The identical body, replayed, is refused about one time in five.
  const replies = (...rs: Array<[number, string]>) => {
    let calls = 0;
    const f = (async () => {
      const [status, text] = rs[Math.min(calls++, rs.length - 1)];
      return new Response(text, { status });
    }) as typeof globalThis.fetch;
    return { f, calls: () => calls };
  };
  const refusal = `{"error":{"message":"The \`content[].thinking\` in the thinking mode must be passed back to the API."}}`;
  const flaky = replies([400, refusal], [200, "{}"]);
  const res = await withReasoningPassback(flaky.f)("u", { body: "{}" });
  assert(
    res.status === 200 && flaky.calls() === 2,
    `a refusal then a success is a success (${flaky.calls()} calls)`,
  );
  const stuck = replies([400, refusal]);
  await withReasoningPassback(stuck.f)("u", { body: "{}" });
  assert(
    stuck.calls() === 4,
    `a refusal that keeps coming back gives up after 4 tries (${stuck.calls()})`,
  );
  const other = replies([400, `{"error":{"message":"bad model"}}`]);
  await withReasoningPassback(other.f)("u", { body: "{}" });
  assert(other.calls() === 1, "any other 400 is returned at once");

  if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
  console.log("\nAll AgentRouter checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
