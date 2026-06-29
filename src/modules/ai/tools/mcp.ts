import { tool, jsonSchema, type Tool } from "ai";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { getMcpClient } from "../lib/mcpClient";
import { getMcpServers, type McpServerConfig } from "../lib/mcpConfig";
import type { ToolContext } from "./context";

/** Sanitize a tool name to the provider-safe charset for use as an AI SDK tool
 *  key (also reused by extension tools). */
export function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[0-9]/, "_$&")
    .toLowerCase();
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

        // Format the result for the AI model.
        const parts: string[] = [];
        for (const content of result.content ?? []) {
          if (content.type === "text") {
            parts.push(content.text);
          } else if (content.type === "image") {
            parts.push(
              `[Image: ${content.mimeType ?? "unknown"}, ${content.data.length} bytes base64]`,
            );
          } else if (content.type === "resource") {
            const res = content.resource;
            if ("text" in res) {
              parts.push(`[Resource: ${res.uri}] ${res.text}`);
            } else {
              parts.push(`[Resource: ${res.uri}] (blob)`);
            }
          }
        }

        if (result.isError) {
          return { error: parts.join("\n") || "MCP tool returned an error." };
        }

        return { content: parts.join("\n") };
      } catch (e) {
        return {
          error: e instanceof Error ? e.message : `MCP tool "${mcpTool.name}" failed.`,
        };
      }
    },
  });
}

/**
 * Async version: actually connects to servers and builds tools. Called from
 * the agent loop before streamText so that tools are ready.
 */
export async function buildMcpToolsAsync(ctx: ToolContext): Promise<Record<string, Tool>> {
  const servers = await getMcpServers();
  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 0) return {};

  const tools: Record<string, Tool> = {};

  for (const server of enabled) {
    try {
      const client = await getMcpClient(server, ctx.getCwd() ?? undefined);
      for (const mcpTool of client.tools) {
        const base = `mcp__${sanitizeToolName(server.name)}__${sanitizeToolName(mcpTool.name)}`;
        // Two names differing only by case/punctuation sanitize to one key;
        // suffix on conflict so neither tool is silently dropped.
        let aiName = base;
        for (let n = 2; tools[aiName]; n++) aiName = `${base}_${n}`;
        tools[aiName] = mcpToolToAiTool(mcpTool, server.name, server, ctx);
      }
    } catch (e) {
      // Server failed to start — skip it.
      console.warn(`[MCP] Failed to connect to "${server.name}":`, e);
    }
  }

  return tools;
}

/** Get a summary of available MCP tools for the system prompt. */
export async function getMcpToolsSummary(cwd?: string): Promise<string | null> {
  const servers = await getMcpServers();
  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 0) return null;

  const lines: string[] = [];
  for (const server of enabled) {
    try {
      const client = await getMcpClient(server, cwd);
      if (client.tools.length > 0) {
        lines.push(
          `- **${server.name}** (${client.tools.length} tools): ${client.tools.map((t) => t.name).join(", ")}`,
        );
      }
    } catch {
      lines.push(`- **${server.name}**: (connection failed)`);
    }
  }

  if (lines.length === 0) return null;
  return `## MCP SERVERS\nYou have access to tools from these MCP servers:\n${lines.join("\n")}`;
}
