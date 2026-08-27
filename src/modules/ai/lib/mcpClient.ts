import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TauriStdioTransport } from "./mcpTransport";
import { startTediMcpServer, type TediMcpDeps } from "./tediMcpServer";
import type { McpServerConfig } from "./mcpConfig";

// Monotonic suffix so each connection gets a distinct backend process key,
// even across reconnects of the same server name.
let connSeq = 0;

/**
 * Lightweight MCP client wrapper. Each instance manages one stdio connection to
 * an MCP server process. Designed to be created/destroyed per-agent-turn so
 * that tool lists are always fresh.
 */
export class McpClient {
  private client: Client;
  private readonly id: string;
  private _connected = false;
  private _tools: McpTool[] = [];
  private _serverInfo: { name: string; version: string } | null = null;
  private _inFlight = 0;

  constructor(
    private config: McpServerConfig,
    private cwd?: string,
    private builtinDeps?: TediMcpDeps,
  ) {
    this.id = `${config.name}#${++connSeq}`;
    this.client = new Client({ name: "tedi-mcp-host", version: "1.0.0" }, { capabilities: {} });
  }

  /** Connect to the MCP server: in-memory for the built-in one, stdio for the
   *  rest. Everything after this point is identical for both - same handshake,
   *  same `listTools`, same reconnect-on-close. */
  async connect(): Promise<void> {
    if (this._connected) return;

    const transport = this.config.builtin
      ? (await startTediMcpServer(this.builtinDeps ?? { openSshTab: () => false })).clientTransport
      : new TauriStdioTransport({
          id: this.id,
          command: this.config.command,
          args: this.config.args,
          env: this.config.env,
          cwd: this.cwd,
        });

    // A crashed/self-exited server fires transport.onclose -> client.onclose.
    // Flip our flag (and drop stale tools) so getMcpClient reconnects next turn
    // instead of reusing a dead client whose callTool always fails.
    this.client.onclose = () => {
      this._connected = false;
      this._tools = [];
    };

    // Client.connect() calls transport.start() internally (which spawns the
    // server process); stderr is drained backend-side, so nothing to wire here.
    try {
      await this.client.connect(transport);

      // Fetch server info (optional) and tools.
      try {
        const serverInfo = this.client.getServerVersion();
        if (serverInfo) this._serverInfo = serverInfo;
      } catch {
        // Some servers don't report version.
      }

      const toolsResult = await this.client.listTools();
      this._tools = toolsResult.tools;
      this._connected = true;
    } catch (e) {
      // Handshake/listTools failed after the process was spawned. disconnect()
      // early-returns while _connected is false, so close here to kill the
      // orphaned process rather than leaking it.
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      // Surface the server's own stderr (missing key / bad arg / crash) which is
      // otherwise lost behind a generic "connection closed" / handshake timeout.
      // Only a spawned server has stderr; the built-in one throws in-realm.
      const tail = transport instanceof TauriStdioTransport ? transport.lastStderr.trim() : "";
      if (tail) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`${msg}\nServer stderr:\n${tail}`);
      }
      throw e;
    }
  }

  /** Closes the connection and terminates the server process. Safe to call at
   *  any lifecycle point: while connect() is still in flight, after a prior
   *  close, or on a connection that never opened. close() is idempotent, and
   *  always invoking it prevents an interrupted connect from leaking the
   *  spawned process. */
  async disconnect(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Ignore close errors.
    }
    this._connected = false;
  }

  /** Whether the client is connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** True while a tool call is in flight, so idle eviction won't kill a long
   *  call (a >5min crawl/query) when a concurrent turn triggers the sweep. */
  get busy(): boolean {
    return this._inFlight > 0;
  }

  /** List of tools exposed by this server. */
  get tools(): McpTool[] {
    return this._tools;
  }

  /** Server name/version (if reported). */
  get serverInfo(): { name: string; version: string } | null {
    return this._serverInfo;
  }

  /** Call a tool on the MCP server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this._connected) {
      throw new Error(`MCP server "${this.config.name}" is not connected.`);
    }
    this._inFlight++;
    try {
      return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    } finally {
      this._inFlight--;
    }
  }
}

/**
 * Active MCP connections, keyed `name + " " + cwd` so two workspaces or
 * concurrent subagents never share one server pinned to the first caller's cwd.
 * A server name has no spaces, so refreshMcpTools' prefix match is unambiguous.
 * Idle clients are reclaimed on-call and by the timed sweeper below.
 */
const activeClients = new Map<string, { client: McpClient; lastUsed: number }>();
// In-flight connects keyed the same way so concurrent callers (a turn and an
// open tool picker both calling buildMcpToolsAsync) share one connection
// instead of each spawning a process and orphaning one.
const connecting = new Map<string, Promise<McpClient>>();
// Per-key connect generation: bumped by refreshMcpTools so an in-flight connect
// can detect it was superseded (edit/disable/remove) and discard itself instead
// of publishing a now-stale client.
const connectGen = new Map<string, number>();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Cache key: a server reused under a different cwd must be a distinct process. */
// The built-in server registers a DIFFERENT tool set per pack-switch state, so
// that state belongs in the key: flipping a switch must yield a new client, not
// a cached one still advertising the tools the user just turned off.
const clientKey = (name: string, cwd?: string, variant?: string): string =>
  `${name}\x1f${cwd ?? ""}\x1f${variant ?? ""}`;

/** Disconnect + drop every idle, not-busy client. Skips a client with a tool
 *  call in flight so a long-running call isn't killed mid-flight. */
