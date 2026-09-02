/**
 * Self-check AND measurement for the fixed per-request token cost.
 * Run: `npx tsx scripts/ai/tool-budget-verify.ts`.
 *
 * WHY THIS EXISTS. The tool definitions are the single largest fixed cost of a
 * turn - larger than the system prompt, TEDI.md and the conversation put
 * together on an early turn - and they are re-sent on EVERY step, up to
 * `MAX_AGENT_STEPS` times. Nothing measured that, so it could only ever grow: a
 * tool added with a chatty description, or a `z.number().int()` with no bounds,
 * costs real money on every request of every session and shows up nowhere.
 *
 * This prints the real numbers (the same JSON Schema the AI SDK serializes, via
 * the same `zodSchema()` path) and fails on the invariants that keep them from
 * silently regressing.
 */
import { z } from "zod";
import type { ToolSet } from "ai";
import {
  activeToolNames,
  BROWSER_PANE_TOOL_NAMES,
  builtinGroup,
} from "../../src/modules/ai/tools/catalog";
import {
  buildCorePrompt,
  ORCHESTRATION_PROMPT_BODY,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
} from "../../src/modules/ai/config";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/** Roughly what a provider bills for a character of JSON. Only used for the
 *  printed report, never for an assertion. */
const CHARS_PER_TOKEN = 3.7;
const tok = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// The tool set, built for real.
//
// `tools/tools.ts` pulls in the Tauri and DOM surface through its builders, so
// the ToolContext is a stub of exactly the shape they read at BUILD time. None
// of the `execute` bodies run here - only the descriptions and schemas, which is
// all this measures.
// ---------------------------------------------------------------------------
const ctx = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === "then") return undefined; // never look like a thenable
      return () => undefined;
    },
  },
) as never;

// The builders are imported one by one rather than through `tools.ts`, which
// also pulls the extension and MCP paths - and `subagent.ts` reaches
// `runSubagent` and, through it, xterm, which has no ESM named exports outside
// the bundler. Eight of the nine builders is every tool whose cost this check
// governs; the sub-agent pair is measured by `subagent-*` checks instead, and
// the totals below say so.
const [fsT, editT, fetchT, searchT, shellT, terminalT, todoT, scheduleT] = await Promise.all([
  import("../../src/modules/ai/tools/fs"),
  import("../../src/modules/ai/tools/edit"),
  import("../../src/modules/ai/tools/fetch"),
  import("../../src/modules/ai/tools/search"),
  import("../../src/modules/ai/tools/shell"),
  import("../../src/modules/ai/tools/terminal"),
  import("../../src/modules/ai/tools/todo"),
  import("../../src/modules/ai/tools/schedule"),
]);
const tools = {
  ...fsT.buildFsTools(ctx),
  ...editT.buildEditTools(ctx),
  ...fetchT.buildFetchTools(),
  ...searchT.buildSearchTools(ctx),
  ...shellT.buildShellTools(ctx),
  ...terminalT.buildTerminalTools(ctx),
  ...todoT.buildTodoTools(ctx),
  ...scheduleT.buildScheduleTools(ctx),
} as unknown as ToolSet;
const names = Object.keys(tools);

/**
 * The JSON Schema the SDK serializes for one tool.
 *
 * Same options `@ai-sdk/provider-utils` `zodSchema()` passes, so the byte count
 * matches the wire within the `additionalProperties` key it adds afterwards.
 * Reproduced rather than imported because provider-utils is a transitive
 * dependency: importing it here would make this check depend on a package the
 * repo never declared.
 */
function toWireSchema(schema: unknown): string {
  return JSON.stringify(
    z.toJSONSchema(schema as never, { target: "draft-7", io: "input", reused: "inline" }),
  );
}

/** The wire payload for one tool: what `prepareToolsAndToolChoice` sends. */
function wireBytes(name: string): { desc: number; schema: number } {
  const t = tools[name] as { description?: string; inputSchema?: unknown };
  const desc = (t.description ?? "").length;
  let schema = 0;
  try {
    schema = toWireSchema(t.inputSchema).length;
  } catch {
    schema = 0;
  }
  return { desc, schema };
}

