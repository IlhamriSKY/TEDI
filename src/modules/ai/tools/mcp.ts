import { tool, jsonSchema, type Tool } from "ai";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { toast } from "@/components/ui/toast";
import { getMcpClient } from "../lib/mcpClient";
import { getMcpServers, type McpServerConfig } from "../lib/mcpConfig";
import type { ToolContext } from "./context";

/** Image/audio payload carried out of an MCP tool result so toModelOutput can
 *  hand it to a multimodal model as a real file part. */
type McpMedia = { data: string; mimeType: string };

/** Sanitize a tool name to the provider-safe charset for use as an AI SDK tool
 *  key (also reused by extension tools). */
export function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[0-9]/, "_$&")
    .toLowerCase();
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Clamp a tool key to the provider limit (Anthropic/OpenAI cap names at
 *  `^[A-Za-z0-9_-]{1,64}$`; an over-long key 400s the WHOLE request, not just
 *  that tool). Over the cap, truncate and append a short stable hash so two long
 *  keys sharing a 64-char prefix don't collapse to one. Reused by extension
 *  tools, whose names are equally unbounded. */
export function clampToolKey(key: string, max = 64): string {
  if (key.length <= max) return key;
  const hash = fnv1a(key).toString(36).slice(0, 6);
  return `${key.slice(0, max - 1 - hash.length)}_${hash}`;
}

/** Convert an MCP tool definition to an AI SDK tool. */
function mcpToolToAiTool(
  mcpTool: McpTool,
  serverName: string,
  config: McpServerConfig,
  ctx: ToolContext,
) {
  return tool({
    description: `${mcpTool.description ?? "MCP tool from " + serverName} [${serverName}]`,
    // MCP ships a raw JSON Schema; wrap it with jsonSchema() so the AI SDK
    // treats it as a schema. Passing the bare object throws "schema is not a
    // function" when streamText prepares the tools (it expects Zod or jsonSchema).
    inputSchema: jsonSchema<Record<string, unknown>>(
      mcpTool.inputSchema as Parameters<typeof jsonSchema>[0],
    ),
    // Always require approval for MCP tools — they are external processes.
    needsApproval: true,
    execute: async (input: Record<string, unknown>) => {
      try {
        const client = await getMcpClient(config, ctx.getCwd() ?? undefined);
        const result = await client.callTool(mcpTool.name, input);

        // Collect text inline; carry image/audio as media parts so they reach a
        // multimodal model (toModelOutput below) instead of being flattened to a
        // useless "[Image: …]" placeholder.
        const textParts: string[] = [];
        const media: McpMedia[] = [];
        for (const content of result.content ?? []) {
          if (content.type === "text") {
            textParts.push(content.text);
          } else if (content.type === "image") {
            media.push({ data: content.data, mimeType: content.mimeType || "image/png" });
          } else if (content.type === "audio") {
            media.push({ data: content.data, mimeType: content.mimeType || "audio/mpeg" });
          } else if (content.type === "resource") {
            const res = content.resource;
            if ("text" in res) textParts.push(`[Resource: ${res.uri}]\n${res.text}`);
            else
              textParts.push(`[Resource: ${res.uri}] (binary blob, ${res.mimeType ?? "unknown"})`);
          } else if (content.type === "resource_link") {
            textParts.push(`[Resource link: ${content.uri}]`);
          }
        }

        const text = textParts.join("\n");
        if (result.isError) {
          return { error: text || "MCP tool returned an error." };
        }
        // A side-effect-only success (no text, no media) must not return "" — the
        // model can't tell that from a no-op and may pointlessly retry.
        if (!text && media.length === 0) {
          return { content: "(tool succeeded; no displayable content)" };
        }
        return { content: text, media };
      } catch (e) {
        return {
          error: e instanceof Error ? e.message : `MCP tool "${mcpTool.name}" failed.`,
        };
      }
    },
    // Map the execute result to model-facing content: text plus real image/audio
    // file parts (mirrors terminal.ts browser_screenshot). Persistence still uses
    // the plain { content } / { error } shape returned above.
    toModelOutput: ({ output }) => {
      if (output && typeof output === "object" && "error" in output) {
        return { type: "text", value: String((output as { error: unknown }).error) };
      }
      const o = (output ?? {}) as { content?: string; media?: McpMedia[] };
      const value: Array<
        { type: "text"; text: string } | { type: "file-data"; data: string; mediaType: string }
      > = [];
      if (o.content) value.push({ type: "text", text: o.content });
      for (const m of o.media ?? []) {
        value.push({ type: "file-data", data: m.data, mediaType: m.mimeType });
      }
      if (value.length === 0) {
        value.push({ type: "text", text: "(tool succeeded; no displayable content)" });
      }
      return { type: "content", value };
    },
  });
}

/**
 * Async version: actually connects to servers and builds tools. Called from
 * the agent loop before streamText so that tools are ready.
 */
// Servers we've already toasted as down, so an enabled-but-unreachable server is
// flagged once per outage (not every turn). Cleared when the server reconnects.
const _warnedFailedServers = new Set<string>();

export async function buildMcpToolsAsync(ctx: ToolContext): Promise<Record<string, Tool>> {
  const servers = await getMcpServers();
  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 0) return {};

  const tools: Record<string, Tool> = {};

  for (const server of enabled) {
    try {
      const client = await getMcpClient(server, ctx.getCwd() ?? undefined);
      _warnedFailedServers.delete(server.name); // recovered
      for (const mcpTool of client.tools) {
        // Clamp to 64 chars: a long server+tool combo overflows the provider's
        // tool-name limit and 400s the WHOLE turn, not just this tool.
        const base = clampToolKey(
          `mcp__${sanitizeToolName(server.name)}__${sanitizeToolName(mcpTool.name)}`,
        );
        // Two names differing only by case/punctuation sanitize to one key;
        // suffix on conflict (re-clamped) so neither tool is silently dropped.
        let aiName = base;
        for (let n = 2; tools[aiName]; n++) aiName = clampToolKey(`${base}_${n}`);
        tools[aiName] = mcpToolToAiTool(mcpTool, server.name, server, ctx);
      }
    } catch (e) {
      // Server failed to start — skip its tools, and tell the user once (an
      // enabled server silently dropping its tools otherwise reads as "the AI
      // can't do that" rather than "your server is down").
      console.warn(`[MCP] Failed to connect to "${server.name}":`, e);
      if (!_warnedFailedServers.has(server.name)) {
        _warnedFailedServers.add(server.name);
        toast(
          `MCP server "${server.name}" is enabled but failed to connect; its tools are unavailable.`,
          {
            variant: "error",
          },
        );
      }
    }
  }

  return tools;
}
