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

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/** The real built-in tool set, same source as `scripts/ai/tool-picker-verify.ts`
 *  (a live request capture). */
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
  "open_terminal",
  "close_terminal",
  "list_terminals",
  "read_terminal",
  "send_to_terminal",
  "run_in_terminal",
  "run_in_terminal_by_id",
  "suggest_command",
  "consolidate_terminals",
  "group_tabs",
  "rotate_pane",
  "open_browser",
  "control_browser",
  "read_browser",
  "read_browser_console",
  "navigate_and_read",
  "browser_click",
  "browser_click_at",
  "browser_type",
  "browser_scroll",
  "browser_hover",
  "browser_press_key",
  "browser_screenshot",
  "run_subagent",
  "run_subagents",
  "skill",
  "todo_write",
  "schedule_command",
  "cancel_schedule",
  "list_schedules",
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
const mentionOf = (t: string): RegExp => MENTION[t] ?? new RegExp("`" + t + "`");

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
for (const heading of ["# Environment", "# Files", "# Browser", "# Delegation and output"]) {
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
const noBrowser = new Set(
  REAL_TOOLS.filter((t) => !t.includes("browser") && t !== "navigate_and_read"),
);
const p = buildCorePrompt("full", (t) => noBrowser.has(t));
check(
  "no browser tool is named",
  named(p).every((t) => noBrowser.has(t)),
  { named: named(p) },
);
check("the `# Browser` heading went with them", !p.includes("# Browser"));
check("`read_file` survived", /`read_file`/.test(p));
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
