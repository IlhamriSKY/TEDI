import type { ToolSet } from "ai";

/**
 * Grouping and filtering for the tool picker.
 *
 * Kept out of `tools.ts`, which pulls in every builder, so the pure parts stay
 * testable on their own: `scripts/ai/tool-picker-verify.ts`.
 */

/**
 * Where a tool sits at the TOP level of the picker.
 *
 * Two levels because one cannot carry both facts: the section says what KIND of
 * thing serves the tool, the group says WHICH one. That keeps every provider
 * switchable on its own - each MCP server and each extension gets its own row
 * and its own checkbox - without filing an extension under MCP, which it is not.
 */
export type ToolSection = "Built-in" | "MCP" | "Extensions";

/** One row in the picker. */
export type ToolDescriptor = {
  /** Model-facing tool name. This is what `disabledTools` stores. */
  name: string;
  description: string;
  /** Top-level heading. */
  section: ToolSection;
  /** Sub-heading within the section: a capability area for a built-in, a server
   *  name for MCP, an extension for an extension tool. */
  group: string;
};

/** Prefix every MCP tool key carries (see `buildMcpToolsAsync`). */
const MCP_PREFIX = "mcp__";

/**
 * Which group a BUILT-IN tool belongs to.
 *
 * Derived from the name, not a hand-kept list, so a new tool is grouped without
 * anyone remembering to register it.
 *
 * Built-ins only. Panes, terminals and browsers come from TEDI's own in-process
 * MCP server, and `describeTools` asks `mcpGroup` before this is reached.
 */
export function builtinGroup(name: string): string {
  if (name.startsWith("bash_")) return "Shell";
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

/**
 * Sub-group label for an MCP tool: the server name, bare. The section heading
 * above it already says MCP, so the server name is the only part that tells one
 * row from the next. Null for a non-MCP tool.
 */
export function mcpGroup(name: string): string | null {
  const server = mcpServerOf(name);
  if (server === null) return null;
  return server || "(unnamed)";
}

/**
 * Sub-group label for an extension tool: the extension id minus the vendor
 * prefix every first-party one carries (`tedi.sql-explorer` -> `sql-explorer`).
 *
 * The same shortening `toolRowLabel` applies to MCP keys, for the same reason:
 * these labels sit in a narrow column, and rows that all start `tedi.` differ
 * only after the sixth character.
 */
export function extensionGroup(extensionId: string): string {
  return extensionId.replace(/^tedi\./, "") || extensionId;
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

/**
 * Build the picker rows for one assembled tool set.
 *
 * `extensionOf` maps a tool KEY to the extension that contributed it. It has to
 * be passed in: an extension names its own tools, so nothing about the key says
 * where it came from, and this is the only place that knowledge exists.
 */
export function describeTools(
  tools: ToolSet,
  extensionOf: ReadonlyMap<string, string> = new Map(),
): ToolDescriptor[] {
  const rows: ToolDescriptor[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const description = (t as { description?: string } | undefined)?.description ?? "";
    const server = mcpGroup(name);
    const ext = extensionOf.get(name);
    const [section, group]: [ToolSection, string] =
      server !== null
        ? ["MCP", server]
        : ext !== undefined
          ? ["Extensions", extensionGroup(ext)]
          : ["Built-in", builtinGroup(name)];
    rows.push({ name, description, section, group });
  }
  return rows.sort(
    (a, b) =>
      a.section.localeCompare(b.section) ||
      a.group.localeCompare(b.group) ||
      a.name.localeCompare(b.name),
  );
}

/** Top-level order. Built-ins first because they are the everyday ones; MCP
 *  before Extensions because TEDI's own control surface lives there. */
const SECTION_ORDER: ToolSection[] = ["Built-in", "MCP", "Extensions"];

/** Stable order for the built-in sub-groups. MCP servers and extensions are
 *  sorted by name instead - there is no meaningful fixed order for what the
 *  user happened to install. */
const GROUP_ORDER = ["Files", "Edit", "Search", "Shell", "Web", "Sub-agents", "Tasks", "Schedule"];

export type ToolGroup = { group: string; tools: ToolDescriptor[] };
export type ToolSectionGroup = {
  section: ToolSection;
  /** Every tool in the section, flattened - the section header's own checkbox
   *  and count act on this, not on one group at a time. */
  tools: ToolDescriptor[];
  groups: ToolGroup[];
};

/**
 * Nest the rows: section -> group -> tools.
 *
 * Empty sections and groups never appear, because they are built from the rows
 * rather than from a fixed skeleton. That matters while the search box is
 * filtering: a heading with nothing under it reads as a hit the user cannot see.
 */
export function sectionTools(rows: ToolDescriptor[]): ToolSectionGroup[] {
  const bySection = new Map<ToolSection, Map<string, ToolDescriptor[]>>();
  for (const r of rows) {
    let groups = bySection.get(r.section);
    if (!groups) {
      groups = new Map();
      bySection.set(r.section, groups);
    }
    const list = groups.get(r.group);
    if (list) list.push(r);
    else groups.set(r.group, [r]);
  }
  const groupRank = (section: ToolSection, g: string): number => {
    // TEDI's own server is the one MCP entry with a reason to lead: it is the
    // app's control surface, not something the user installed.
    if (section === "MCP") return g === "tedi" ? -1 : 0;
    if (section !== "Built-in") return 0;
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...bySection.entries()]
    .map(([section, groups]) => ({
      section,
      tools: [...groups.values()].flat(),
      groups: [...groups.entries()]
        .map(([group, tools]) => ({ group, tools }))
        .sort(
          (a, b) =>
            groupRank(section, a.group) - groupRank(section, b.group) ||
            a.group.localeCompare(b.group),
        ),
    }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));
}

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
