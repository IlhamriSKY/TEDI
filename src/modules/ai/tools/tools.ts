import { usePreferencesStore } from "@/modules/settings/preferences";
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
import { buildTodoTools } from "./todo";
import { buildMcpToolsAsync, getMcpToolsSummary } from "./mcp";
import { buildExtensionTools } from "./extensions";
import { describeTools, type ToolDescriptor } from "./catalog";

import type { ToolContext } from "./context";

export { resolvePath, type ToolContext } from "./context";
export { buildMcpToolsAsync, getMcpToolsSummary };

/**
 * AI tool definitions.
 *
 * Read-only tools (`Read File`, `List Directory`, `Grep`, `Glob`) auto-execute
 * through the security guard. Mutating tools (`Write File`, `Edit`,
 * `Multi Edit`, `Create Directory`, `Bash Run`) require approval; the SDK
 * surfaces a tool-approval-request that the UI renders as a card.
 * `Edit` and `Multi Edit` also require a prior `Read File` on the path.
 *
 * Paths are resolved against the active terminal cwd via `getCwd`.
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
 * Uses the same three sources in the same merge order as `runAgentStream`, so
 * the picker can never offer a tool the turn would not send, nor miss one it
 * would. Async because MCP tools come from live servers (the connect is deduped
 * with the one a turn makes, so opening the picker costs nothing extra).
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
 * Synchronous and connection-free, deliberately. It exists so the tools picker
 * can show an on/off count the moment it mounts, without spawning every enabled
 * MCP server's subprocess just to render a number. The picker folds the MCP
 * tools in via `listAvailableTools` when the popover actually opens.
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
  // Sub-agent tools cost zero tokens on turns where the feature is off.
  if (!usePreferencesStore.getState().subagentsEnabled) {
    delete fresh.run_subagent;
    delete fresh.run_subagents;
  }
  // Drop the `skill` tool when nothing is installed (no noise, no tokens).
  if (getLoadedSkills().length === 0) delete fresh.skill;
  return fresh as ChatTools;
}
