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

/** Persisted MCP server configs. Stored in its own LazyStore. */
const STORE_PATH = "tedi-mcp-servers.json";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

type StoreShape = Record<string, McpServerConfig>;

let cachedConfigs: StoreShape | null = null;

async function loadConfigs(): Promise<StoreShape> {
  if (cachedConfigs) return cachedConfigs;
  try {
    const raw = await store.get<StoreShape>("servers");
    cachedConfigs = raw ?? {};
  } catch {
    cachedConfigs = {};
  }
  return cachedConfigs;
}

async function saveConfigs(configs: StoreShape): Promise<void> {
  cachedConfigs = configs;
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

/** Toggle enabled state of an MCP server. */
export async function toggleMcpServer(name: string): Promise<boolean> {
  const configs = await loadConfigs();
  const config = configs[name];
  if (!config) return false;
  config.enabled = !config.enabled;
  await saveConfigs(configs);
  return config.enabled;
}