function sweepIdleClients(): void {
  const now = Date.now();
  for (const [key, entry] of activeClients.entries()) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS && !entry.client.busy) {
      void entry.client.disconnect();
      activeClients.delete(key);
    }
  }
}
// Timed sweep: the on-call sweep alone left an idle process alive until the next
// connect (or app exit). This reclaims it on schedule.
setInterval(sweepIdleClients, IDLE_TIMEOUT_MS);

/**
 * Get or create an MCP client for a server config + cwd. Reuses an existing live
 * connection; dedups concurrent connects.
 */
export async function getMcpClient(
  config: McpServerConfig,
  cwd?: string,
  builtinDeps?: TediMcpDeps,
): Promise<McpClient> {
  sweepIdleClients();
  const key = clientKey(
    config.name,
    cwd,
    config.builtin ? [...(builtinDeps?.disabledTools ?? [])].sort().join(",") : undefined,
  );

  const existing = activeClients.get(key);
  if (existing && existing.client.connected) {
    existing.lastUsed = Date.now();
    return existing.client;
  }
  // Disconnect stale client if present.
  if (existing) {
    void existing.client.disconnect();
    activeClients.delete(key);
  }

  // Share a single in-flight connect per key (dedup the parallel callers).
  const pending = connecting.get(key);
  if (pending) return pending;

  // Stamp this connect with a generation; refreshMcpTools bumps it to supersede.
  const myGen = (connectGen.get(key) ?? 0) + 1;
  connectGen.set(key, myGen);
  const promise = (async () => {
    const client = new McpClient(config, cwd, builtinDeps);
    await client.connect();
    // If a refresh (edit/disable/remove) superseded this connect mid-flight,
    // don't publish the now-stale client — disconnect it instead.
    if (connectGen.get(key) !== myGen) {
      await client.disconnect();
      return client;
    }
    activeClients.set(key, { client, lastUsed: Date.now() });
    return client;
  })();
  connecting.set(key, promise);
  try {
    return await promise;
  } finally {
    if (connecting.get(key) === promise) connecting.delete(key);
  }
}

/** Drop a server's cached connections (every cwd) so the next turn reconnects and
 *  re-fetches its tool list. Call after a server's config is edited/removed. */
/**
 * Disconnect every live MCP server. Called on quit.
 *
 * Nothing did this. `useQuitGuard` kills the daemon PTY sessions and flushes the
 * chat store, and MCP was simply not on the list - so on macOS and Linux every
 * server TEDI had spawned outlived it. Windows got away with it because each
 * child is in a kill-on-close Job Object; elsewhere the child is its own process
 * group leader (so it does not even receive the terminal's SIGHUP) and
 * `Drop for McpProc` never runs, because `PROCS` is a `static` that is never
 * dropped at exit.
 *
 * Best-effort and bounded by the caller: a server that ignores stdin EOF must
 * not hold the window open. Each `disconnect()` ends in `mcp_kill`, which kills
 * the process group, so a hung close still reaps.
 */
export async function disconnectAllMcpClients(): Promise<void> {
  const clients = [...activeClients.values()].map((e) => e.client);
  activeClients.clear();
  connecting.clear();
  await Promise.allSettled(clients.map((c) => c.disconnect()));
}

export async function refreshMcpTools(serverName: string): Promise<void> {
  const prefix = `${serverName}\x1f`;
  for (const [key, entry] of activeClients.entries()) {
    if (key.startsWith(prefix)) {
      void entry.client.disconnect();
      activeClients.delete(key);
    }
  }
  for (const key of [...connecting.keys()]) {
    if (key.startsWith(prefix)) connecting.delete(key);
  }
  // Bump the generation so any connect still in flight for this server discards
  // itself instead of publishing a client built from the now-stale config.
  for (const key of [...connectGen.keys()]) {
    if (key.startsWith(prefix)) connectGen.set(key, (connectGen.get(key) ?? 0) + 1);
  }
}

export type McpValidation =
  | { ok: true; toolCount: number }
  // `reason` separates the two failure modes the UI surfaces differently:
  // "spawn" means the command could not launch (missing binary or not on PATH);
  // "handshake" means it launched but never completed the MCP protocol (wrong
  // program, missing credentials or arguments, crash, or hang).
  | { ok: false; reason: "spawn" | "handshake"; error: string };

/**
 * Validate a server config by spawning it and completing the MCP handshake, so
 * a working server is distinguishable from an arbitrary command. Uses a
 * throwaway client and races a timeout, so a process that starts but never
 * speaks MCP can neither stall the check nor pollute the cache. Resolves with
 * the tool count or a typed failure.
 */
export async function validateMcpServer(
  config: McpServerConfig,
  cwd?: string,
  // 30s accommodates an `npx -y` first run that downloads the package before it
  // responds; raise it if a slow registry causes false timeouts.
  timeoutMs = 30_000,
): Promise<McpValidation> {
  const client = new McpClient(config, cwd);
  const connectPromise = client.connect();
  // If the timeout wins the race below, connect() can still reject afterwards;
  // attach a no-op catch so that late rejection is not reported as unhandled.
  connectPromise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${Math.round(timeoutMs / 1000)}s. The process started but never completed the MCP handshake (is it really an MCP server?).`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, toolCount: client.tools.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // mcp_spawn reports "spawn failed: ..." / ENOENT / "no such file" / the
    // Windows "cannot find" phrasing when the command can't launch. Anchor to
    // those: a bare "not found" also matches the JSON-RPC "Method not found"
    // that a launched-but-incomplete server throws, which is a HANDSHAKE failure.
    const reason = /spawn failed|enoent|empty command|no such file|cannot find/i.test(error)
      ? "spawn"
      : "handshake";
    return { ok: false, reason, error };
  } finally {
    if (timer) clearTimeout(timer);
    await client.disconnect();
  }
}
