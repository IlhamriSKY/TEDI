import type { ToolSet } from "ai";

/**
 * Grouping and filtering for the tool picker.
 *
 * Kept apart from `tools.ts` (which builds the executable tools and pulls in
 * every builder) so the pure parts - which group a tool belongs to, and which
 * tools survive the user's off-list - are testable on their own:
 * `scripts/tool-picker-verify.ts`.
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
 * Derived from the name, not from a hand-kept list, so a tool added later lands
 * in a group without anyone remembering to register it. The browser rule exists
 * because the browser tools live in `terminal.ts` for historical reasons while
 * being the group users actually reach for by name.
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

/** Group label for an MCP tool: one group per server, named after the server. */
export function mcpGroup(name: string): string | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  return sep === -1 ? "MCP" : `MCP: ${rest.slice(0, sep)}`;
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

/**
 * Drop the tools the user switched off.
 *
 * Returns `undefined` rather than `{}` when nothing is left: an empty tool list
 * is not universally accepted (some endpoints reject `tools: []`), and "no
 * tools" is a state the request should express by omitting the field, exactly
 * as chat mode does.
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
