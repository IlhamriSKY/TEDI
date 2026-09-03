import { tool, jsonSchema, type Tool } from "ai";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { toast } from "@/components/ui/toast";
import { getMcpClient } from "../lib/mcpClient";
import { getMcpServers, TEDI_MCP_SERVER_NAME, type McpServerConfig } from "../lib/mcpConfig";
import { TOOL_DEFS } from "@mcp/tools.mjs";
import { type TediMcpDeps } from "../lib/tediMcpServer";
import { getMcpSurface } from "@/modules/settings/store";
import { isTrustedEgressHost } from "../lib/security";
import type { ToolContext } from "./context";

/** Image/audio payload carried out of an MCP tool result so toModelOutput can
 *  hand it to a multimodal model as a real file part. */
type McpMedia = { data: string; mimeType: string };

/**
 * Cap on one MCP tool result, in characters.
 *
 * TEDI's own in-process server already caps at this number, and the comment
 * there argues the cap exists so "the same call costs the same on either
 * transport". That reasoning only ever covered TEDI's two servers: a THIRD-PARTY
 * server's result was uncapped, went into the window at full size, and then sat
 * in replayed history for the rest of the session. One crawl or one `SELECT *`
 * could dominate every later request.
 */
const MAX_RESULT_CHARS = 20000;

/**
 * Cap on ONE base64 media part, in characters.
 *
 * The expensive half. A screenshot or audio blob from a third-party server was
 * returned uncapped, forwarded into the model message, and then replayed with
 * the history for the rest of the session - the same unbounded growth the text
 * cap exists to prevent, on the payload that costs the most. ~4 MB of base64 is
 * already far past anything a model reads usefully.
 */
const MAX_MEDIA_CHARS = 4_000_000;

/** Drop over-large parts rather than truncating them: half a base64 image is not
 *  a smaller image, it is a corrupt one the model cannot decode. */
function capMedia(media: McpMedia[]): McpMedia[] {
  return media.filter((m) => m.data.length <= MAX_MEDIA_CHARS);
}

function capResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... truncated at ${MAX_RESULT_CHARS} characters. Ask for something narrower.`;
}

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

/**
 * The approval rule for one BUILTIN tool: `true` (always ask), or a predicate
 * over the call's `action`.
 *
 * Only reached for `config.builtin`. `auto` is a field in this repo's own tool
 * table, not an annotation, so it never crosses the protocol and no third-party
 * server can set one - see the note on `ToolDef.auto`.
 */
function autoApprover(toolName: string): boolean | ((input: Record<string, unknown>) => boolean) {
  const auto = TOOL_DEFS[toolName]?.auto;
  if (!auto?.length) return true;
  const free = new Set<string>(auto);
  return (input) => {
    const action = String(input?.action ?? "");
    if (free.has(action)) return false;
    // Reaching a NEW host asks; the same host then stays quiet for the rest of
    // the session. This is not a second policy, it is the one `open_browser`
    // ran on before it became an action, and dropping it would have turned a
    // five-page research pass on one site into five identical cards. The host
    // is recorded from inside the handler, which only runs after approval.
    if ((action === "open" || action === "navigate") && typeof input?.url === "string") {
      return !isTrustedEgressHost(input.url);
    }
    return true;
  };
}

/** Convert an MCP tool definition to an AI SDK tool. */
function mcpToolToAiTool(
  mcpTool: McpTool,
  config: McpServerConfig,
  ctx: ToolContext,
  /** The SAME deps `buildMcpToolsAsync` connected with. Passing them again is
   *  not redundant: they are part of the client cache key, so omitting them here
   *  resolves to a DIFFERENT client than the one that advertised this tool. */
  builtinDeps: TediMcpDeps | undefined,
) {
  const serverName = config.name;
  return tool({
    // No `[server]` suffix. The key the model calls is already
    // `mcp__<server>__<tool>`, so the server name was being billed twice per
    // tool on every request to say the same thing.
    description: mcpTool.description ?? `MCP tool from ${serverName}`,
    // MCP ships a raw JSON Schema; wrap it with jsonSchema() so the AI SDK
    // treats it as a schema. Passing the bare object throws "schema is not a
    // function" when streamText prepares the tools (it expects Zod or jsonSchema).
    inputSchema: jsonSchema<Record<string, unknown>>(
      mcpTool.inputSchema as Parameters<typeof jsonSchema>[0],
    ),
    // Approval on every MCP call, with ONE exception: a tool the BUILT-IN `tedi`
    // server annotates `readOnlyHint`.
    //
    // The spec is explicit that a client MUST treat annotations as untrusted,
    // and that is exactly why the exception is scoped to `config.builtin`: that
    // server is TEDI's own code in TEDI's own realm, and its annotations come
    // from the table in this repo, not from a third party. A third-party server
    // could claim `readOnlyHint` on anything, so its claim buys it nothing.
    //
    // In practice this is exactly one tool: `inspect`, the only handler the
    // in-process server both serves and annotates read-only. It reads TEDI's own
    // command / extension / settings / workspace lists, which carry no secrets,
    // and it used to raise a card the user had to clear before the agent could
    // see anything - while `read_file`, a strictly wider read, ran unattended
    // because it happens to be a native tool.
    // A tool that folds a whole surface behind one `action` enum is read-only
    // for some values and not others, so a per-tool flag cannot express it. For
    // the builtin server only, `auto` in the shared table names the values that
    // run unattended - which is how `read`, `scroll` and `console` keep the
    // no-card behaviour the native browser tools had. Looked up by NAME in this
    // repo's own table, never taken off the wire, so a third-party server cannot
    // grant itself one.
    needsApproval: config.builtin
      ? mcpTool.annotations?.readOnlyHint === true
        ? false
        : autoApprover(mcpTool.name)
      : true,
    execute: async (input: Record<string, unknown>) => {
      try {
        const client = await getMcpClient(config, ctx.getCwd() ?? undefined, builtinDeps);
        // Pressing Stop has to reach the server too, or the model stream aborts
        // while the call keeps running.
        const result = await client.callTool(mcpTool.name, input, {
          signal: ctx.abortSignal,
        });

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

        let text = textParts.join("\n");
        // MCP 2025-06-18 added `structuredContent`, and a server that declares an
        // `outputSchema` may put the real answer only there. Reading `content`
        // alone turned those calls into "(no displayable content)" while the
        // answer was discarded. The spec asks servers to ALSO serialize it into a
        // text block for back-compat, so only fall back to it when `content` gave
        // us nothing - forwarding both would bill the same payload twice.
        if (!text && result.structuredContent !== undefined) {
          text = JSON.stringify(result.structuredContent);
        }
        if (result.isError) {
          return { error: capResult(text) || "MCP tool returned an error." };
        }
        // A side-effect-only success (no text, no media) must not return "" — the
        // model can't tell that from a no-op and may pointlessly retry.
        if (!text && media.length === 0) {
          return { content: "(tool succeeded; no displayable content)" };
        }
        return { content: capResult(text), media: capMedia(media) };
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
  // The pack switches in the MCP dialog gate the built-in server too, not just
  // the stdio one an outside CLI connects to. One surface, one set of switches:
  // turning the Settings pack off has to take `set_setting` away from TEDI's own
  // agent as well, or the switch is trivially bypassed from inside.
  const [servers, surface] = await Promise.all([getMcpServers(), getMcpSurface()]);
  const disabledTools = surface.disabledTools;
  // TEDI's own control surface is an MCP server like any other (see
  // `lib/tediMcpServer.ts`) - it just runs in-process. Listing it first keeps it
  // ahead of a user server that happens to share the name; the loop below then
  // suffixes theirs on conflict rather than dropping either.
  const enabled: McpServerConfig[] = [
    { name: TEDI_MCP_SERVER_NAME, command: "", args: [], enabled: true, builtin: true },
    ...servers.filter((s) => s.enabled && s.name !== TEDI_MCP_SERVER_NAME),
  ];

  const tools: Record<string, Tool> = {};

  // ONE deps object, used for the connect here AND captured by every tool's
  // `execute`. They are part of the client cache key (`mcpClient.ts`), so the
  // two call sites MUST agree or `execute` misses the cache and builds a second
  // server from the default deps - `{ openSshTab: () => false }` and no disabled
  // list. That is what made `mcp__tedi__ssh` answer `{ok:true, opened}` while
  // opening nothing, and it re-registered every tool the packs had switched off.
  // It only bit once a pack was disabled, because until then both keys computed
  // the same empty variant.
  const builtinDeps: TediMcpDeps = { openSshTab: ctx.openSshTab, disabledTools };

  // Connect every server AT ONCE, then register in the fixed `enabled` order.
  // Serially awaiting each spawn + handshake + tools/list meant an `npx -y` cold
  // start was paid once per server before the first token of the turn. Settling
  // in parallel and registering afterwards keeps the resulting key order
  // deterministic, which is what a provider prompt cache keys on - a tool set
  // that reorders between turns re-prices the whole prefix.
  const connected = await Promise.allSettled(
    enabled.map((s) => getMcpClient(s, ctx.getCwd() ?? undefined, builtinDeps)),
  );

  for (const [i, server] of enabled.entries()) {
    const settled = connected[i];
    try {
      if (settled.status === "rejected") throw settled.reason;
      const client = settled.value;
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
        tools[aiName] = mcpToolToAiTool(
          mcpTool,
          server,
          ctx,
          server.builtin ? builtinDeps : undefined,
        );
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
