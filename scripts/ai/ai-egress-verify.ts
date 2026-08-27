/**
 * Self-check for the three ai-native guards that fail silently.
 * Run: `npx tsx scripts/ai/ai-egress-verify.ts`.
 *
 *  1. NETWORK EGRESS. The read side is gated (out-of-scope reads ask, secrets
 *     are denied, symlinks resolved), but `fetch` / `open_browser` /
 *     `navigate_and_read` used to auto-execute against any host with a
 *     model-chosen URL. That is the whole prompt-injection exfiltration path:
 *     anything the agent reads can tell it to put the context in a URL. First
 *     contact with a host must ask; loopback (the dev server) must not.
 *
 *  2. STAGE-3 COMPACTION. Whatever it drops, the result must still be a legal
 *     request: an assistant head is a 400 on Anthropic, and a kept tool-result
 *     whose tool-call was dropped is rejected everywhere. Both fail the WHOLE
 *     turn, and both fire exactly when the window is nearly full. It must also
 *     still drop - refusing to cut is not a fix, it is the over-budget error.
 *
 *  3. <env> REPLAY. Replaying every past env block buys a byte-stable prefix on
 *     a caching provider and buys nothing anywhere else, where it is pure spend.
 */
import type { ModelMessage } from "ai";
import type { UIMessage } from "@ai-sdk/react";
import {
  isTrustedEgressHost,
  resetTrustedEgressHosts,
  trustEgressHost,
} from "../../src/modules/ai/lib/security";
import { compactModelMessagesDetailed } from "../../src/modules/ai/lib/compact";
import { injectContext, type LiveSnapshot } from "../../src/modules/ai/lib/envContext";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

console.log("[egress] a model-chosen URL is a write channel off the machine");
resetTrustedEgressHosts();
check("an unknown host is NOT trusted", !isTrustedEgressHost("https://evil.example/?d=secret"));
check("localhost is pre-trusted", isTrustedEgressHost("http://localhost:5173/"));
check("127.0.0.1 is pre-trusted", isTrustedEgressHost("http://127.0.0.1:8000/api"));
check("a .test dev domain is pre-trusted", isTrustedEgressHost("http://siaska.test/login"));
check("a .localhost dev domain is pre-trusted", isTrustedEgressHost("http://app.localhost/"));
check(
  "an unparseable URL does not raise a card (the tool refuses it itself)",
  isTrustedEgressHost("not a url"),
);

console.log("\n[egress] approving once is remembered for the session");
trustEgressHost("https://api.github.com/repos/x/y");
check("that host is now trusted", isTrustedEgressHost("https://api.github.com/other/path"));
check("a different path on it is trusted too", isTrustedEgressHost("https://api.github.com/"));
check("a LOOK-ALIKE host is still not", !isTrustedEgressHost("https://api.github.com.evil.co/"));
check("an unrelated host is still not", !isTrustedEgressHost("https://evil.example/"));
check("the scheme does not matter", isTrustedEgressHost("http://api.github.com/"));
resetTrustedEgressHosts();
check("reset really clears it", !isTrustedEgressHost("https://api.github.com/"));

