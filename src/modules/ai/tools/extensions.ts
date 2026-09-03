import { jsonSchema, tool, type ToolSet } from "ai";
import { aiToolsRegistry } from "@/modules/extensions/registries";
import { scrubErrorPath } from "./context";
import { clampToolKey, sanitizeToolName } from "./mcp";

type ExtToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * Tools contributed by installed extensions via `contributes.aiTools[]` +
 * `ctx.registerAiToolHandler(name, handler)`.
 *
 * Built FRESH each turn, not memoised, so toggling an extension takes effect on
 * the next model call.
 *
 * Handlers dispatch on the exact `(extensionId, name)` pair, never a global name
 * lookup, so two extensions can declare the same tool name safely and a cleared
 * handler degrades to a clean error. agent.ts spreads built-ins AFTER these, so
 * an extension can never shadow one; within this set first registration wins.
 */
export function buildExtensionTools(
  ctx: import("./context").ToolContext,
  /**
   * Optional out-parameter: tool KEY -> contributing extension id, for the
   * picker, which gives each extension its own group.
   *
   * Filled here rather than derived by a second pass, because the key is not the
   * declared name - it is sanitized, clamped, and skipped on collision. A caller
   * recomputing that would be one refactor away from disagreeing with the set it
   * is labelling, and would label it wrong in silence.
   */
  extensionOf?: Map<string, string>,
): ToolSet {
  const out: ToolSet = {};
  for (const { extensionId, item } of aiToolsRegistry.list()) {
    const name = item.name;
    if (!name) continue;
    // Sanitize to the provider-safe charset (Anthropic/Gemini reject spaces &
    // punctuation in tool names — a bad one 400s the whole request). Only the
    // model-facing KEY is sanitized; dispatch still uses the original `name`.
    const toolName = clampToolKey(sanitizeToolName(name));
    if (!toolName || out[toolName]) continue;
    extensionOf?.set(toolName, extensionId);
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
