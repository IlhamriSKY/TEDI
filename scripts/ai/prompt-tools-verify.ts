/**
 * Self-check for the tool-gated system prompt.
 * Run: `npx tsx scripts/ai/prompt-tools-verify.ts`.
 *
 * The bug this guards: the tool picker switched every tool off except one
 * extension tool, and the system prompt still told the model to use `edit`,
 * `read_file`, `bash_run`, `run_subagents` and 29 MCP tools it had not been
 * given. Instructions for absent tools are billed on every message and are a
 * guaranteed failed call, so the prompt is now composed from the tool set the
 * turn actually sends.
 *
 * Three things must hold:
 *  1. Every `needs` tag names a REAL tool. A rename that nobody re-tagged would
 *     leave that tool's instructions in the prompt forever, silently.
 *  2. A tool that is switched off is not named in the prompt, and a block whose
 *     sections all filtered out leaves no bare `# Browser` heading behind.
 *  3. The MCP block is counted from the surviving tools, so a server whose tools
 *     are all unticked is not advertised as "available in your tool list".
 */
import {
  buildCorePrompt,
  composePrompt,
  PROMPT_TAGGED_TOOLS,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
} from "../../src/modules/ai/config";
import { mcpSummaryFor } from "../../src/modules/ai/tools/catalog";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/**
 * The `mcp__tedi__*` keys TEDI's own agent really receives, read from the
 * handler table in `lib/tediMcpServer.ts`.
 *
 * READ, NOT LISTED, and not taken from `@mcp/tools.mjs` either. That table also
 * holds the stdio-only tools (`keys`, `eval_js`, `drag`, ...) which the built-in
 * agent never gets, so tagging a prompt section with one of those IS an orphan
 * and this check has to keep saying so. The handler table is the only place that
 * knows which half is served in-process.
 */
function tediMcpTools(): string[] {
  const src = readFileSync(
    new URL("../../src/modules/ai/lib/tediMcpServer.ts", import.meta.url),
    "utf8",
  );
  const from = src.indexOf("const HANDLERS");
  const table = src.slice(from, src.indexOf("\n};", from));
  const names = [...table.matchAll(/^ {2}([a-z_]+): async/gm)].map((m) => `mcp__tedi__${m[1]}`);
  if (names.length < 5) {
    throw new Error(
      `Could not read the handler table in tediMcpServer.ts (found ${names.length}). ` +
        "If its shape changed, fix this reader - silently finding none would turn every MCP tag into a false pass.",
    );
  }
  return names;
}

/** The real built-in tool set, same source as `scripts/ai/tool-picker-verify.ts`
 *  (a live request capture), plus the in-process MCP surface above. */
const REAL_TOOLS = [
  "read_file",
  "list_directory",
  "create_directory",
  "delete_file",
  "move_file",
  "copy_file",
  "edit",
  "multi_edit",
  "write_file",
  "replace_in_files",
  "grep",
  "glob",
  "fetch",
  "bash_run",
  "bash_background",
  "bash_logs",
  "bash_kill",
  "bash_list",
  "run_subagent",
  "run_subagents",
  "skill",
  "todo_write",
  "schedule_command",
  "cancel_schedule",
  "list_schedules",
  ...tediMcpTools(),
];

console.log("[tags] every `needs` tag names a real tool");
const orphans = PROMPT_TAGGED_TOOLS.filter((t) => !REAL_TOOLS.includes(t));
check(`${PROMPT_TAGGED_TOOLS.length} tagged names all exist`, orphans.length === 0, { orphans });

/**
 * How a tool shows up in prompt prose. Tool references are backticked, which is
 * what keeps `edit` from matching the phrase "edit this file"; the handful that
 * appear bare or under a different spelling get an explicit pattern.
 */
const MENTION: Record<string, RegExp> = {
  grep: /\bgrep\b/,
  glob: /\bglob\b/,
  list_directory: /\blist_directory\b/,
  fetch: /`Fetch`|Fetch call/,
  bash_background: /`bash_background`|Bash Background/,
};
/** An MCP tool is written in prose by its own name, not by the `mcp__server__`
 *  key the model calls - that prefix is plumbing and belongs nowhere in prose. */
const mentionOf = (t: string): RegExp =>
  MENTION[t] ?? new RegExp("`" + t.replace(/^mcp__[^_]+__/, "") + "`");

