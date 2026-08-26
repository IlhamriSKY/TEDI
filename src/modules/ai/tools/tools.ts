import { buildEditTools } from "./edit";
import { buildFetchTools } from "./fetch";
import { buildFsTools } from "./fs";
import { buildScheduleTools } from "./schedule";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSkillTools } from "./skill";
import { buildSubagentTools } from "./subagent";
import { getLoadedSkills } from "../lib/skills";
import { buildTerminalTools } from "./terminal";
import { buildTediTools } from "./tedi";
import { buildTodoTools } from "./todo";
import { buildMcpToolsAsync } from "./mcp";
import { buildExtensionTools } from "./extensions";
import { describeTools, type ToolDescriptor } from "./catalog";

import type { ToolContext } from "./context";

export { resolvePath, type ToolContext } from "./context";
export { buildMcpToolsAsync };

/**
 * AI tool definitions.
 *
 * Read-only tools auto-execute through the security guard; mutating ones raise
 * an approval card. Edit / Multi Edit additionally require a prior Read File on
 * the path. Relative paths resolve against the active terminal cwd (`getCwd`).
 */
function buildToolsRaw(ctx: ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildFetchTools(),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildSkillTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildScheduleTools(ctx),
    ...buildTediTools(),
  } as const;
}

export type ChatTools = ReturnType<typeof buildToolsRaw>;

// Tools are pure functions of `ctx`; mutable state is read lazily inside
// `execute`. Per-ctx memoization avoids rebuilding ~12 zod schemas per turn.
// A fresh session gets a fresh ctx and a fresh build.
const toolsCache = new WeakMap<ToolContext, ChatTools>();

/**
 * Every tool this session WOULD send, before the user's off-list is applied.
 *
 * Same three sources in the same merge order as `runAgentStream`, so the picker
 * can neither offer a tool the turn would not send nor miss one it would. Async
 * because MCP tools come from live servers; that connect is deduped with the
 * turn's, so opening the picker costs nothing extra.
 */
export async function listAvailableTools(ctx: ToolContext): Promise<ToolDescriptor[]> {
  const extension = buildExtensionTools(ctx);
  const mcp = await buildMcpToolsAsync(ctx);
  const builtin = buildTools(ctx);
  const all = { ...extension, ...mcp, ...builtin };
  // A built-in or MCP key wins the merge, so only the extension keys that
  // actually survived may be labelled as coming from an extension.
  const fromExtension = new Set(
    Object.keys(extension).filter((k) => !(k in builtin) && !(k in mcp)),
  );
  return describeTools(all, fromExtension);
}

/**
 * The same list minus MCP: built-ins + extension tools only.
 *
 * Synchronous and connection-free on purpose, so the picker can show an on/off
 * count on mount without spawning every MCP server just to render a number. It
 * folds MCP in via `listAvailableTools` once the popover opens.
 */
export function listLocalTools(ctx: ToolContext): ToolDescriptor[] {
  const extension = buildExtensionTools(ctx);
  const builtin = buildTools(ctx);
  const fromExtension = new Set(Object.keys(extension).filter((k) => !(k in builtin)));
  return describeTools({ ...extension, ...builtin }, fromExtension);
}

export function buildTools(ctx: ToolContext): ChatTools {
  let built = toolsCache.get(ctx);
  if (!built) {
    built = buildToolsRaw(ctx);
    toolsCache.set(ctx, built);
  }
  // Rebuild the sub-agent + skill tools each turn so their descriptions (the
  // current sub-agent types / installed skills, baked into the description
  // string) stay fresh without an app restart. Cheap: a few zod schemas vs the
  // ~12 kept cached above. The rest of the toolset stays memoized.
  const fresh = {
    ...built,
    ...buildSubagentTools(ctx),
    ...buildSkillTools(ctx),
  } as Record<string, unknown>;
  // Sub-agent tools are no longer gated here: the tool picker switches them off
  // like any other tool, and `applyToolFilter` drops them before they are sent.
  // Building them unconditionally is what lets the picker LIST them at all.
  // Drop the `skill` tool when nothing is installed (no noise, no tokens).
  if (getLoadedSkills().length === 0) delete fresh.skill;
  return fresh as ChatTools;
}
