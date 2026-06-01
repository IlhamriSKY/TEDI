import { tool } from "ai";
import { z } from "zod";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { runSubagent } from "../agents/runSubagent";
import { SUBAGENTS, type SubagentType } from "../agents/registry";
import { scrubErrorPath, type ToolContext } from "./context";

const TYPE_KEYS = Object.keys(SUBAGENTS) as [SubagentType, ...SubagentType[]];

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn an isolated read-only subagent (own tools + fresh history). Delegate large search / review / audit to keep your context clean. Returns a single text summary.

Types:
${TYPE_KEYS.map((k) => `- ${k}: ${SUBAGENTS[k].description}`).join("\n")}

Auto.`,
      inputSchema: z.object({
        type: z.enum(TYPE_KEYS),
        prompt: z
          .string()
          .describe(
            "Self-contained instruction. The subagent has no memory of prior conversation - include all relevant context.",
          ),
        description: z
          .string()
          .optional()
          .describe("Short label shown in the chat UI for the spawn card."),
      }),
      execute: async ({ type, prompt, description }) => {
        const apiKeys = ctx.getApiKeys();
        const selectedModelId = ctx.getSelectedModelId();
        const prefs = usePreferencesStore.getState();
        try {
          const r = await runSubagent({
            type,
            prompt,
            keys: apiKeys,
            modelId: selectedModelId,
            toolContext: ctx,
            lmstudioBaseURL: prefs.lmstudioBaseURL,
            openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
            // Inherits the parent agent's cancel signal so a top-level Stop
            // also aborts the subagent's HTTP fetch.
            abortSignal: ctx.abortSignal,
          });
          return {
            type,
            description,
            summary: r.summary,
            stepCount: r.stepCount,
            durationMs: r.durationMs,
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), type };
        }
      },
    }),
  } as const;
}
