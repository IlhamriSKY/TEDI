/**
 * Self-check for the MCP servers master switch.
 * Run: `npx tsx scripts/ai/mcp-master-switch-verify.ts` (part of `pnpm verify`).
 *
 * One switch in Settings -> Agents -> MCP Servers turns every configured server
 * off without touching each server's own setting. What has to stay true:
 *  1. Off connects NO configured server; on connects exactly the enabled ones,
 *     and a config can never shadow the built-in `tedi` server.
 *  2. Every turn - the main agent's and a sub-agent's - goes through that gate,
 *     because both build their MCP tools in `buildMcpToolsAsync`.
 *  3. A missing setting means ON, so nobody's servers stop after an update.
 *  4. Switching off stops running servers now, not at the 5-minute idle sweep.
 *  5. `/mcp` does not report a server as on while the master switch is off.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: { invoke: async () => null, transformCallback: () => 0 },
};
const { serversToConnect, TEDI_MCP_SERVER_NAME } =
  await import("../../src/modules/ai/lib/mcpConfig");

console.log("1. the gate");
{
  const s = (name: string, enabled: boolean) => ({ name, command: "x", args: [], enabled });
  const all = [s("fff", true), s("chrome-devtools-mcp", false), s(TEDI_MCP_SERVER_NAME, true)];
  assert(serversToConnect(all, false).length === 0, "off: no configured server is connected");
  const on = serversToConnect(all, true).map((x) => x.name);
  assert(on.length === 1 && on[0] === "fff", "on: exactly the enabled servers");
  assert(!on.includes(TEDI_MCP_SERVER_NAME), "a config named like the built-in never shadows it");
}

console.log("2. every turn goes through it");
{
  const mcp = read("src/modules/ai/tools/mcp.ts");
  assert(/getMcpServersEnabled\(\)/.test(mcp), "buildMcpToolsAsync reads the switch");
  assert(
    /\.\.\.serversToConnect\(servers, serversEnabled\)/.test(mcp),
    "and builds its server list through the gate",
  );
  assert(
    !/servers\.filter\(\(s\) => s\.enabled/.test(mcp),
    "no second, ungated filter over the configured servers",
  );
}

console.log("3. a missing setting means on");
{
  const cfg = read("src/modules/ai/lib/mcpConfig.ts");
  assert(
    /store\.get<boolean>\(KEY_SERVERS_ENABLED\)\) \?\? true/.test(cfg),
    "an absent key reads as enabled",
  );
  assert(/catch \{\s*return true;/.test(cfg), "and so does an unreadable store");
}

console.log("4. switching off stops what is running");
{
  const card = read("src/settings/sections/components/McpServersCard.tsx");
  assert(
    /if \(!on\) for \(const s of servers\) void refreshMcpTools\(s\.name\);/.test(card),
    "the card disconnects every configured server when turned off",
  );
  assert(/<Switch[\s\S]*?checked=\{serversEnabled\}/.test(card), "the switch shows the setting");
}

console.log("5. /mcp tells the truth");
{
  const slash = read("src/modules/ai/lib/slashCommands.ts");
  assert(
    /enabled: serversOn && s\.enabled/.test(slash),
    "a server under an off switch lists as off",
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: mcp-master-switch-verify`);
process.exit(failed === 0 ? 0 : 1);
