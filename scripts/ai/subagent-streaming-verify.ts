/**
 * Self-check for the three fixes behind "sub-agents did nothing, and the session
 * re-paid for itself".
 * Run: `npx tsx scripts/ai/subagent-streaming-verify.ts`.
 *
 * All three were found in one long-run debug export (27 request snapshots,
 * gpt-5.6-luna on the ChatGPT-account provider):
 *
 *  1. TRANSPORT. Every one of 9 sub-agents failed, with an EMPTY error string.
 *     `runSubagent` was the app's only non-streaming call site, and the AI SDK's
 *     Responses `doGenerate` posts WITHOUT `stream: true`, while the ChatGPT
 *     backend (chatgpt.com/backend-api/codex) speaks SSE and nothing else.
 *     MEASURED against the live endpoint, same model and token, the two calls
 *     differing only in that flag:
 *       generateText -> 400 `{"detail":"Stream must be set to true"}`, message ""
 *       streamText   -> ok
 *     A `generateText` anywhere in that file is the bug coming back, which is
 *     why this is asserted on the source.
 *  1b. AND `store: false`. Fixing the stream flag alone was NOT enough: the very
 *     next live call returned 400 `{"detail":"Store must be set to false"}`.
 *     The main loop sends both through `providerRequestOptions`; runSubagent
 *     sent neither. Two mandatory options, one missing helper call.
 *  2. THE ERROR WAS BLANK. The SDK only fills `message` from an OpenAI-shaped
 *     body, so that endpoint's `{"detail": "..."}` arrived as "". The
 *     orchestrator received `{"error": ""}` and simply retried the same call.
 *  3. THE PROMPT MOVED. Project memory was read from the LIVE workspace root,
 *     which follows the active terminal. Clicking a terminal in another project
 *     dropped the `## PROJECT` block out of the SYSTEM prompt mid-session -
 *     measured at one 0%-cache request re-pricing 607K chars, 42% of all fresh
 *     prompt bytes in the capture.
 */
