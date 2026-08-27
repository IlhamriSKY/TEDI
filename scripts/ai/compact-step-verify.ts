/**
 * Self-check for the between-step compaction guardrails (RESEND_COMPACTION_BUDGET
 * / compactStepMessages / skipHardDrop). Run: `npx tsx scripts/ai/compact-step-verify.ts`.
 *
 * Asserts the invariants the fix-verifier required before per-step compaction is
 * safe to feed into an active AI SDK tool loop:
 *  1. ELIDE-ONLY: message COUNT is unchanged (no message ever hard-dropped).
 *  2. PAIRING: every tool-result's toolCallId still has a matching prior
 *     tool-call - so no provider can reject an orphaned tool_result.
 *  3. skipHardDrop actually disables Stage 3 even when massively over budget.
 *  4. IDEMPOTENT: compacting twice == compacting once (safe to run every step).
 *  5. It still SHRINKS a big pile (the point of the exercise).
 */
import type { ModelMessage } from "ai";
import {
  compactModelMessagesDetailed,
  compactStepMessages,
  RESEND_COMPACTION_BUDGET,
} from "../../src/modules/ai/lib/compact";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

/** Build a realistic explore-subagent history: system + brief, then N rounds of
 *  (assistant read_file tool-call) + (tool result carrying a big file body). */
function buildHistory(n: number, bodyChars: number): ModelMessage[] {
  const msgs: ModelMessage[] = [
    { role: "system", content: "You are Comet, a read-only search specialist." },
    { role: "user", content: "Study the ai-native feature." },
  ];
  for (let i = 0; i < n; i++) {
    const id = `call_${i}`;
    msgs.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: `/src/file${i}.ts` } }],
    } as ModelMessage);
    msgs.push({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value: "x".repeat(bodyChars) } },
      ],
    } as ModelMessage);
  }
  return msgs;
}

/** Every tool-result's toolCallId must have a matching earlier tool-call id. */
function pairingOk(msgs: ModelMessage[]): boolean {
  const callIds = new Set<string>();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (p.type === "tool-call" && p.toolCallId) callIds.add(p.toolCallId);
      if (p.type === "tool-result" && p.toolCallId && !callIds.has(p.toolCallId)) return false;
    }
  }
  return true;
}

const chars = (m: ModelMessage[]) =>
  m.reduce((n, x) => n + (typeof x.content === "string" ? x.content.length : JSON.stringify(x.content).length), 0);

// A pile well over the 80K-token budget: 40 reads x ~8K chars (~2K tok) each ~= 320K chars ~= 80K tok.
const history = buildHistory(40, 8000);
console.log(`budget=${RESEND_COMPACTION_BUDGET} tok; input msgs=${history.length}, ~${Math.round(chars(history) / 4)} tok`);

const out = compactStepMessages(history);

console.log("\n[1] elide-only: message count unchanged");
assert(out.length === history.length, `count ${out.length} === ${history.length}`);

console.log("\n[2] pairing preserved (no orphaned tool_result)");
assert(pairingOk(out), "every tool-result id has a prior tool-call");

console.log("\n[3] skipHardDrop disables Stage 3 even when un-elidable content blows the budget");
// Stage 2 only elides TOOL-RESULT bodies; large assistant TEXT is un-elidable,
// so a text-heavy pile stays over the 85% threshold and forces Stage 3 - the
// case where skipHardDrop actually matters (a read-only pile never gets there
// because Stage 2 alone reclaims it, which is itself the reassuring result).
const textHeavy: ModelMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "brief" },
];
for (let i = 0; i < 20; i++) textHeavy.push({ role: "assistant", content: "z".repeat(30000) }); // ~150K tok
const elideOnly = compactModelMessagesDetailed(textHeavy, RESEND_COMPACTION_BUDGET, { skipHardDrop: true });
const withDrop = compactModelMessagesDetailed(textHeavy, RESEND_COMPACTION_BUDGET); // Stage 3 allowed
assert(elideOnly.stages.dropped === 0, `elide-only dropped=${elideOnly.stages.dropped} (must be 0)`);
assert(elideOnly.messages.length === textHeavy.length, "elide-only kept all messages");
assert(withDrop.stages.dropped > 0, `control: hard-drop path DID drop (${withDrop.stages.dropped})`);

console.log("\n[4] idempotent: compact(compact(x)) == compact(x)");
const once = compactStepMessages(history);
const twice = compactStepMessages(once);
assert(chars(twice) === chars(once), `bytes stable (${chars(once)} == ${chars(twice)})`);

console.log("\n[5] actually shrinks the pile");
assert(chars(out) < chars(history), `shrank ${Math.round(chars(history) / 4)}k -> ${Math.round(chars(out) / 4)}k tok`);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
