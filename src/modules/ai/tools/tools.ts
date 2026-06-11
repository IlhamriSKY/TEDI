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
  const cached = toolsCache.get(ctx);
  if (cached) return cached;
  const built = buildToolsRaw(ctx);
  toolsCache.set(ctx, built);
  return built;
}