/** The tools a prompt still names. */
function named(prompt: string): string[] {
  return REAL_TOOLS.filter((t) => mentionOf(t).test(prompt));
}

console.log("\n[all on] nothing is permanently filtered out");
for (const [label, prompt] of [
  ["full", SYSTEM_PROMPT],
  ["lite", SYSTEM_PROMPT_LITE],
] as const) {
  const on = named(prompt);
  check(`${label}: names the core tools`, on.length >= 10, { named: on.length });
}
for (const heading of ["# Environment", "# Files", "# Terminal and panes", "# Delegation and output"]) {
  check(`full: keeps ${heading}`, SYSTEM_PROMPT.includes(heading));
}

console.log("\n[the reported bug] one extension tool on, all 88 built-ins off");
// The user's actual session: only the `rtk_status` extension tool was ticked.
for (const variant of ["full", "lite"] as const) {
  const prompt = buildCorePrompt(variant, (t) => t === "rtk_status");
  const leaked = named(prompt);
  check(`${variant}: no built-in tool is named`, leaked.length === 0, { leaked });
  check(`${variant}: still says who it is`, prompt.startsWith("You are TEDI"));
}

console.log("\n[partial] switching one group off drops only that group");
// `# Files` is the group to switch off here because all seven of its sections
// are `needs`-gated, so "the heading goes with its tools" is a real assertion
// rather than one a stray ungated line would satisfy anyway. `# Fetch and shell`
// looks like a candidate and is not: `bash_run` is also named by a
// TERMINAL-gated line, so turning shell off leaves the name behind.
const FILE_TOOLS = [
  "read_file",
  "list_directory",
  "delete_file",
  "move_file",
  "copy_file",
  "edit",
  "multi_edit",
  "write_file",
  "replace_in_files",
  "grep",
  "glob",
  "create_directory",
];
const noFiles = new Set(REAL_TOOLS.filter((t) => !FILE_TOOLS.includes(t)));
const p = buildCorePrompt("full", (t) => noFiles.has(t));
check("no file tool is named", named(p).every((t) => noFiles.has(t)), { named: named(p) });
check("the `# Files` heading went with them", !p.includes("# Files"));
check("`mcp__tedi__sh` survived", /`sh`/.test(p));
check("`run_subagents` survived", /`run_subagents`/.test(p));

console.log("\n[headings] a block with no surviving section leaves nothing behind");
const empty = composePrompt(
  [
    { heading: "# Keep", sections: [{ text: "- kept" }] },
    { heading: "# Drop", sections: [{ needs: ["gone"], text: "- dropped" }] },
  ],
  () => false,
);
check("heading and body both gone", empty === "# Keep\n- kept", empty);

console.log("\n[mcp] the server block is derived from the surviving tools");
check("no MCP tool means no block", mcpSummaryFor(["read_file", "edit"]) === "");
const two = mcpSummaryFor([
  "mcp__chrome-devtools-mcp__click",
  "mcp__chrome-devtools-mcp__fill",
  "read_file",
]);
check("names the server that survived", two.includes("**chrome-devtools-mcp**"), two);
check("a non-MCP tool is not attributed to a server", !two.includes("read_file"), two);

// THE regression this block exists to stop. This text is the cached prefix of
// every request in the session. A count made it move whenever a server finished
// listing its tools between two turns - "(1 tool)" -> "(2 tools)" - and that one
// word re-priced the entire prefix as a cache MISS for the rest of the session.
// Same server, different tool count, must produce byte-identical text.
check(
  "tool count does not leak into the prefix, so a late-listing server cannot break the cache",
  mcpSummaryFor(["mcp__srv__one"]) === mcpSummaryFor(["mcp__srv__one", "mcp__srv__two"]),
  { one: mcpSummaryFor(["mcp__srv__one"]), two: mcpSummaryFor(["mcp__srv__one", "mcp__srv__two"]) },
);
check("no digit survives in the block", !/\d/.test(mcpSummaryFor(["mcp__srv__one"])));
const multi = mcpSummaryFor(["mcp__b__x", "mcp__a__y"]);
check(
  "servers are sorted, so the cached prefix is stable",
  multi.indexOf("**a**") < multi.indexOf("**b**"),
  multi,
);

console.log(`\n${"=".repeat(60)}\n${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
