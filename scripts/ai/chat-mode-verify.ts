/**
 * Self-check for chat mode's history strip (`stripToolTraffic`).
 * Run: `npx tsx scripts/ai/chat-mode-verify.ts`.
 *
 * Chat mode declares NO tools. If a mid-session toggle leaves tool calls or
 * results in the history, Anthropic rejects the whole request ("tool_use
 * without tools") and other providers get unpaired orphans. The strip must:
 *   - remove every tool message, tool-call, tool-result, and approval part,
 *   - keep all user/assistant TEXT and its order,
 *   - never emit an assistant message with an empty content array,
 *   - be idempotent (a second pass changes nothing).
 */
import type { ModelMessage } from "ai";
import { stripToolTraffic } from "../../src/modules/ai/lib/compact";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

// A realistic turn: user asks, agent calls a tool, tool answers, agent replies.
const history: ModelMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "read config.ts" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading it." },
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "config.ts" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read_file",
        output: { type: "text", value: "export const X = 1;" },
      },
    ],
  },
  // Tool-call-only step: nothing left after the strip, must vanish entirely.
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c2", toolName: "grep", input: { pattern: "X" } }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c2",
        toolName: "grep",
        output: { type: "text", value: "1 hit" },
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "X is 1." }] },
  { role: "user", content: "hi" },
];

const out = stripToolTraffic(history);

const json = JSON.stringify(out);
check("no tool messages survive", !out.some((m) => m.role === "tool"));
check("no tool-call parts survive", !json.includes('"tool-call"'));
check("no tool-result parts survive", !json.includes('"tool-result"'));
check("no tool-approval parts survive", !json.includes('"tool-approval-request"'));
check(
  "no empty assistant content",
  !out.some((m) => Array.isArray(m.content) && m.content.length === 0),
  out,
);
check("tool-call-only assistant step dropped whole", out.length === 5, out.length);
check(
  "text is kept, in order",
  JSON.stringify(out.map((m) => m.role)) ===
    JSON.stringify(["system", "user", "assistant", "assistant", "user"]),
  out.map((m) => m.role),
);
check("string content passes through", out[4].content === "hi");
check("idempotent", JSON.stringify(stripToolTraffic(out)) === json);

// A tool-free conversation must come back byte-identical (chat mode's own
// history), or every plain turn would be needlessly rewritten.
const plain: ModelMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "Hello." }] },
];
check(
  "tool-free history unchanged",
  JSON.stringify(stripToolTraffic(plain)) === JSON.stringify(plain),
);

// Reasoning parts are not tool traffic; a reasoning-only step must survive.
const reasoning: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "tool-call", toolCallId: "c3", toolName: "grep", input: {} },
    ],
  },
];
const kept = stripToolTraffic(reasoning);
check(
  "reasoning-only step survives the strip",
  kept.length === 1 && Array.isArray(kept[0].content) && kept[0].content.length === 1,
  kept,
);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
