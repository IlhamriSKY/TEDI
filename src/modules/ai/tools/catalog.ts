import type { ToolSet } from "ai";

/**
 * Grouping and filtering for the tool picker.
 *
 * Kept out of `tools.ts`, which pulls in every builder, so the pure parts stay
 * testable on their own: `scripts/ai/tool-picker-verify.ts`.
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
 * The "## MCP SERVERS" prompt block, derived from the tools the turn is really
 * sending.
 *
 * Deriving it here rather than from the live server list is the point: a server
 * whose tools the user unticked, or that failed to connect, has nothing in the
 * tool set and must not be advertised as "available in your tool list".
 *
 * NAMES ONLY, NO COUNT. This block sits in the SYSTEM PROMPT, which is the
 * cached prefix of every request in the session, so anything volatile in it
 * costs real money: an MCP server that finished listing its tools between two
 * turns flipped "(1 tool)" to "(2 tools)", and that one word re-priced the whole
 * prefix as a cache MISS for every later request. Measured in a real session:
 * the change landed on request 4 of 11. The count was never worth that - the
 * model receives the tool definitions themselves in the same request, so it can
 * already see exactly which tools each server gave it. Server names change only
 * when a server appears or drops out, which is both rarer and worth a re-cache.
 */
export function mcpSummaryFor(toolNames: Iterable<string>): string {
  const servers = new Set<string>();
  for (const name of toolNames) {
    const server = mcpServerOf(name);
    if (server === null) continue;
    servers.add(server || "MCP");
  }
  if (servers.size === 0) return "";
  const lines = [...servers].sort((a, b) => a.localeCompare(b)).map((s) => `- **${s}**`);
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
 * Browser tools that cannot be called until a browser pane exists.
 *
 * Every one of these takes a REQUIRED `leafId` naming an already-open pane, and
 * the only place that id comes from is the `<env>` block's `browsers:` list. With
 * no pane open there is no id to pass, so they are not merely unlikely to be
 * called - they are uncallable, and their definitions are ~11 600 characters of
 * a ~37 000-character tool payload billed on every request of every session,
 * including the overwhelming majority that never open a browser at all.
 *
 * `open_browser` is deliberately NOT here: it takes a url, needs no pane, and is
 * how a pane comes to exist. It also answers the one-shot lookup case on its own
 * (`read: true` returns the page text in the same call), which is exactly what
 * the prompt tells the model to do when nothing is open.
 *
 * These are switched off with `activeTools`, ONCE PER TURN, and are never removed
 * from the tool set: the picker still lists them, `disabledTools` still governs
 * them, and replayed history still resolves them. The turn after a pane exists
 * they are all back - which is also the turn `<env>` first names that pane, so
 * the model gains the tools and the leafId to use them together.
 *
 * Per turn rather than per step because adding or removing a tool definition
 * invalidates Anthropic's tools cache and everything cached behind it. Deciding
 * this per step rewrote the whole prefix mid-turn in exactly the flow it was
 * meant to help.
 */
export const BROWSER_PANE_TOOL_NAMES = [
  "control_browser",
  "navigate_and_read",
  "read_browser",
  "read_browser_console",
  "browser_click",
  "browser_click_at",
  "browser_hover",
  "browser_press_key",
  "browser_screenshot",
  "browser_scroll",
  "browser_type",
] as const;

/**
 * The tools worth sending THIS step, or `undefined` for "all of them".
 *
 * `undefined` is not a detail: `activeTools` is compared with `includes` on every
 * tool for every step, so returning a full list where nothing is filtered is
 * pure work, and it also pins the value where the SDK would otherwise skip the
 * filter entirely.
 */
export function activeToolNames(
  toolNames: Iterable<string>,
  hasBrowserPane: boolean,
): string[] | undefined {
  if (hasBrowserPane) return undefined;
  const off = new Set<string>(BROWSER_PANE_TOOL_NAMES);
  const all = [...toolNames];
  const kept = all.filter((n) => !off.has(n));
  return kept.length === all.length ? undefined : kept;
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
