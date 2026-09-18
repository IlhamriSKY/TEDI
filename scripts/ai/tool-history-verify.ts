/**
 * Self-check for the history repairs every request goes through.
 * Run: `npx tsx scripts/ai/tool-history-verify.ts`.
 *
 *  1. A tool call with no result (Stop mid-tool, a typed reply instead of an
 *     approval answer) gets a synthetic error result, or every later request in
 *     that chat is a 400 on every provider.
 *  2. A call with an approval RESPONSE is left alone: the SDK executes it from
 *     that response, and a fake result would skip the real run.
 *  3. Media inside a tool result becomes a text note on providers whose SDK
 *     stringifies tool results, instead of megabytes of base64 per step.
 */
import type { ModelMessage } from "ai";
import {
  TEXT_ONLY_TOOL_RESULTS,
  closeDanglingToolCalls,
  historyToolSet,
  settleInterruptedToolParts,
  stripToolResultMedia,
} from "../../src/modules/ai/lib/toolHistory";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

const call = (id: string, name = "bash_run") => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: {},
});
const result = (id: string, name = "bash_run") => ({
  type: "tool-result",
  toolCallId: id,
  toolName: name,
  output: { type: "text", value: "ok" },
});
const M = (m: unknown) => m as ModelMessage;

console.log("[dangling] an unanswered call gets a result, in place");
{
  const history = [
    M({ role: "user", content: "go" }),
    M({ role: "assistant", content: [call("a"), call("b")] }),
    M({ role: "tool", content: [result("a")] }),
    M({ role: "user", content: "actually, stop" }),
  ];
  const out = closeDanglingToolCalls(history);
  const tool = out[2] as {
    role: string;
    content: { toolCallId: string; output: { type: string } }[];
  };
  assert(out.length === 4, "no message added when a tool message already follows");
  assert(tool.content.length === 2, "the missing result joins the existing tool message");
  assert(
    tool.content[1].toolCallId === "b" && tool.content[1].output.type === "error-text",
    "as an error the model can read",
  );

  const noTool = [
    M({ role: "assistant", content: [call("x")] }),
    M({ role: "user", content: "never mind" }),
  ];
  const out2 = closeDanglingToolCalls(noTool);
  assert(out2.length === 3 && out2[1].role === "tool", "a tool message is inserted right after");
  assert(out2[2].role === "user", "before the next user message");
}

console.log("\n[dangling] answered and approved calls are untouched");
{
  const clean = [
    M({ role: "assistant", content: [call("a")] }),
    M({ role: "tool", content: [result("a")] }),
  ];
  assert(
    closeDanglingToolCalls(clean) === clean,
    "a complete history is returned as-is (same ref)",
  );

  const approved = [
    M({
      role: "assistant",
      content: [
        call("w", "write_file"),
        { type: "tool-approval-request", approvalId: "ap1", toolCallId: "w" },
      ],
    }),
    M({
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
    }),
  ];
  assert(
    closeDanglingToolCalls(approved) === approved,
    "a call with an approval response is left for the SDK to execute",
  );

  // Approved, then Stopped mid-run, then the user typed again. The SDK only
  // executes approvals in the FINAL tool message, so this one never runs and
  // must be answered like any other dangling call.
  const stopped = closeDanglingToolCalls([...approved, M({ role: "user", content: "next" })]);
  const toolMsg = stopped[1] as { content: { type: string; output?: { type: string } }[] };
  assert(
    toolMsg.content.some((p) => p.type === "tool-result" && p.output?.type === "error-text"),
    "an approval that is no longer last is repaired, not trusted to run",
  );

  const provider = [
    M({ role: "assistant", content: [{ ...call("p", "web_search"), providerExecuted: true }] }),
  ];
  assert(
    closeDanglingToolCalls(provider) === provider,
    "a provider-executed call is not ours to answer",
  );
  const text = [M({ role: "user", content: "hi" }), M({ role: "assistant", content: "hello" })];
  assert(closeDanglingToolCalls(text) === text, "string content passes through");
}

