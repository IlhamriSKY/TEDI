import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TauriStdioTransport } from "./mcpTransport";
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

  constructor(
    private config: McpServerConfig,
    private cwd?: string,
  ) {
    this.id = `${config.name}#${++connSeq}`;
    this.client = new Client({ name: "tedi-mcp-host", version: "1.0.0" }, { capabilities: {} });
  }

  /** Connect to the MCP server via stdio. */
  async connect(): Promise<void> {
    if (this._connected) return;

    const transport = new TauriStdioTransport({
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
    return this.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  }
}

/**
 * Cache of active MCP client connections. Keyed by server name so that
 * multiple agent turns can reuse the same connection. Clients are
 * auto-disconnected after a timeout of inactivity.
 */
const activeClients = new Map<string, { client: McpClient; lastUsed: number }>();
// In-flight connects keyed by server name so concurrent callers (transport.ts
// runs buildMcpToolsAsync + getMcpToolsSummary in parallel) share one
// connection instead of each spawning a process and orphaning one.
const connecting = new Map<string, Promise<McpClient>>();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get or create an MCP client for a server config. Reuses existing
 * connections if available and still valid.
 */
export async function getMcpClient(config: McpServerConfig, cwd?: string): Promise<McpClient> {
  // Clean up idle clients.
  const now = Date.now();
  for (const [name, entry] of activeClients.entries()) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      void entry.client.disconnect();
      activeClients.delete(name);
    }
  }

  const existing = activeClients.get(config.name);
  if (existing && existing.client.connected) {
    existing.lastUsed = now;
    return existing.client;
  }

  // Disconnect stale client if present.
  if (existing) {
    void existing.client.disconnect();
    activeClients.delete(config.name);
  }

  // Share a single in-flight connect per server name (dedup the parallel
  // buildMcpToolsAsync + getMcpToolsSummary callers).
  const pending = connecting.get(config.name);
  if (pending) return pending;

  const promise = (async () => {
    const client = new McpClient(config, cwd);
    await client.connect();
    activeClients.set(config.name, { client, lastUsed: Date.now() });
    return client;
  })();
  connecting.set(config.name, promise);
  try {
    return await promise;
  } finally {
    connecting.delete(config.name);
  }
}

/** Drop a server's cached connection so the next turn reconnects and re-fetches
 *  its tool list. Call after a server's config is edited/removed in settings. */
export async function refreshMcpTools(serverName: string): Promise<void> {
  const entry = activeClients.get(serverName);
  if (entry) {
    void entry.client.disconnect();
    activeClients.delete(serverName);
  }
  connecting.delete(serverName);
}

export type McpValidation =
  | { ok: true; toolCount: number }
  // `reason` separates the two failure modes the UI surfaces differently:
  // "spawn" means the command could not launch (missing binary or not on PATH);
  // "handshake" means it launched but never completed the MCP protocol (wrong
  // program, missing credentials or arguments, crash, or hang).
  | { ok: false; reason: "spawn" | "handshake"; error: string };

/**
 * Validates a server config by spawning the process and completing the MCP
 * handshake, letting callers distinguish a working server from an arbitrary
 * command. Runs against a throwaway client rather than the shared connection
 * cache and races the handshake against a timeout, so a process that starts but
 * never speaks MCP cannot stall the check or pollute the cache. Resolves with
 * the advertised tool count, or a typed failure reason.
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
    // mcp_spawn reports "spawn failed: ..." (and OS "not found" / ENOENT) when
    // the command cannot launch; any other error means it launched but the
    // protocol did not complete.
    const reason = /spawn failed|not found|enoent|empty command/i.test(error)
      ? "spawn"
      : "handshake";
    return { ok: false, reason, error };
  } finally {
    if (timer) clearTimeout(timer);
    await client.disconnect();
  }
}
