/**
 * Which parts of the MCP surface may run.
 *
 * No agent is advertised these one by one: an outside CLI sees one gateway tool, and TEDI's own
 * agent one `tedi` tool. So these switches decide what may run, not what anyone pays for.
 *
 * MEMBERSHIP IS NOT DECLARED HERE ANY MORE. Each tool names its own pack in
 * `scripts/mcp/tools.mjs`, the shared table both servers serve, and the
 * categories below are derived from it. This file used to keep a hand-written
 * second copy of every tool name, guarded by a verify that compared the two
 * lists - which is a test for a duplicate that did not need to exist. Adding a
 * tool is now one entry in one file.
 *
 * The direction of the dependency is what makes that safe: `tools.mjs` imports
 * nothing (it must not - it ships as a bundle resource beside `server.mjs`, with no
 * `node_modules`), so `src/` importing it cannot create a cycle.
 *
 * The UI still resolves packs down to a flat list of DISABLED TOOL NAMES and
 * writes that to the settings file, because the server has to read the answer
 * off disk without loading any of this.
 */
import { TOOL_DEFS, TOOL_NAMES, toolsInPack, type ToolDef } from "@mcp/tools.mjs";

export type McpPack = {
  id: ToolDef["pack"];
  name: string;
  /** What it is for, in the dialog. */ hint: string;
  /** Derived from `tools.mjs`; never hand-written. */ tools: string[];
  /** Not offered as a switch: without these nothing can find its way around. */
  always?: boolean;
};

/**
 * The FIXED categories, cut by what part of TEDI they control rather than by the
 * shape of the verb. An earlier cut grouped by mechanism (read / shell / files /
 * ui), which described the tools instead of the app and left no place to hang
 * "the browser" or "the built-in agent" - so those capabilities had nowhere to
 * live and nobody noticed they were missing.
 *
 * Extensions are deliberately NOT in this list: each one installed AND enabled gets
 * its own switch, on by default, in the dialog.
 */
export const MCP_PACKS: McpPack[] = [
  {
    id: "tedi",
    name: "TEDI",
    hint: "Panes, tabs, terminals, editors, workspaces, SSH. The core surface.",
    tools: toolsInPack("tedi"),
    // Not switchable: `state` and `inspect` are how an agent finds anything at
    // all, including the fact that the other packs were turned off.
    always: true,
  },
  {
    id: "settings",
    name: "Settings",
    hint: "Preferences, theme, shortcuts, agents; enable/disable/update extensions.",
    tools: toolsInPack("settings"),
  },
  {
    id: "ai",
    name: "AI (built-in agent)",
    hint: "Read what TEDI's own agent is doing, and hand work to it.",
    tools: toolsInPack("ai"),
  },
  {
    id: "misc",
    name: "Misc",
    hint: "Real input, screenshots, and eval_js, which runs with the app's full privileges and can read your saved API keys.",
    tools: toolsInPack("misc"),
  },
];

// Every tool must land in exactly one pack, and every pack must be non-empty.
// Both were previously checked by a verify script comparing two hand-kept lists;
// deriving from one table turns that into an assertion about the table itself,
// which is cheap enough to run at import.
{
  const covered = MCP_PACKS.flatMap((p) => p.tools);
  const orphan = TOOL_NAMES.filter((n) => !covered.includes(n));
  if (orphan.length) {
    throw new Error(
      `MCP_PACKS has no category for pack(s) ${[...new Set(orphan.map((n) => TOOL_DEFS[n].pack))].join(", ")} - tools ${orphan.join(", ")} would be permanently on.`,
    );
  }
}

/**
 * Pack ids -> the flat disabled-tool list the server reads.
 *
 * Stores what is OFF, not what is on, for the same reason the AI tool picker
 * does: a tool added later is ON by default, so a new capability is not silently
 * withheld from everyone who saved a selection before it existed.
 */
export function disabledToolsFor(disabledPackIds: readonly string[]): string[] {
  const off = new Set(disabledPackIds);
  return MCP_PACKS.filter((p) => !p.always && off.has(p.id)).flatMap((p) => p.tools);
}
