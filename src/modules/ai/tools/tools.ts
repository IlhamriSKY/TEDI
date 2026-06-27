import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildEditTools } from "./edit";
import { buildFetchTools } from "./fetch";
import { buildFsTools } from "./fs";
import { buildScheduleTools } from "./schedule";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

import type { ToolContext } from "./context";

export { resolvePath, type ToolContext } from "./context";

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

export function buildTools(ctx: ToolContext): ChatTools {
  let built = toolsCache.get(ctx);
  if (!built) {
    built = buildToolsRaw(ctx);
    toolsCache.set(ctx, built);
  }
  // Drop the sub-agent tool schemas on turns where the feature is disabled so
  // they cost zero tokens. buildTools runs every turn, so the toggle takes
  // effect on the very next message (both directions); the cached zod schemas
  // are never rebuilt, just omitted from the returned set.
  if (usePreferencesStore.getState().subagentsEnabled) return built;
  const gated = { ...built } as Record<string, unknown>;
  delete gated.run_subagent;
  delete gated.run_subagents;
  return gated as ChatTools;
}
