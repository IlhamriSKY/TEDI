/**
 * TEDI's own control surface, served as a REAL MCP server inside the app.
 *
 * The built-in agent used to reach these through bespoke `tedi_*` tools, which
 * made TEDI the one capability in the picker that was not an MCP server - its
 * own category, sitting beside "MCP: chrome-devtools-mcp" and behaving
 * differently for no reason a user could see.
 *
 * This is not a rename. It is the actual protocol: an SDK `Server` answering
 * `tools/list` and `tools/call`, linked to the host's `Client` by
 * `InMemoryTransport`. The picker groups it as `MCP: tedi` because it genuinely
 * IS one, and every rule the host applies to an MCP server - approval on every
 * call, the 64-char tool-name clamp, the per-server group - applies unchanged.
 *
 * WHY IN-MEMORY AND NOT THE STDIO SERVER IN `scripts/mcp/`. That one is the
 * way IN from outside: it spawns node and drives the window over the WebView2
 * DevTools socket. For this agent the window is the one it is already running
 * in, so going through it would mean a subprocess and a socket round trip to
 * reach a function in the same JS realm, it would only work while the automation
 * port is open (off by default), and a page target accepts exactly ONE DevTools
 * client - so the built-in agent would be fighting the user's real CLI session
 * for it. Same protocol, same tools, no transport theatre.
 *
 * ONE DEFINITION, TWO TRANSPORTS - AND NOW ACTUALLY ONE. Names, descriptions and
 * schemas all come from `scripts/mcp/tools.mjs`, the same table the stdio
 * server serves. They used to be declared twice, and the copies drifted: `ssh`
 * meant `{action, id}` there and `{connectionId}` here, so an agent following
 * the advertised contract silently LISTED connections instead of opening one.
 * Only the handlers live here, because only the handlers are genuinely
 * different - these call the functions in their own realm.
 *
 * That is also why this uses the SDK's low-level `Server` rather than
 * `McpServer`: `McpServer` wants Zod, and its object parse STRIPS unknown keys,
 * which is precisely what turned the `ssh` mismatch into a plausible wrong
 * answer instead of an error. `Server` serves the shared JSON Schema verbatim
 * and hands arguments to the handler untouched.
 *
 * `Server` carries an `@deprecated` tag reading "Use `McpServer` instead for the
 * high-level API. Only use `Server` for advanced use cases." Serving a schema
 * that a second, non-TypeScript transport also serves IS that advanced case -
 * the high-level API cannot express it without a Zod round trip that changes the
 * contract. Do not "fix" this back to `McpServer` without also solving that.
 *
 * ONE SET OF SWITCHES. These tools are gated by the SAME pack switches the MCP
 * dialog writes to `mcpDisabledTools`. Turning the Settings pack off has to mean
 * TEDI's own agent loses `set_setting` too - that switch exists so a driving
 * agent cannot hand itself back a capability the user took away, and an
 * in-process bypass would be exactly the hole it was built to close.
 *
 * The set is deliberately a SUBSET of the stdio surface: only what the built-in
 * agent cannot already do. It has native tools for panes, terminals and files,
 * so mirroring `sh`, `read` or `focus_pane` would be duplication at a standing
 * token cost. What is left is the genuine gap - settings, commands, extensions
 * and SSH.
 *
 * SECURITY: no port, no subprocess, no IPC boundary - strictly less exposed than
 * the stdio path. Nothing here can read a secret: keys live in the OS keyring and
 * `getConnectionSecrets` is not imported. Every tool is approval-gated by the
 * host, exactly like any other MCP server (`tools/mcp.ts` sets
 * `needsApproval: true` for all of them).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFS, validateArgs } from "@mcp/tools.mjs";
import { readSettings, writeSetting } from "@/modules/settings/preferences";
import { controlExtension, listExtensions, runExtensionCommand } from "@/modules/extensions/store";
import { listCommands, runCommand } from "@/modules/shortcuts/lib/commandRegistry";
import { listConnections } from "@/modules/ssh/connections";

/** Becomes the `MCP: tedi` group and the `mcp__tedi__*` key prefix, so changing
 *  it renames every tool the model sees. */
export const TEDI_MCP_SERVER_NAME = "tedi";

/** Opening an SSH connection needs a tab, which only the app can make. Injected
 *  rather than imported: this module must not pull in React or the chat store,
 *  which would close an import cycle back through the tool builder. */
export type TediMcpDeps = {
  openSshTab: (connectionId: string, name: string, isPrivate?: boolean) => boolean;
  /** Resolved pack switches, from `getMcpSurface().disabledTools`. Same list the
   *  stdio server filters on. Absent means nothing is switched off. */
  disabledTools?: readonly string[];
};

/**
 * Cap on a single tool result, in characters.
 *
 * The stdio server caps its reads at 20 000 and says so in the schema; this side
 * had no cap at all, so `inspect settings` shipped the entire preference store
 * (custom theme, full terminal palette, every shortcut) and an extension AI tool
 * could return an unbounded query result straight into the context window. Same
 * number, so the same call costs the same on either transport.
 */
const MAX_RESULT_CHARS = 20000;

