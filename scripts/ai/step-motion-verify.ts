/**
 * Self-check for the running block's per-step gait (src/modules/ai/lib/stepMotion.ts).
 * Run: `npx tsx scripts/ai/step-motion-verify.ts`.
 *
 * The block beside the clock animates differently depending on what the turn is
 * doing, and the link between the two is a STRING: `stepMotion` reads the verb
 * off the step label that `TOOL_LABELS` produced. Nothing typed connects them,
 * so adding a tool whose label opens with a new verb - or renaming "Editing" to
 * "Patching" - silently drops that tool back to the generic sweep and no test
 * anywhere else notices.
 *
 * So the first check reads `agent.ts` as TEXT and pulls the leading word out of
 * every label it returns, then requires each one to be an explicit key in the
 * table. `agent.ts` itself is never imported: it pulls the AI SDK, the tool
 * registry and the Tauri bridge, none of which run outside the app.
 */
import { readFileSync } from "node:fs";
import { stepMotion, STEP_MOTIONS } from "../../src/modules/ai/lib/stepMotion";
// Data only, zero imports - safe to pull in outside the app. This is the same
// table both MCP transports serve, so it is the authoritative list of what
// TEDI's own agent can call on itself.
import { TOOL_DEFS } from "../mcp/tools.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const src = readFileSync(new URL("../../src/modules/ai/lib/agent.ts", import.meta.url), "utf8");
const start = src.indexOf("export const TOOL_LABELS");
const end = src.indexOf("\n};", start);
if (start === -1 || end === -1) {
  throw new Error("TOOL_LABELS not found in agent.ts - this check is reading the wrong shape");
}
// Every template literal in the block that opens with a word: that word is the
// verb the step line starts with, which is the only thing `stepMotion` sees.
// Anchored to the backtick so an interpolated path in the middle of a label
// ("Moving a → b") is not mistaken for one.
const verbs = [...src.slice(start, end).matchAll(/`([A-Z][A-Za-z]*)/g)].map((m) => m[1]!);

console.log(`[coverage] every verb TOOL_LABELS writes has a gait (${verbs.length} labels)`);
const missing = [...new Set(verbs)].filter((v) => !(v in STEP_MOTIONS)).sort();
check("no TOOL_LABELS verb falls through to the default sweep", missing.length === 0, missing);
// A sanity floor on the extraction above: if the regex stops matching, `missing`
// is trivially empty and the check passes while checking nothing.
check("the labels were actually read", new Set(verbs).size >= 12, [...new Set(verbs)].sort());

console.log("\n[mcp] every tool TEDI's own agent can call on TEDI is labelled");
// The in-process MCP server serves every name in TOOL_DEFS that has a handler,
// so an unlabelled one reaches the step line as "Calling mcp__tedi__eval_js"
// and the block falls back to the generic gait. Six of the twenty were in that
// state; this is what stops the next one from being.
const unlabelled = Object.keys(TOOL_DEFS)
  .filter((n) => !src.includes(`mcp__tedi__${n}:`))
  .sort();
check(
  `all ${Object.keys(TOOL_DEFS).length} tedi MCP tools have a step label`,
  unlabelled.length === 0,
  unlabelled,
);

console.log("\n[mapping] a label reads as the act it describes, not as its tool");
const cases: Array<[string | null, string]> = [
  ["Reading tools.ts", "read"],
  ["Reading the window", "read"],
  ["Reading logs", "read"],
  ["Grepping useEffect", "search"],
  ["Globbing **/*.rs", "search"],
  ["Listing src", "search"],
  ["Editing agent.ts", "edit"],
  ["Replacing foo across files", "edit"],
  ["Moving a.ts → b.ts", "edit"],
  ["Writing agent.ts", "write"],
  ["Creating src/lib", "write"],
  ["Deleting old.ts", "delete"],
  ["Stopping background process", "delete"],
  ["Fetching https://example.com", "net"],
  ["Running pnpm verify", "run"],
  ["Spawning 3 subagents in parallel", "spawn"],
  ["Pane split", "spawn"],
  ["Updating plan (4 items)", "plan"],
  // The tedi MCP surface: driving the window is typing, capturing it is
  // reading, `ssh` is the network and `eval_js` is a command running.
  ["Inspecting extensions", "search"],
  ["Typing pnpm verify", "edit"],
  ["Pressing Ctrl+Shift+P", "edit"],
  ["Clicking [aria-label='Split right']", "edit"],
  ["Dragging .pane-handle", "edit"],
  ["Setting ai.reasoningEffort", "edit"],
  ["Saving the editor", "write"],
  ["Opening src/main.tsx", "spawn"],
  ["Extension reload tedi.sql-explorer", "spawn"],
  ["Asking TEDI to run", "spawn"],
  ["Capturing the window", "read"],
  ["SSH open", "net"],
  ["Evaluating window.__TEDI__", "run"],
  ['Waiting for "done"', "wait"],
  ["Retrying in 4s", "wait"],
  ["Context full - compacting and retrying", "wait"],
  // The two `describeStep` writes with no tool behind them.
  ["Thinking", "think"],
  ["Writing", "write"],
  // Idle, and the shapes a null step can arrive as.
  [null, "think"],
  ["", "think"],
  ["   ", "think"],
];
for (const [label, want] of cases) {
  const got = stepMotion(label);
  check(`${JSON.stringify(label)} -> ${want}`, got === want, { got });
}

console.log("\n[unlabelled] a third-party MCP or extension tool, read off its own name");
// The two shapes that must both work: `verb_noun`, where reading right to left
// would call `create_pull_request` a network call, and `namespace_verb`, where
// the leading token is an extension's own name. And `mcp__run__get_status`,
// which is why the server prefix is cut before anything is matched.
const byName: Array<[string, string]> = [
  ["Calling mcp__github__list_issues", "search"],
  ["Calling mcp__github__create_pull_request", "write"],
  ["Calling mcp__filesystem__read_file", "read"],
  ["Calling mcp__run__get_status", "read"],
  ["Calling mcp__linear__update_issue", "edit"],
  ["Calling mcp__playwright__browser_click", "edit"],
  // Extension tools, which namespace themselves rather than the server.
  ["Calling sql_query", "search"],
  ["Calling devenv_service_start", "spawn"],
  ["Calling api_client_send", "net"],
  ["Calling beautify_format", "edit"],
  // camelCase names split on the hump.
  ["Calling listIssues", "search"],
  ["Calling deleteBranch", "delete"],
  // Nothing recognisable: back to the generic sweep, which is where all of
  // these were before.
  ["Calling frobnicate", "think"],
  ["Calling mcp__weird__zzz", "think"],
];
for (const [label, want] of byName) {
  const got = stepMotion(label);
  check(`${JSON.stringify(label)} -> ${want}`, got === want, { got });
}

console.log("\n[variety] the gaits are actually distinct, or none of this shows");
const used = new Set(Object.values(STEP_MOTIONS));
check("the table spends at least 8 of the 11 gaits", used.size >= 8, [...used].sort());

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