import { readFileSync } from "node:fs";
import { stepCountIs, streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { providerHasPromptCache, providerRequestOptions } from "../../src/modules/ai/lib/cache";
import { describeProviderError } from "../../src/modules/ai/lib/errors";
import { scrubErrorPath, type ToolContext } from "../../src/modules/ai/tools/context";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const src = (rel: string): string =>
  readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");

console.log("[transport] a sub-agent must stream, or the SSE-only endpoint refuses it");
const runSubagentSrc = src("modules/ai/agents/runSubagent.ts");
check("runSubagent calls streamText", runSubagentSrc.includes("streamText("));
check(
  "NO generateText survives (doGenerate omits `stream: true`)",
  !/\bgenerateText\s*\(/.test(runSubagentSrc),
);
check(
  "the recovery summarizer streams too - it is the path that runs when a model went quiet",
  runSubagentSrc.includes("const fu = streamText({"),
);
check(
  "the real provider error is captured, not the SDK's generic NoOutputGeneratedError",
  runSubagentSrc.includes("onError:") && runSubagentSrc.includes("throw streamError ?? e"),
);
check(
  "a stream that errored AFTER completing steps still throws, so the retry can classify it",
  runSubagentSrc.includes("if (streamError) throw streamError;"),
);

console.log("\n[errors] a failed sub-agent never reports an empty string");
const ctx = { getWorkspaceRoot: () => "D:/work/proj" } as ToolContext;
// Exactly what `describeSubagentFailure` composes in tools/subagent.ts.
const describe = (e: unknown): string =>
  scrubErrorPath(describeProviderError(e), ctx) || "the provider rejected the request";
// The shape the ChatGPT-account endpoint actually returns: the SDK leaves
// `message` empty because the body is not `{ error: { message } }`.
const chatgptRefusal = Object.assign(new Error(""), {
  statusCode: 400,
  responseBody: JSON.stringify({ detail: "stream must be true" }),
});
check("a blank-message provider error becomes readable", describe(chatgptRefusal).length > 0);
check("...and says what the provider said", describe(chatgptRefusal) === "stream must be true");
check(
  "the old behaviour really was empty (this is the bug, not a straw man)",
  scrubErrorPath(chatgptRefusal, ctx) === "",
);
check(
  "a status-only failure still says something",
  describe(Object.assign(new Error(""), { statusCode: 503 })).includes("503"),
);
check("nothing at all still says something", describe(undefined).length > 0);
check(
  "local paths are still masked, so a tool failure cannot leak the disk layout",
  !describe(new Error("read failed D:/work/proj/src/a.ts")).includes("D:/work/proj"),
);

console.log("\n[cache] the ChatGPT endpoint is the OpenAI Responses backend, so it caches");
// Asserted BEFORE any noteProviderCacheRead: the point is the COLD-START answer.
// Left out of the table, turn 1 of a resumed session sends history in the
// cache-less shape and turn 2, after the first usage report flips it, sends the
// cached shape - rewriting bytes already sent and voiding the prefix once per run.
check("chatgpt is tabled as caching from the first turn", providerHasPromptCache("chatgpt"));
check("its sibling openai still is", providerHasPromptCache("openai"));
check("a genuinely cache-less provider is untouched", !providerHasPromptCache("groq"));

console.log("\n[prompt] the system prompt does not move when the user clicks another project");
const transportSrc = src("modules/ai/lib/transport.ts");
check(
  "project memory is read from the session-pinned root",
  transportSrc.includes("readProjectMemory(promptWorkspaceRoot)"),
);
check(
  "so is saved memory - it lands in the same system prompt",
  transportSrc.includes("readMemory(promptWorkspaceRoot)"),
);
check(
  "neither reads the live root any more (that was the 607K-char re-price)",
  !transportSrc.includes("readProjectMemory(live.workspaceRoot)") &&
    !transportSrc.includes("readMemory(live.workspaceRoot)"),
);
check(
  "TOOLS still follow the user into the other project (turn pin is untouched)",
  transportSrc.includes("pinTurnCwd?.(live.cwd, live.workspaceRoot)"),
);

// The contract any correct pin must satisfy. chatStore owns the real closure;
// the source check below ties this to it.
let pinned: string | null = null;
const pinSessionWorkspaceRoot = (live: string | null): string | null => {
  if (pinned === null) pinned = live;
  return pinned;
};
check("no workspace yet -> stays unpinned", pinSessionWorkspaceRoot(null) === null);
check("...so a root arriving later still wins", pinSessionWorkspaceRoot("/a") === "/a");
check("a mid-session switch does NOT move it", pinSessionWorkspaceRoot("/b") === "/a");
check("...and never does", pinSessionWorkspaceRoot(null) === "/a");
check(
  "chatStore implements that same first-non-null-wins rule",
  src("modules/ai/store/chatStore.ts").includes(
    "if (promptWorkspaceRoot === null) promptWorkspaceRoot = liveWorkspaceRoot;",
  ),
);

console.log("\n[contract] the streamText consumption `runSubagent` relies on, against a mock");
// The source checks above prove the CODE says streamText; these prove it is
// RIGHT to. Every claim here was read off the SDK internals first, so it is the
// part most worth pinning to a running model rather than to a comment.
{
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "thinking" },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "the summary" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ] as never[],
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }),
  });
  let streamError: unknown;
  const stream = streamText({
    model,
    messages: [{ role: "user", content: "go" }],
    stopWhen: [stepCountIs(60)] as never,
    onError: ({ error }: { error: unknown }) => {
      streamError = error;
    },
  } as never);
  check("awaiting `steps` is what consumes the stream", (await stream.steps).length === 1);
  check("`text` has settled by then", (await stream.text) === "the summary");
  // The summary falls back to reasoning for models that answer there.
  check("so has `reasoningText`", (await stream.reasoningText) === "thinking");
  check("a clean run reports no error", streamError === undefined);
}
{
  // The shape the Codex endpoint actually refused with: blank message, real
  // cause only in the body.
  const boom = Object.assign(new Error(""), {
    statusCode: 400,
    responseBody: JSON.stringify({ detail: "stream must be true" }),
  });
  let streamError: unknown;
  const stream = streamText({
    model: new MockLanguageModelV3({
      doStream: async () => {
        throw boom;
      },
    }),
    messages: [{ role: "user", content: "go" }],
    maxRetries: 0,
    onError: ({ error }: { error: unknown }) => {
      streamError = error;
    },
  } as never);
  let thrown: unknown;
  try {
    await stream.steps;
  } catch (e) {
    thrown = streamError ?? e;
  }
  check("a refusal with zero steps throws (it must not read as success)", thrown !== undefined);
  check("and it is the PROVIDER's error", thrown === boom);
  check(
    "which the SDK alone would have replaced with its NoOutputGeneratedError",
    (thrown as Error).message === "",
  );
  check("...so the caller can still make it readable", describe(thrown) === "stream must be true");
}

console.log("\n[provider options] the endpoint refuses BOTH omissions, not just the stream one");
// Found only by running it: with `stream: true` finally in place, the very next
// request came back 400 `{"detail":"Store must be set to false"}`. The main loop
// sends these via providerRequestOptions; runSubagent never did, so fixing the
// transport alone still left every sub-agent dead on this provider.
{
  const opts = providerRequestOptions("chatgpt", "s-probe", "gpt-5.6-terra");
  check("chatgpt demands store:false", opts.providerOptions?.openai?.store === false);
  check(
    "runSubagent computes the same per-provider options",
    runSubagentSrc.includes("providerRequestOptions("),
  );
  // Both calls: the agent run AND the tool-free recovery summarizer. Missing it
  // on the second turns "the model went quiet" into "the run failed".
  check(
    "and spreads them into BOTH model calls",
    (runSubagentSrc.match(/\.\.\.requestOptions,/g) ?? []).length === 2,
  );
  // A sub-agent's effort comes from its own def, not the chat picker, so no
  // reasoning choice is threaded through.
  check(
    "openai still gets its prompt-cache key",
    providerRequestOptions("openai", "s-probe").providerOptions?.openai?.promptCacheKey ===
      "s-probe",
  );
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
