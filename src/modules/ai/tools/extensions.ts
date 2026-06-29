import { jsonSchema, tool, type ToolSet } from "ai";
import { aiToolsRegistry } from "@/modules/extensions/registries";
import { scrubErrorPath } from "./context";
import { sanitizeToolName } from "./mcp";

type ExtToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * Tools contributed by installed extensions via `contributes.aiTools[]` +
 * `ctx.registerAiToolHandler(name, handler)`.
 *
 * Built FRESH each turn (not memoised) so enabling/disabling an extension is
 * reflected on the next model call - a disabled extension's slice is cleared
 * from `aiToolsRegistry`, so its tools simply disappear.
 *
 * Design notes:
 *   - Each tool's arg schema is the extension-declared JSON Schema, wrapped via
 *     the AI SDK `jsonSchema()` helper. `approval: "needsApproval"` maps to the
 *     SDK's `needsApproval`, so the user approves the call through the very same
 *     card built-in mutating tools use.
 *   - The handler is dispatched by the exact `(extensionId, name)` pair (not a
 *     global name lookup), so two extensions declaring the same tool name can't
 *     be confused, and a stale/cleared handler degrades to a clean error.
 *   - The caller (agent.ts) spreads the BUILT-IN tools AFTER these, so an
 *     extension can never shadow a built-in tool (e.g. `bash_run`). Within this
 *     set, the first registration of a name wins.
 */
export function buildExtensionTools(ctx: import("./context").ToolContext): ToolSet {
  const out: ToolSet = {};
  for (const { extensionId, item } of aiToolsRegistry.list()) {
    const name = item.name;
    if (!name) continue;
    // Sanitize to the provider-safe charset (Anthropic/Gemini reject spaces &
    // punctuation in tool names — a bad one 400s the whole request). Only the
    // model-facing KEY is sanitized; dispatch still uses the original `name`.
    const toolName = sanitizeToolName(name);
    if (!toolName || out[toolName]) continue;
    const schema =
      item.parameters && typeof item.parameters === "object"
        ? item.parameters
        : { type: "object", properties: {} };
    out[toolName] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      // ALWAYS route an extension tool call through the approval flow. The
      // handler is unvetted third-party code running with the app's full
      // privileges, so a model-triggered call must be subject to the user's
      // approval mode - it prompts in "Ask" mode and is auto-approved only if
      // the user explicitly enabled that. (Honoring a manifest `approval:"auto"`
      // here would let a prompt-injected model silently run extension code even
      // in Ask mode.) The manifest `approval` field is advisory in this version.
      needsApproval: true,
      execute: async (args) => {
        const handler = aiToolsRegistry.getRuntime(extensionId, name) as ExtToolHandler | undefined;
        if (typeof handler !== "function") {
          return {
            error: `Extension "${extensionId}" AI tool "${name}" has no registered handler (the extension may be disabled or did not call ctx.registerAiToolHandler).`,
          };
        }
        try {
          const result = await Promise.resolve(handler((args ?? {}) as Record<string, unknown>));
          // The model needs a serialisable result; default to a success marker
          // when the handler returns nothing.
          return result ?? { ok: true };
        } catch (e) {
          // Scrub filesystem paths from extension errors to prevent leaking
          // local paths back to the model (consistent with built-in tools).
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    });
  }
  return out;
}
