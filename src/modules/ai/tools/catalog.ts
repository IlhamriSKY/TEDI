import type { ToolSet } from "ai";

/**
 * Grouping and filtering for the tool picker.
 *
 * Kept out of `tools.ts`, which pulls in every builder, so the pure parts stay
 * testable on their own: `scripts/tool-picker-verify.ts`.
 */

/** One row in the picker. */
export type ToolDescriptor = {
  /** Model-facing tool name. This is what `disabledTools` stores. */
  name: string;
  description: string;
  group: string;
};

/** Prefix every MCP tool key carries (see `buildMcpToolsAsync`). */
const MCP_PREFIX = "mcp__";

/**
 * Which group a BUILT-IN tool belongs to.
 *
 * Derived from the name, not a hand-kept list, so a new tool is grouped without
 * anyone remembering to register it. The browser rule exists because those tools
 * live in `terminal.ts` for historical reasons.
 */
export function builtinGroup(name: string): string {
  if (name.includes("browser") || name === "navigate_and_read") return "Browser";
  if (name.startsWith("bash_")) return "Shell";
  if (name.includes("terminal") || name === "suggest_command" || name === "group_tabs")
    return "Terminal";
  if (name === "rotate_pane" || name === "consolidate_terminals") return "Terminal";
  if (name.startsWith("run_subagent")) return "Sub-agents";
  if (name.includes("schedule")) return "Schedule";
  if (name === "fetch") return "Web";
  if (name === "skill") return "Skills";
  if (name === "todo_write") return "Tasks";
  if (
    name === "edit" ||
    name === "multi_edit" ||
    name === "write_file" ||
    name === "replace_in_files"
  )
    return "Edit";
  if (name === "grep" || name === "glob") return "Search";
  return "Files";
}

/** The server an MCP tool key belongs to, or null for a non-MCP tool. A key with
 *  no server segment yields "" (grouped, but unnamed). */
export function mcpServerOf(name: string): string | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  return sep === -1 ? "" : rest.slice(0, sep);
}

/** Group label for an MCP tool: one group per server, named after the server. */
export function mcpGroup(name: string): string | null {
  const server = mcpServerOf(name);
  if (server === null) return null;
  return server ? `MCP: ${server}` : "MCP";
}

/**
 * The "## MCP SERVERS" prompt block, counted from the tools the turn is really
 * sending.
 *
 * Deriving it here rather than from the live server list is the point: a server
 * whose tools the user unticked, or that failed to connect, has nothing in the
 * tool set and must not be advertised as "available in your tool list".
 */
export function mcpSummaryFor(toolNames: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    const server = mcpServerOf(name);
    if (server === null) continue;
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, n]) => `- **${server || "MCP"}** (${n} tool${n === 1 ? "" : "s"})`);
  return `\n\n## MCP SERVERS\nThese MCP servers' tools are available in your tool list:\n${lines.join("\n")}`;
}

/**
 * Label for one picker row.
 *
 * An MCP key is `mcp__<server>__<tool>` and the group header IS the server, so
 * the prefix is repeated noise - and it is long enough that the row had no space
 * left for the description. Everything else shows verbatim.
 */
export function toolRowLabel(name: string): string {
  const server = mcpServerOf(name);
  if (server === null) return name;
  // A malformed key has NO server segment, so `mcpServerOf` returns "" and it
  // groups under a bare "MCP" header that names nothing. There is no prefix to
  // drop, and slicing a fixed length off it eats real characters
  // (`mcp__weird` -> `ird`).
  if (server === "") return name;
  return name.slice(`${MCP_PREFIX}${server}__`.length) || name;
}

/** Build the picker rows for one assembled tool set. `extensionNames` marks the
 *  keys that came from installed extensions, which cannot be told apart by name
 *  (an extension picks its own). */
export function describeTools(
  tools: ToolSet,
  extensionNames: ReadonlySet<string> = new Set(),
): ToolDescriptor[] {
  const rows: ToolDescriptor[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const description = (t as { description?: string } | undefined)?.description ?? "";
    const group = mcpGroup(name) ?? (extensionNames.has(name) ? "Extensions" : builtinGroup(name));
    rows.push({ name, description, group });
  }
  return rows.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/** Stable group order for the picker: the everyday ones first, then whatever
 *  the user installed, alphabetically so it does not jump around. */
const GROUP_ORDER = [
  "Files",
  "Edit",
  "Search",
  "Shell",
  "Terminal",
  "Browser",
  "Web",
  "Sub-agents",
  "Skills",
  "Tasks",
  "Schedule",
  "Extensions",
];

export function groupTools(
  rows: ToolDescriptor[],
): Array<{ group: string; tools: ToolDescriptor[] }> {
  const byGroup = new Map<string, ToolDescriptor[]>();
  for (const r of rows) {
    const list = byGroup.get(r.group);
    if (list) list.push(r);
    else byGroup.set(r.group, [r]);
  }
  const rank = (g: string): number => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...byGroup.entries()]
    .map(([group, tools]) => ({ group, tools }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group));
}

/** The tools that spawn sub-agents. */
export const SUBAGENT_TOOL_NAMES = ["run_subagent", "run_subagents"] as const;

/**
 * Are sub-agents available this turn?
 *
 * Replaces the old `subagentsEnabled` preference: the tool picker is now the
 * only switch, so "the feature is on" and "the tool is sent" cannot disagree.
 * Keyed on the BATCH tool because that is what the orchestration prompt tells
 * the model to call and what `forceSpawnStep0` pins; keeping `run_subagent`
 * alone is a narrower choice the user is free to make.
 */
export function subagentsAvailable(disabled: ReadonlySet<string>): boolean {
  return !disabled.has("run_subagents");
}

/** The off-list that switching sub-agents off implies. Order-stable and
 *  idempotent, so re-running it can neither duplicate nor reorder entries.
 *  Used by the settings migration off the removed `subagentsEnabled` preference
 *  and by the extension API's `setSubagentsEnabled`. */
export function withSubagentsDisabled(disabled: readonly string[]): string[] {
  return [...new Set([...disabled, ...SUBAGENT_TOOL_NAMES])].sort();
}

/**
 * Drop the tools the user switched off.
 *
 * Returns `undefined`, not `{}`, when nothing survives: some endpoints reject
 * `tools: []`, so "no tools" must be expressed by omitting the field.
 */
export function applyToolFilter(
  tools: ToolSet | undefined,
  disabled: ReadonlySet<string>,
): ToolSet | undefined {
  if (!tools) return undefined;
  if (disabled.size === 0) return tools;
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!disabled.has(name)) out[name] = t;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