console.log("\n[media] tool-result media becomes a note on text-only providers");
{
  const img = [
    M({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "r",
          toolName: "read_file",
          output: {
            type: "content",
            value: [
              { type: "text", text: "screenshot.png" },
              { type: "image-data", data: "A".repeat(100_000), mediaType: "image/png" },
            ],
          },
        },
      ],
    }),
  ];
  const out = stripToolResultMedia(img);
  const json = JSON.stringify(out);
  assert(!json.includes("AAAAAAAAAA"), "the base64 is gone");
  assert(json.includes("screenshot.png"), "the text part survives");
  assert(json.includes("image/file omitted"), "and the model is told what happened");
  assert(json.length < 1000, "the request shrank from 100 KB to a line");

  const plain = [M({ role: "tool", content: [result("t")] })];
  assert(stripToolResultMedia(plain) === plain, "text-only results are untouched (same ref)");

  for (const p of [
    "sumopod",
    "deepseek",
    "agentrouter",
    "openai-compatible",
    "lmstudio",
    "groq",
    "xai",
    "cerebras",
  ] as const) {
    assert(TEXT_ONLY_TOOL_RESULTS.has(p), `${p} is treated as text-only`);
  }
  assert(!TEXT_ONLY_TOOL_RESULTS.has("anthropic"), "anthropic keeps real images");
}

console.log("\n[history] past results always go through a toModelOutput");
{
  const known = { read_file: { description: "r" } };
  const ui = [
    { parts: [{ type: "tool-read_file" }, { type: "tool-mcp__gone__screenshot" }] },
    { parts: [{ type: "dynamic-tool", toolName: "ext_old" }, { type: "text" }] },
  ];
  const set = historyToolSet(known, ui) as Record<
    string,
    { toModelOutput?: (o: { output: unknown }) => { value: string } }
  >;
  assert(set.read_file === known.read_file, "a known tool keeps its own definition");
  assert(
    typeof set["mcp__gone__screenshot"]?.toModelOutput === "function",
    "a vanished MCP tool gets a stub",
  );
  assert(typeof set.ext_old?.toModelOutput === "function", "so does a vanished extension tool");
  const shot = set["mcp__gone__screenshot"]!.toModelOutput!({
    output: { content: "shot", media: [{ data: "iVBOR".repeat(20_000), mimeType: "image/png" }] },
  }).value;
  assert(shot.length < 500 && shot.includes("binary omitted"), "and its replay drops the base64");
  assert(
    historyToolSet(known, [{ parts: [{ type: "tool-read_file" }] }]) === known,
    "no stubs needed -> same ref",
  );
}

console.log("\n[stop] a stopped turn's unfinished tool parts are closed, so nothing re-runs them");
{
  const ui = [
    { role: "user", parts: [{ type: "text", text: "run it" }] },
    {
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-bash_run",
          state: "approval-responded",
          approval: { id: "a", approved: true },
        },
        { type: "tool-read_file", state: "output-available", output: "x" },
        { type: "tool-edit", state: "approval-requested", approval: { id: "b" } },
        { type: "dynamic-tool", toolName: "mcp__x__y", state: "input-available" },
        { type: "tool-grep", state: "input-streaming" },
      ],
    },
  ];
  const out = settleInterruptedToolParts(ui);
  const states = (out[1].parts as { type: string; state?: string }[]).map((p) => p.state);
  assert(
    states[1] === "output-error",
    "an approved, running call is closed (the SDK would re-run it)",
  );
  assert(states[2] === "output-available", "a finished call is untouched");
  assert(
    states[3] === "output-error",
    "a pending card is closed (yolo would auto-approve it later)",
  );
  assert(states[4] === "output-error", "a dynamic tool mid-run is closed too");
  const streamed = (out[1].parts as { input?: unknown }[])[5];
  assert(
    streamed.input !== undefined,
    "a part stopped mid-stream gets an input (replayed without one it is a 400)",
  );
  assert(out[0] === ui[0], "earlier messages are untouched");
  const done = [ui[0], { role: "assistant", parts: [{ type: "text", text: "hi" }] }];
  assert(settleInterruptedToolParts(done) === done, "nothing to settle -> same ref");
}

console.log(failed === 0 ? "\nAll tool-history checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
