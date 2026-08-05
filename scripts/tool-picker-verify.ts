/**
 * Self-check for the tool picker's grouping and filtering.
 * Run: `npx tsx scripts/tool-picker-verify.ts`.
 *
 * Two things must hold:
 *  1. Grouping is derived from the tool NAME, so a tool added later still lands
 *     somewhere sensible with nobody registering it. The rules are ordered, and
 *     the order is the part that breaks silently: `read_browser_console` must
 *     read as Browser, not Terminal, and `run_in_terminal` the other way round.
 *     The expected names below are the real tool set (taken from a live request
 *     capture), so a rename that quietly reshuffles a group fails here.
 *  2. Unticking every tool must yield `undefined`, not `{}`: some endpoints
 *     reject an empty tools array, and "no tools" belongs in the request as an
 *     omitted field.
 */
import type { ToolSet } from "ai";
import {
  applyToolFilter,
  builtinGroup,
  describeTools,
  groupTools,
  mcpGroup,
  SUBAGENT_TOOL_NAMES,
  subagentsAvailable,
  withSubagentsDisabled,
} from "../src/modules/ai/tools/catalog";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

console.log("[grouping] real built-in tool names land in the right group");

const EXPECTED: Record<string, string[]> = {
  Browser: [
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
  ],
  Terminal: [
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
  ],
  Shell: ["bash_run", "bash_background", "bash_logs", "bash_kill", "bash_list"],
  Files: [
    "read_file",
    "list_directory",
    "create_directory",
    "delete_file",
    "move_file",
    "copy_file",
  ],
  Edit: ["edit", "multi_edit", "write_file", "replace_in_files"],
  Search: ["grep", "glob"],
  Web: ["fetch"],
  "Sub-agents": ["run_subagent", "run_subagents"],
  Skills: ["skill"],
  Tasks: ["todo_write"],
  Schedule: ["schedule_command", "cancel_schedule", "list_schedules"],
};

for (const [group, names] of Object.entries(EXPECTED)) {
  const wrong = names.filter((n) => builtinGroup(n) !== group);
  check(`${group} (${names.length} tools)`, wrong.length === 0, {
    wrong: wrong.map((n) => ({ name: n, got: builtinGroup(n) })),
  });
}

console.log("\n[grouping] the ordered rules that break silently");
check(
  "read_browser_console is Browser, not Terminal",
  builtinGroup("read_browser_console") === "Browser",
);
check("run_in_terminal is Terminal, not Browser", builtinGroup("run_in_terminal") === "Terminal");
check("an unknown tool falls back to Files", builtinGroup("some_new_tool") === "Files");

console.log("\n[grouping] MCP tools group per server");
check(
  "mcp__chrome-devtools-mcp__click -> MCP: chrome-devtools-mcp",
  mcpGroup("mcp__chrome-devtools-mcp__click") === "MCP: chrome-devtools-mcp",
);
check("a built-in name is not an MCP tool", mcpGroup("read_file") === null);
check("a malformed mcp key still groups", mcpGroup("mcp__weird") === "MCP");

console.log("\n[describe] sources are labelled, not guessed");
const tools: ToolSet = {
  read_file: { description: "read" } as never,
  mcp__srv__do: { description: "mcp" } as never,
  my_ext_tool: { description: "ext" } as never,
};
const rows = describeTools(tools, new Set(["my_ext_tool"]));
const groupOf = (n: string) => rows.find((r) => r.name === n)?.group;
check("built-in labelled by name", groupOf("read_file") === "Files");
check("MCP labelled by prefix", groupOf("mcp__srv__do") === "MCP: srv");
check("extension labelled from the caller's set", groupOf("my_ext_tool") === "Extensions");
check(
  "descriptions are carried through",
  rows.every((r) => r.description.length > 0),
);

console.log("\n[order] groups come out in a stable, sensible order");
const ordered = groupTools(
  describeTools({
    browser_click: { description: "" } as never,
    read_file: { description: "" } as never,
    mcp__srv__do: { description: "" } as never,
    bash_run: { description: "" } as never,
  } as ToolSet),
).map((g) => g.group);
check(
  "Files before Shell before Browser, MCP last",
  JSON.stringify(ordered) === JSON.stringify(["Files", "Shell", "Browser", "MCP: srv"]),
  ordered,
);

console.log("\n[filter] what is unticked must not reach the model");
const full: ToolSet = {
  a: { description: "" } as never,
  b: { description: "" } as never,
};
check("no off-list returns the set untouched", applyToolFilter(full, new Set()) === full);
const oneOff = applyToolFilter(full, new Set(["a"]));
check("an off tool is dropped", oneOff !== undefined && !("a" in oneOff) && "b" in oneOff, oneOff);
check(
  "EVERYTHING off yields undefined, not an empty object",
  applyToolFilter(full, new Set(["a", "b"])) === undefined,
);
check(
  "chat mode (no tools at all) stays undefined",
  applyToolFilter(undefined, new Set(["a"])) === undefined,
);
check(
  "an off-list naming a tool that no longer exists is harmless",
  JSON.stringify(applyToolFilter(full, new Set(["gone"]))) === JSON.stringify(full),
);

// The `subagentsEnabled` preference is gone; the picker is the only switch. The
// risk in that swap is a HALF disable: the tool stops being sent but the
// orchestration prompt still tells the model to call it, which burns tokens on a
// guaranteed failure. Both must move together, off the same source of truth.
console.log("\n[sub-agents] the picker is the only switch, and it moves both halves");
const SPAWN: ToolSet = {
  run_subagent: { description: "" } as never,
  run_subagents: { description: "" } as never,
  grep: { description: "" } as never,
};
check(
  "both spawn tools are named in one shared list",
  [...SUBAGENT_TOOL_NAMES].sort().join(",") === "run_subagent,run_subagents",
  SUBAGENT_TOOL_NAMES,
);
check("nothing off -> sub-agents available", subagentsAvailable(new Set()));
check(
  "spawn tool off -> orchestration prompt is dropped too",
  !subagentsAvailable(new Set(["run_subagents"])),
);
const spawnOff = applyToolFilter(SPAWN, new Set(SUBAGENT_TOOL_NAMES));
check(
  "and the tools really leave the request, not just the UI",
  spawnOff !== undefined && !("run_subagent" in spawnOff) && !("run_subagents" in spawnOff),
  spawnOff,
);
check("while unrelated tools survive", spawnOff !== undefined && "grep" in spawnOff);
check(
  "disabling only the single-spawn tool keeps delegation on",
  subagentsAvailable(new Set(["run_subagent"])),
);
check(
  "both spawn tools group under Sub-agents in the picker",
  SUBAGENT_TOOL_NAMES.every((n) => builtinGroup(n) === "Sub-agents"),
);

// Dropping the old preference must not silently switch sub-agents back ON for
// someone who had deliberately turned them off, so an existing `false` moves
// into the off-list on first load.
console.log("\n[migration] a legacy `subagentsEnabled: false` becomes an off-list");
const migrated = withSubagentsDisabled([]);
check(
  "an empty off-list gains both spawn tools",
  migrated.join(",") === "run_subagent,run_subagents",
  migrated,
);
check(
  "existing choices are kept, not replaced",
  withSubagentsDisabled(["fetch"]).join(",") === "fetch,run_subagent,run_subagents",
);
check(
  "idempotent: running it twice adds nothing",
  withSubagentsDisabled(migrated).join(",") === migrated.join(","),
);
check("and the result really disables them", !subagentsAvailable(new Set(migrated)));

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