console.log("\n[compaction] whatever stage 3 drops, the result stays a legal request");
/** A realistic turn: user, assistant tool-call, tool result, assistant text. */
function turn(i: number, bytes: number): ModelMessage[] {
  const pad = "x".repeat(bytes);
  return [
    { role: "user", content: `q${i} ${pad}` },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `c${i}`,
          toolName: "read_file",
          input: { path: `f${i}.ts` },
        },
      ],
    } as ModelMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${i}`,
          toolName: "read_file",
          output: { type: "text", value: pad },
        },
      ],
    } as ModelMessage,
    { role: "assistant", content: `a${i} ${pad}` },
  ];
}

const history: ModelMessage[] = [{ role: "system", content: "sys" }];
for (let i = 0; i < 40; i++) history.push(...turn(i, 2000));

// A window far smaller than the history, so stage 3 must fire hard.
for (const limit of [4000, 8000, 20_000, 60_000]) {
  const out = compactModelMessagesDetailed(history, limit).messages;
  const afterSystem = out.filter((m) => m.role !== "system");
  const head = afterSystem[0];
  check(
    `limit ${limit}: head after the system prompt is a user message`,
    head === undefined || head.role === "user",
    { head: head?.role, kept: out.length },
  );
  // Every tool-result kept must still have its tool-call somewhere before it.
  const callIds = new Set<string>();
  let orphan: string | null = null;
  for (const m of out) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (part.type === "tool-call" && part.toolCallId) callIds.add(part.toolCallId);
      if (part.type === "tool-result" && part.toolCallId && !callIds.has(part.toolCallId)) {
        orphan = part.toolCallId;
      }
    }
  }
  check(`limit ${limit}: no orphaned tool-result`, orphan === null, { orphan });
  check(`limit ${limit}: the system prompt survived`, out[0]?.role === "system");
}

console.log("\n[compaction] a conversation shorter than the tail is left intact");
const single: ModelMessage[] = [{ role: "system", content: "sys" }, ...turn(0, 200_000)];
const kept = compactModelMessagesDetailed(single, 1000).messages;
check("nothing is dropped when there is no droppable region", kept.length === single.length, {
  before: single.length,
  after: kept.length,
});

console.log("\n[compaction] a runaway assistant stream still gets cut, with an anchor");
// The case that forces stage 3 and has NO later user message to land on. Seeking
// a user boundary would refuse to drop anything here; anchoring drops and stays
// legal. Same shape scripts/ai/compact-step-verify.ts uses as its control.
const runaway: ModelMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "brief" },
];
for (let i = 0; i < 20; i++) runaway.push({ role: "assistant", content: "z".repeat(30_000) });
const cutRunaway = compactModelMessagesDetailed(runaway, 20_000);
check("it really dropped", cutRunaway.stages.dropped > 0, cutRunaway.stages);
const runawayHead = cutRunaway.messages.filter((m) => m.role !== "system")[0];
check("and the head is still a user message", runawayHead?.role === "user", {
  head: runawayHead?.role,
});
check(
  "the anchor says why",
  typeof runawayHead?.content === "string" && runawayHead.content.includes("dropped to fit"),
  runawayHead?.content,
);

console.log("\n[env] past blocks are replayed only where a cache reads them");
const live: LiveSnapshot = {
  cwd: "D:/proj",
  workspaceRoot: "D:/proj",
  activeFile: null,
  terminals: [],
  browsers: [],
};
const uiMessages = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
  { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
] as unknown as UIMessage[];

const sentEnv = new Map<string, string>();
// Turn 1 records u1's block; turn 2 is the one under test.
injectContext(uiMessages.slice(0, 1), live, sentEnv);
const envCount = (out: UIMessage[]): number =>
  out.filter((m) =>
    (m.parts as Array<{ type: string; text?: string }>).some(
      (p) => p.type === "text" && (p.text ?? "").startsWith("<env>"),
    ),
  ).length;

const cached = injectContext(uiMessages, live, sentEnv, true);
check("caching provider: both user messages carry an env block", envCount(cached) === 2, {
  got: envCount(cached),
});
const uncached = injectContext(uiMessages, live, sentEnv, false);
check("cache-less provider: only the newest does", envCount(uncached) === 1, {
  got: envCount(uncached),
});
check(
  "and it is the NEWEST one",
  (uncached[2].parts as Array<{ type: string; text?: string }>)[0].text?.startsWith("<env>") ===
    true,
);
check(
  "the original messages are never mutated",
  (uiMessages[2].parts as Array<{ type: string; text?: string }>)[0].text === "second",
);

console.log(`\n${"=".repeat(60)}\n${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
