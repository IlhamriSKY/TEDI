import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * MCP Server configuration. Mirrors the standard MCP config format used by
 * Claude Desktop, VS Code Copilot, and other hosts.
 */
export type McpServerConfig = {
  /** Human-readable name (also the store key). */
  name: string;
  /** Command to spawn the server (e.g. `npx`, `node`, `python`). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Environment variables injected into the server process. */
  env?: Record<string, string>;
  /** Whether the server is enabled. */
  enabled: boolean;
  /** TEDI's own in-process server. No process is spawned: `command`/`args` are
   *  unused and the client is linked to it over an in-memory transport. Never
   *  persisted - it is synthesized per turn by `buildMcpToolsAsync`. */
  builtin?: boolean;
};

/**
 * Name of TEDI's own in-process server. Becomes the `MCP: tedi` group and the
 * `mcp__tedi__*` key prefix, so changing it renames every tool the model sees.
 *
 * IT LIVES HERE, not beside the server it names, and that is load-bearing. The
 * name is needed by UI as light as the `/mcp` list; taking it from
 * `tediMcpServer` would pull that module's whole dependency tree - the extension
 * store, the shell tools, the command registry - into the importer's graph, and
 * through the composer that closes a cycle. A cycle there does not warn: a
 * context object reads as undefined and the AI panel renders its error boundary.
 * This file is config with a single dependency, so nothing can cycle back.
 */
export const TEDI_MCP_SERVER_NAME = "tedi";

/**
 * Split a typed command line into command + args, honouring quotes. A plain
 * whitespace split turned `"C:/Users/IT STAFF/bin/fff.exe" mcp` into command
 * `"C:/Users/IT` - and opening Edit then Save on a working server did exactly
 * that to it, since the edit field is filled by joining with spaces.
 */
export function splitCommandLine(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The inverse, for filling the edit field: quote any part with whitespace. */
export function joinCommandLine(parts: string[]): string {
  return parts.map((p) => (/\s/.test(p) || p === "" ? `"${p}"` : p)).join(" ");
}

/** Persisted MCP server configs. Stored in its own LazyStore. */
const STORE_PATH = "tedi-mcp-servers.json";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

type StoreShape = Record<string, McpServerConfig>;

/**
 * NO cache on this side. Settings is its own webview and is where servers are
 * added, edited and switched off; a JS copy cached on first read meant none of
 * that reached the agent until a restart. The Rust store behind it is ONE
 * instance per path shared by every webview, so a plain `get` already sees
 * Settings' `set`. Do not `reload()` here: it merges the file on disk over that
 * shared copy and can undo a Settings write that has not been saved yet.
 */
async function loadConfigs(): Promise<StoreShape> {
  try {
    return (await store.get<StoreShape>("servers")) ?? {};
  } catch {
    return {};
  }
}

async function saveConfigs(configs: StoreShape): Promise<void> {
  await store.set("servers", configs);
  await store.save();
}

/** Get all MCP server configs. */
export async function getMcpServers(): Promise<McpServerConfig[]> {
  const configs = await loadConfigs();
  return Object.values(configs).sort((a, b) => a.name.localeCompare(b.name));
}

/** Save (create or update) an MCP server config. */
export async function saveMcpServer(config: McpServerConfig): Promise<void> {
  const configs = await loadConfigs();
  configs[config.name] = config;
  await saveConfigs(configs);
}

/** Remove an MCP server config by name. */
export async function removeMcpServer(name: string): Promise<void> {
  const configs = await loadConfigs();
  delete configs[name];
  await saveConfigs(configs);
}

/**
 * The master switch over every configured server, beside each server's own.
 *
 * Off means no configured server is started for any turn, the main agent's or a
 * sub-agent's, and whatever is running is stopped by the caller that flips it.
 * It deliberately leaves each server's `enabled` alone, so turning MCP back on
 * restores exactly the set that was on, instead of the user re-enabling servers
 * one by one after an off/on.
 *
 * TEDI's own `tedi` server is NOT under it. It runs in-process, so it costs no
 * process to switch off, and it is where the agent's terminal and pane tools
 * live; its tools are gated by the tool packs instead.
 */
const KEY_SERVERS_ENABLED = "serversEnabled";

export async function getMcpServersEnabled(): Promise<boolean> {
  try {
    return (await store.get<boolean>(KEY_SERVERS_ENABLED)) ?? true;
  } catch {
    return true;
  }
}

export async function setMcpServersEnabled(on: boolean): Promise<void> {
  await store.set(KEY_SERVERS_ENABLED, on);
  await store.save();
}

/** The configured servers a turn should connect: none while the master switch
 *  is off, otherwise the enabled ones, never a config shadowing the built-in. */
export function serversToConnect(
  servers: McpServerConfig[],
  serversEnabled: boolean,
): McpServerConfig[] {
  if (!serversEnabled) return [];
  return servers.filter((s) => s.enabled && s.name !== TEDI_MCP_SERVER_NAME);
}

/** Toggle enabled state of an MCP server. */
export async function toggleMcpServer(name: string): Promise<boolean> {
  const configs = await loadConfigs();
  const config = configs[name];
  if (!config) return false;
  config.enabled = !config.enabled;
  await saveConfigs(configs);
  return config.enabled;
}