const rows = names.map((n) => {
  const { desc, schema } = wireBytes(n);
  return { name: n, group: builtinGroup(n), desc, schema, total: n.length + desc + schema };
});
const totalChars = rows.reduce((a, r) => a + r.total, 0);

console.log("[report] built-in tool surface, as serialized to the provider");
console.log(`  tools: ${rows.length} (sub-agent tools excluded - see above)`);
console.log(`  description chars: ${rows.reduce((a, r) => a + r.desc, 0)}`);
console.log(`  JSON Schema chars: ${rows.reduce((a, r) => a + r.schema, 0)}`);
console.log(`  TOTAL: ${totalChars} chars ~ ${tok(totalChars)} tokens, every step of every turn`);

const byGroup = new Map<string, number>();
for (const r of rows) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + r.total);
console.log("  by group:");
for (const [g, c] of [...byGroup].sort((a, b) => b[1] - a[1])) {
  console.log(
    `    ${g.padEnd(12)} ${String(c).padStart(6)} chars  ${((c / totalChars) * 100).toFixed(1)}%`,
  );
}

const full = buildCorePrompt("full", () => true);
console.log("[report] system prompt");
console.log(`  core full: ${SYSTEM_PROMPT.length} chars ~ ${tok(SYSTEM_PROMPT.length)} tokens`);
console.log(
  `  core lite: ${SYSTEM_PROMPT_LITE.length} chars ~ ${tok(SYSTEM_PROMPT_LITE.length)} tokens`,
);
console.log(
  `  + orchestration: ${full.length + ORCHESTRATION_PROMPT_BODY.length} chars ~ ${tok(full.length + ORCHESTRATION_PROMPT_BODY.length)} tokens`,
);

// ---------------------------------------------------------------------------
// Invariants.
// ---------------------------------------------------------------------------
console.log("[lazy browser tools] a pane-bound tool is not sent while no pane is open");

const noPane = activeToolNames(names, false);
check("with no browser pane, the set is narrowed", noPane !== undefined);
check("with a browser pane, nothing is filtered", activeToolNames(names, true) === undefined);
for (const n of BROWSER_PANE_TOOL_NAMES) {
  check(`${n} is a real tool`, names.includes(n));
  check(`${n} is dropped with no pane`, !(noPane ?? []).includes(n));
}
check(
  "open_browser survives - it is how a pane comes to exist",
  (noPane ?? []).includes("open_browser"),
);

const savedChars = rows
  .filter((r) => (BROWSER_PANE_TOOL_NAMES as readonly string[]).includes(r.name))
  .reduce((a, r) => a + r.total, 0);
console.log(
  `  saved while no browser is open: ${savedChars} chars ~ ${tok(savedChars)} tokens/request (${((savedChars / totalChars) * 100).toFixed(1)}% of the tool surface)`,
);
check(
  "the saving is worth the mechanism (>15% of the tool surface)",
  savedChars / totalChars > 0.15,
  {
    savedChars,
    totalChars,
  },
);

console.log("[schema hygiene] no unbounded-integer boilerplate in the payload");
// zod renders a bare `.int()` as the full safe-integer range: 55 characters of
// noise per field that also tells the model nothing. A realistic bound is
// shorter AND constrains better. It must stay UNREACHABLE though - a rejected
// value comes back as a tool-error the model spends a step correcting.
// `bash_logs.since_offset` is the honest exception: a cumulative u64 from the
// shell ring buffer, where any max would eventually refuse a real call.
const SAFE_INT_NOISE = '"maximum":9007199254740991';
const UNBOUNDED_BY_DESIGN = new Set(["bash_logs"]);
const offenders = rows
  .filter((r) => !UNBOUNDED_BY_DESIGN.has(r.name))
  .filter((r) =>
    toWireSchema((tools[r.name] as { inputSchema: unknown }).inputSchema).includes(SAFE_INT_NOISE),
  )
  .map((r) => r.name);
check("no tool emits the safe-integer range", offenders.length === 0, offenders);

console.log("[prompt] no rule is stated twice in the full core prompt");
const EMDASH = "Never use em dash punctuation";
const emdashCount = SYSTEM_PROMPT.split(EMDASH).length - 1;
check("the em-dash rule appears exactly once", emdashCount === 1, { emdashCount });

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
