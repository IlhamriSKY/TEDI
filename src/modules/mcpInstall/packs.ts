/**
 * Which parts of the MCP surface an outside AI CLI is offered.
 *
 * The whole point is the token bill. A connected CLI loads the tool list into
 * EVERY request for the whole session, whether it drives TEDI or not, so the
 * surface is a standing cost and not a one-off. Measured: the core twenty are
 * ~2.5k tokens, and API Client's eleven AI tools would be ~1625 more - one
 * extension adding 66% on top of everything else. That is only acceptable if it
 * is opt-in, which is what this file exists to make possible.
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
 * Extensions are the sixth category and are deliberately NOT in this list: they
 * are resolved at runtime from what is installed AND enabled, so they appear as
 * their own switches only while they can actually answer.
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
  // NO generic "Extensions" pack. It would have no static tools of its own -
  // API Client and Database Viewer ARE the extension entries, and they are
  // resolved at runtime into their own switches below the fixed ones. An empty
  // category here was a permanently disabled row that explained nothing.
  {
    id: "ai",
    name: "AI (built-in agent)",
    hint: "Read what TEDI's own agent is doing, and hand work to it.",
    tools: toolsInPack("ai"),
  },
  {
    id: "misc",
    name: "Misc",
    hint: "Real input (keys, typing, clicks, drags), screenshots, and the eval_js escape hatch.",
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
 * The extensions that get a first-class MCP pack, by id.
 *
 * An allow-list, not "whatever registers AI tools". Advertising an extension's
 * tools costs real tokens on every request of every connected CLI (API Client's
 * eleven are ~1625), so it is only worth paying for the ones an agent genuinely
 * drives: sending API requests, and querying a database. RTK Bridge registers a
 * tool too and was being offered here, which is a switch nobody wants and a bill
 * nobody chose.
 *
 * Leaving one out does NOT put it out of reach: every extension's AI tools stay
 * callable through `run_command` with `extensionId` + `args`. This list is only
 * about which ones are worth ADVERTISING up front.
 */
export const MCP_EXTENSION_ALLOWLIST: { id: string; label: string }[] = [
  { id: "tedi.api-client", label: "API Client" },
  { id: "tedi.sql-explorer", label: "Database Viewer" },
];

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