/** MCP replies are content blocks. Everything here answers with one JSON block. */
function json(value: unknown) {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n... truncated at ${MAX_RESULT_CHARS} characters. Ask for something narrower.`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/**
 * A failure the agent should read and act on.
 *
 * `isError` is the part that matters and the part that was missing. Every
 * business failure here used to return `json({ error })` - a SUCCESS envelope
 * whose text happened to contain the word "error". The host checks
 * `result.isError` (`tools/mcp.ts`), found it falsy, and rendered a failed call
 * as a completed one; the model had to notice the word in the JSON. The stdio
 * server got this right by throwing, which its dispatcher turns into `isError`.
 */
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Handlers, keyed by the name in `TOOL_DEFS`.
 *
 * Anything not listed here is a stdio-only tool: the built-in agent already has
 * a native tool for it (panes, terminals, files) and advertising a second copy
 * would cost tokens on every request to reach the same function.
 */
type Handler = (
  args: Record<string, unknown>,
  deps: TediMcpDeps,
) => Promise<ReturnType<typeof json> | ReturnType<typeof fail>>;

const HANDLERS: Record<string, Handler> = {
  inspect: async ({ what }) => {
    if (what === "commands") return json({ commands: listCommands() });
    if (what === "extensions") return json(listExtensions());
    if (what === "settings") return json(readSettings());
    // `logs` is in the shared schema because the stdio server reads the DevTools
    // console over CDP. There is no in-realm twin, and inventing one that
    // returned an empty list would read as "nothing was logged".
    return fail(
      'inspect "logs" reads the DevTools console, which only the stdio MCP server can do. From here, use commands, extensions or settings.',
    );
  },

  run_command: async ({ id, extensionId, args }) => {
    if (extensionId) {
      const out = await runExtensionCommand(
        String(extensionId),
        String(id),
        args as Record<string, unknown> | undefined,
      );
      if (!out) {
        return fail(
          `Nothing answers to "${id}" in ${extensionId}. It may be disabled, or the id was declared but never given a handler.`,
        );
      }
      return json(out.kind === "aiTool" ? { result: out.result } : { ok: true, ran: id });
    }
    return runCommand(id as Parameters<typeof runCommand>[0])
      ? json({ ok: true, ran: id })
      : fail(`No handler is registered for "${id}" right now.`);
  },

  set_setting: async ({ key, value }) => {
    const r = await writeSetting(String(key), value);
    return r === true ? json({ ok: true, key, value }) : fail(String(r));
  },

  extension: async ({ action, id }) => {
    const r = await controlExtension(action as Parameters<typeof controlExtension>[0], String(id));
    return r === true ? json({ ok: true, action, id }) : fail(String(r));
  },

  ssh: async ({ action, id, private: isPrivate }, deps) => {
    const conns = await listConnections();
    if (action === "list") {
      return json({
        connections: conns.map((c) => ({
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          user: c.user,
          authMode: c.authMode,
        })),
      });
    }
    if (!id) return fail('ssh "connect" needs `id` (from `ssh list`).');
    const conn = conns.find((c) => c.id === id);
    if (!conn) return fail(`No saved SSH connection "${id}".`);
    // The boolean was being DISCARDED, so a refused open still answered
    // `{ok:true, opened}`. That is how a stub `openSshTab` (the default deps
    // when a caller forgets to pass them) reported success on a tab that was
    // never created.
    if (!deps.openSshTab(conn.id, conn.name, isPrivate === true)) {
      return fail(`Could not open a tab for "${conn.name}".`);
    }
    return json({ ok: true, opened: conn.name, host: conn.host });
  },
};

// A handler whose name is not in the shared table would be silently dropped by
// the filter below - an unadvertised, uncallable tool that still looks present
// in this file. Fail at load instead, the same way `server.mjs` does for its half.
{
  const orphan = Object.keys(HANDLERS).filter((n) => !TOOL_DEFS[n]);
  if (orphan.length) {
    throw new Error(
      `tediMcpServer has handlers with no entry in scripts/mcp/tools.mjs: ${orphan.join(", ")}`,
    );
  }
}

/**
 * Build the in-process server and return the transport for the host's `Client`.
 * One linked pair per call; the caller owns the lifetime.
 */
export async function startTediMcpServer(deps: TediMcpDeps) {
  const server = new Server(
    { name: TEDI_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const off = new Set(deps.disabledTools ?? []);
  /** A disabled tool is neither advertised NOR callable. Both halves matter:
   *  hiding it from `tools/list` alone leaves it reachable by name, which is the
   *  bug the stdio server shipped with. */
  const available = Object.keys(HANDLERS).filter((name) => TOOL_DEFS[name] && !off.has(name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: available.map((name) => ({
      name,
      description: TOOL_DEFS[name].description,
      inputSchema: TOOL_DEFS[name].schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (off.has(name)) {
      return fail(
        `"${name}" is switched off for this MCP server. Turn its pack back on in TEDI: header, Install MCP.`,
      );
    }
    const handler = HANDLERS[name];
    if (!handler) return fail(`Unknown tool "${name}". Have: ${available.join(", ")}`);
    // Same shallow check the stdio server runs, from the same table, so a
    // malformed call is refused identically whichever server answers it.
    const bad = validateArgs(name, req.params.arguments);
    if (bad) return fail(bad);
    try {
      return await handler((req.params.arguments ?? {}) as Record<string, unknown>, deps);
    } catch (e) {
      return fail(e instanceof Error ? e.message : `"${name}" failed.`);
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}
