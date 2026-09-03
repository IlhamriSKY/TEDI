/**
 * Self-check for the tool picker's grouping and filtering.
 * Run: `npx tsx scripts/ai/tool-picker-verify.ts`.
 *
 * Two things must hold:
 *  1. Grouping is derived from the tool NAME, so a tool added later still lands
 *     somewhere sensible with nobody registering it. The rules are ordered, and
 *     the order is the part that breaks silently: `schedule_command` must read
 *     as Schedule, not Files, and `bash_list` as Shell rather than matching a
 *     later rule. The expected names below are the real tool set (taken from a
 *     live request capture), so a rename that quietly reshuffles a group fails
 *     here.
 *  2. Unticking every tool must yield `undefined`, not `{}`: some endpoints
 *     reject an empty tools array, and "no tools" belongs in the request as an
 *     omitted field.
 */
import { readFileSync } from "node:fs";
import type { ToolSet } from "ai";
import {
  applyToolFilter,
  builtinGroup,
  describeTools,
  extensionGroup,
  mcpGroup,
  sectionTools,
  SUBAGENT_TOOL_NAMES,
  subagentsAvailable,
  withSubagentsDisabled,
} from "../../src/modules/ai/tools/catalog";

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

// NO Terminal group. Panes and terminals are served by TEDI's own in-process
// MCP server, so they group under `MCP: tedi` (checked below) and
// `builtinGroup` never sees them.
const EXPECTED: Record<string, string[]> = {
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
check("an unknown tool falls back to Files", builtinGroup("some_new_tool") === "Files");
// `describeTools` asks `mcpGroup` FIRST, so a tool whose name would otherwise
// match a built-in rule is grouped by the server that serves it, not by its
// spelling. Reversing that order would silently regroup half the surface.
check(
  "an MCP tool is grouped by its server even when its name looks built-in",
  mcpGroup("mcp__tedi__read") === "tedi",
);

console.log("\n[grouping] MCP tools group per server");
check(
  "mcp__chrome-devtools-mcp__click -> chrome-devtools-mcp",
  mcpGroup("mcp__chrome-devtools-mcp__click") === "chrome-devtools-mcp",
);
check("a built-in name is not an MCP tool", mcpGroup("read_file") === null);
check("a malformed mcp key still groups", mcpGroup("mcp__weird") === "(unnamed)");

// TEDI's own control surface is an in-process MCP server (ai/lib/tediMcpServer.ts),
// so it groups like any other server rather than as a bespoke "TEDI" category.
// Re-adding a `tedi_*` built-in would split it across two groups again.
check("tedi control tools group as an MCP server", mcpGroup("mcp__tedi__inspect") === "tedi");
check(
  "no built-in claims a TEDI group",
  ["tedi_settings", "tedi_command", "tedi_extensions", "tedi_ssh"].every(
    (n) => builtinGroup(n) !== "TEDI",
  ),
);

console.log("\n[grouping] each extension is its own group, not one 'Extensions' bucket");
// THE regression this replaces. API Client's eleven tools, SQL Explorer's six
// and RTK Bridge's one shared a single row: one checkbox, one count, three
// unrelated capabilities that could only be taken or left together, while every
// MCP server got a row of its own.
check("the vendor prefix is dropped", extensionGroup("tedi.sql-explorer") === "sql-explorer");
check("a third-party id is left alone", extensionGroup("acme.thing") === "acme.thing");
check("an id that is only the prefix survives", extensionGroup("tedi.") === "tedi.");

console.log("\n[describe] sources are labelled, not guessed");
const tools: ToolSet = {
  read_file: { description: "read" } as never,
  mcp__srv__do: { description: "mcp" } as never,
  sql_query: { description: "ext" } as never,
  http_request: { description: "ext" } as never,
};
const rows = describeTools(
  tools,
  new Map([
    ["sql_query", "tedi.sql-explorer"],
    ["http_request", "tedi.api-client"],
  ]),
);
const at = (n: string) => rows.find((r) => r.name === n);
check("built-in labelled by name", at("read_file")?.group === "Files");
check("built-in section", at("read_file")?.section === "Built-in");
check("MCP labelled by prefix", at("mcp__srv__do")?.group === "srv");
check("MCP section", at("mcp__srv__do")?.section === "MCP");
// The point of the Map: two extension tools, two DIFFERENT groups.
check("extension labelled per extension", at("sql_query")?.group === "sql-explorer");
check("a second extension is a second group", at("http_request")?.group === "api-client");
check("extension section", at("sql_query")?.section === "Extensions");
check(
  "descriptions are carried through",
  rows.every((r) => r.description.length > 0),
);

console.log("\n[order] sections and groups come out in a stable, sensible order");
const nested = sectionTools(
  describeTools(
    {
      grep: { description: "" } as never,
      read_file: { description: "" } as never,
      mcp__srv__do: { description: "" } as never,
      mcp__tedi__sh: { description: "" } as never,
      bash_run: { description: "" } as never,
      sql_query: { description: "" } as never,
    } as ToolSet,
    new Map([["sql_query", "tedi.sql-explorer"]]),
  ),
);
check(
  "Built-in, then MCP, then Extensions",
  JSON.stringify(nested.map((s) => s.section)) ===
    JSON.stringify(["Built-in", "MCP", "Extensions"]),
  nested.map((s) => s.section),
);
check(
  "built-in groups keep their fixed order",
  JSON.stringify(nested[0].groups.map((g) => g.group)) ===
    JSON.stringify(["Files", "Search", "Shell"]),
  nested[0].groups.map((g) => g.group),
);
// `tedi` leads the MCP section: it is the app's own control surface, not
// something the user installed, and alphabetically it would fall after `srv`.
check(
  "tedi leads its section, the rest are alphabetical",
  JSON.stringify(nested[1].groups.map((g) => g.group)) === JSON.stringify(["tedi", "srv"]),
  nested[1].groups.map((g) => g.group),
);
check(
  "the section carries every one of its tools for the header checkbox",
  nested[0].tools.length === 3 && nested[1].tools.length === 2 && nested[2].tools.length === 1,
  {
    builtin: nested[0].tools.length,
    mcp: nested[1].tools.length,
    ext: nested[2].tools.length,
  },
);
// An empty heading is a hit the user cannot see. Sections are built FROM the
// rows, so filtering to nothing must leave nothing behind, not three headers.
check("filtering to nothing leaves no headings", sectionTools([]).length === 0);

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

// ---------------------------------------------------------------------------
// The popover's placement contract. Three props that only work as a SET, and a
// browser is the only other place the breakage shows.
//
// The AI panel is one section in a dockable stack, so this trigger can sit
// anywhere from the top of the window to the bottom. With collision handling on,
// Radix flipped the panel above the button whenever the section happened to be
// docked low - the same click opening in a different direction depending on a
// layout choice made days earlier.
//
// Turning the flip off fixes the direction and hands `size` both of the flip's
// old jobs. Drop either binding and the failure is silent: without the height
// var a short window clips the All on / All off footer, and without the width
// var - since disabling collisions also disables `shift` - the panel slides off
// screen entirely when the AI section is docked to a narrow left column.
// (`availableWidth` for a `bottom-end` placement is the space extending LEFT
// from the anchor's right edge; see @floating-ui/core's size middleware.)
console.log("\n[placement] the tools popover opens downward and fits, or not at all");
const picker = readFileSync(
  new URL("../../src/modules/ai/components/ToolsPicker.tsx", import.meta.url),
  "utf8",
);
check(
  "collision flipping is off, so the side is fixed",
  picker.includes("avoidCollisions={false}"),
);
check(
  "height is bound to the space actually below the trigger",
  picker.includes("max-h-[var(--radix-popover-content-available-height)]"),
);
check(
  "width is bound to the space available, since `shift` went with the flip",
  picker.includes("w-[min(30rem,var(--radix-popover-content-available-width))]"),
);
check(
  "the list is the part that gives, so the filter row and footer stay put",
  /min-h-0 flex-1 overflow/.test(picker),
);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
