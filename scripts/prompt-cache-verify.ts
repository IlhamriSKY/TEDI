/**
 * Self-check for the prompt-cache prefix invariant.
 * Run: `npx tsx scripts/prompt-cache-verify.ts`.
 *
 * THE INVARIANT: a message that has already been sent must look byte-identical
 * on every later turn. Every prompt cache keys on an exact byte prefix, explicit
 * (Anthropic cacheControl) or implicit (OpenAI, xAI, DeepSeek, Gemini, gateways),
 * so the first message that differs from last turn ends the cache read there.
 *
 * The bug this guards: `<env>` used to be injected into the NEWEST user message
 * only, while the chat store persists that message WITHOUT it. Next turn the
 * same message came back shorter than when it was sent, the prefix diverged at
 * the previous user turn, and the divergence point crawled forward with the
 * conversation - so nothing past the system prompt could ever be re-read.
 * `oldInject` below reproduces it, and this file asserts the new behaviour fixes
 * it rather than merely asserting the new behaviour is self-consistent.
 */
import type { UIMessage } from "@ai-sdk/react";
import {
  formatEnvBlock,
  injectContext,
  type LiveSnapshot,
  type SentEnvBlocks,
} from "../src/modules/ai/lib/envContext";
import { noteProviderCacheRead, providerHasPromptCache } from "../src/modules/ai/lib/cache";
import { compactStepMessages } from "../src/modules/ai/lib/compact";
import type { ModelMessage } from "ai";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage;

/** Two turns in the same session, with the live state moving between them (the
 *  user switched terminal), which is exactly when the env block changes. */
const live1: LiveSnapshot = {
  cwd: "D:/proj",
  workspaceRoot: "D:/proj",
  activeFile: null,
  terminals: [],
  browsers: [],
};
const live2: LiveSnapshot = { ...live1, cwd: "D:/proj/src", activeFile: "D:/proj/src/a.ts" };

// The old behaviour, for contrast: env on the newest user message only.
function oldInject(messages: UIMessage[], live: LiveSnapshot): UIMessage[] {
  const block = formatEnvBlock(live);
  if (!block) return messages;
  let lastUserIdx = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUserIdx = i;
  });
  return messages.map((m, i) =>
    i === lastUserIdx
      ? ({ ...m, parts: [{ type: "text", text: block }, ...m.parts] } as UIMessage)
      : m,
  );
}

console.log("[invariant] a sent message must not change on a later turn");

const turn1In = [user("u1", "first")];
const turn2In = [user("u1", "first"), assistant("a1", "ok"), user("u2", "second")];

const sent: SentEnvBlocks = new Map();
const new1 = injectContext(turn1In, live1, sent);
const new2 = injectContext(turn2In, live2, sent);

check(
  "u1 is byte-identical across turn 1 and turn 2",
  JSON.stringify(new1[0]) === JSON.stringify(new2[0]),
  {
    turn1: new1[0],
    turn2: new2[0],
  },
);
check(
  "u1 kept the env it was SENT with (live1), not the new one",
  JSON.stringify(new2[0]).includes("D:/proj") && !JSON.stringify(new2[0]).includes("a.ts"),
  new2[0],
);
check(
  "the newest message carries the FRESH env",
  JSON.stringify(new2[2]).includes("D:/proj/src") && JSON.stringify(new2[2]).includes("a.ts"),
  new2[2],
);
check("assistant messages are untouched", new2[1] === turn2In[1]);

// The contrast: the old behaviour breaks the same invariant.
const old1 = oldInject(turn1In, live1);
const old2 = oldInject(turn2In, live2);
check(
  "REGRESSION GUARD: the old inject really did break u1 (so this test can fail)",
  JSON.stringify(old1[0]) !== JSON.stringify(old2[0]),
);

console.log("\n[stability] repeat sends and retries must not drift");
// A retry inside the same turn re-runs injectContext with the same snapshot.
const retry2 = injectContext(turn2In, live2, sent);
check(
  "same turn, second call is identical (retry safe)",
  JSON.stringify(retry2) === JSON.stringify(new2),
);

// Turn 3: u2 must now be frozen at the env it was sent with in turn 2.
const live3: LiveSnapshot = { ...live1, cwd: "D:/other" };
const turn3In = [...turn2In, assistant("a2", "ok"), user("u3", "third")];
const new3 = injectContext(turn3In, live3, sent);
check("turn 3: u1 still identical", JSON.stringify(new3[0]) === JSON.stringify(new2[0]));
check("turn 3: u2 still identical", JSON.stringify(new3[2]) === JSON.stringify(new2[2]));
check(
  "turn 3: only the newest message shows the newest cwd",
  JSON.stringify(new3[4]).includes("D:/other") &&
    !JSON.stringify(new3.slice(0, 4)).includes("D:/other"),
);

console.log("\n[bookkeeping] the map must not leak");
check("one entry per user message so far", sent.size === 3, [...sent.keys()]);
// History compaction drops the oldest turn; its id must be forgotten.
injectContext([user("u3", "third")], live3, sent);
check("ids no longer in the conversation are pruned", sent.size === 1, [...sent.keys()]);

console.log("\n[no env] nothing to inject must be a pure pass-through");
const empty: LiveSnapshot = {
  cwd: null,
  workspaceRoot: null,
  activeFile: null,
  terminals: [],
  browsers: [],
};
const noEnvMap: SentEnvBlocks = new Map();
const msgs = [user("x1", "hi")];
check("empty snapshot yields no block", formatEnvBlock(empty) === null);
check(
  "messages pass through unchanged",
  JSON.stringify(injectContext(msgs, empty, noEnvMap)) === JSON.stringify(msgs),
);
check(
  "no user messages at all is a no-op",
  injectContext([assistant("a", "x")], live1, noEnvMap).length === 1,
);

console.log("\n[gateway] a measured cache read must stop the per-step rewrite");
// A pile big enough to trip Stage 1 (superseded-read elision), which rewrites an
// OLD message and therefore invalidates any prefix the gateway had cached.
const pile: ModelMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "read a.ts" },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read_file",
        output: { type: "text", value: "X".repeat(4000) },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "a.ts" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c2",
        toolName: "read_file",
        output: { type: "text", value: "Y".repeat(4000) },
      },
    ],
  },
];
check(
  "openai-compatible starts assumed cache-less",
  providerHasPromptCache("openai-compatible") === false,
);
const rewritten = compactStepMessages(pile, "openai-compatible");
check(
  "assumed cache-less: history IS rewritten (the superseded read is elided)",
  JSON.stringify(rewritten) !== JSON.stringify(pile),
);
noteProviderCacheRead("openai-compatible");
check(
  "a measured cache read flips the verdict",
  providerHasPromptCache("openai-compatible") === true,
);
check(
  "now the prefix is left alone",
  JSON.stringify(compactStepMessages(pile, "openai-compatible")) === JSON.stringify(pile),
);
noteProviderCacheRead("openai-compatible");
check(
  "one-way: a later turn cannot flip it back",
  providerHasPromptCache("openai-compatible") === true,
);
check("unrelated providers are unaffected", providerHasPromptCache("groq") === false);
// Same rule, no special case: this is not an AgentRouter feature.
check("agentrouter starts assumed cache-less too", providerHasPromptCache("agentrouter") === false);
noteProviderCacheRead("agentrouter");
check("agentrouter flips on the same evidence", providerHasPromptCache("agentrouter") === true);
check(
  "tabled providers still true",
  providerHasPromptCache("anthropic") && providerHasPromptCache("openai"),
);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
