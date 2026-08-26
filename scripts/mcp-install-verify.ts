/**
 * Self-check for the "Install MCP" config writer.
 * Run: `npx tsx scripts/mcp-install-verify.ts` (or `pnpm verify`, which globs it).
 *
 * This code edits files it did not create, in the user's home directory, and two
 * of them are not small: `~/.claude.json` carries Claude Code's entire project
 * history, and `~/.codex/config.toml` carries every Codex setting the user has.
 * A merge bug here does not fail loudly - it silently replaces a config with a
 * two-line one, and the user finds out days later.
 *
 * So the checks are all about what SURVIVES, not about what is written:
 *
 *  1. Every unrelated key, and every sibling MCP server, is still there after an
 *     install - and after an uninstall.
 *  2. Installing twice leaves one entry, not two. Both formats: the JSON one is
 *     a keyed object and cannot duplicate, but the TOML one is text and can.
 *  3. A TOML table ends at the next `[header]`. Removing ours must take our
 *     block and stop, not run to the end of the file.
 *  4. A STALE entry - one pointing at a path an update replaced - must read as
 *     NOT installed, or the indicator shows a working integration that is not.
 */
import {
  _internals,
  PROJECT_TARGET,
  TARGETS,
  type Target,
} from "../src/modules/mcpInstall/install";

const { withEntry, withoutEntry, readsAsInstalled, entryFor } = _internals;

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};
const ok = (msg: string): void => console.log(`  ok: ${msg}`);

const SERVER = "C:/Program Files/TEDI/resources/director/mcp.mjs";
const OLD_SERVER = "C:/Users/x/old-tedi/scripts/director/mcp.mjs";
const PORT = 9222;

const byId = (id: string): Target => {
  const t = [...TARGETS, PROJECT_TARGET].find((x) => x.id === id);
  if (!t) throw new Error(`no target ${id}`);
  return t;
};

// ---------------------------------------------------------------------------
console.log("[mcpServers] an existing config survives the merge");
{
  // Shaped like a real `~/.claude.json`: our key is one of several, and most of
  // the file has nothing to do with MCP at all.
  const before = JSON.stringify(
    {
      numStartups: 412,
      projects: { "D:\\repo": { allowedTools: ["Bash"], history: [{ display: "hi" }] } },
      mcpServers: { other: { command: "npx", args: ["-y", "@some/server"] } },
    },
    null,
    2,
  );
  const after = withEntry(byId("claude"), before, SERVER, PORT);
  const json = JSON.parse(after) as {
    numStartups: number;
    projects: Record<string, unknown>;
    mcpServers: Record<string, unknown>;
  };

  if (json.numStartups !== 412) fail("dropped an unrelated top-level key");
  else if (!json.projects["D:\\repo"]) fail("dropped the projects tree");
  else ok("unrelated keys and the projects tree are untouched");

  if (!json.mcpServers.other) fail("dropped a sibling MCP server");
  else ok("a sibling MCP server survives");

  if (!readsAsInstalled(byId("claude"), after, SERVER)) fail("its own entry does not read back");
  else ok("the entry reads back as installed");

  // Idempotence, and the round trip.
  const twice = withEntry(byId("claude"), after, SERVER, PORT);
  if (twice !== after) fail("installing twice changed the file the second time");
  else ok("installing twice is a no-op");

  const removed = withoutEntry(byId("claude"), twice);
  const back = JSON.parse(removed) as { numStartups: number; mcpServers: Record<string, unknown> };
  if (back.mcpServers.tedi) fail("uninstall left the entry behind");
  else if (!back.mcpServers.other) fail("uninstall took a sibling server with it");
  else if (back.numStartups !== 412) fail("uninstall dropped an unrelated key");
  else ok("uninstall removes only our entry");
}

// ---------------------------------------------------------------------------
console.log("\n[mcpServers] an empty or missing file becomes a valid config");
{
  const fresh = withEntry(byId("cursor"), "", SERVER, PORT);
  const json = JSON.parse(fresh) as { mcpServers: Record<string, { args: string[] }> };
  if (json.mcpServers.tedi.args[0] !== SERVER)
    fail(`fresh file points at ${json.mcpServers.tedi.args[0]}`);
  else ok("a fresh config carries the resource path, not a repo path");
}

// ---------------------------------------------------------------------------
console.log("\n[codex] TOML edits stop at our own table");
{
  const before = [
    'model = "gpt-5"',
    'approval_policy = "on-request"',
    "",
    "[mcp_servers.other]",
    'command = "npx"',
    'args = ["-y", "@some/server"]',
    "",
    "[shell_environment_policy]",
    'inherit = "all"',
    "",
  ].join("\n");

  const after = withEntry(byId("codex"), before, SERVER, PORT);
  if (!after.includes('model = "gpt-5"')) fail("dropped a top-level key");
  else if (!after.includes("[mcp_servers.other]")) fail("dropped a sibling server table");
  else if (!after.includes("[shell_environment_policy]")) fail("dropped a later table");
  else ok("every other table survives the install");

  if (!after.includes("[mcp_servers.tedi]")) fail("did not write our table");
  else if (!after.includes(JSON.stringify(SERVER))) fail("path is not TOML-quoted");
  else ok("our table is written with a quoted path");

  // Text format: this is the one that can genuinely duplicate.
  const twice = withEntry(byId("codex"), after, SERVER, PORT);
  const count = (twice.match(/\[mcp_servers\.tedi\]/g) ?? []).length;
  if (count !== 1) fail(`installing twice left ${count} [mcp_servers.tedi] tables`);
  else ok("installing twice leaves exactly one table");

  const removed = withoutEntry(byId("codex"), twice);
  if (removed.includes("[mcp_servers.tedi]")) fail("uninstall left our table header");
  // The header AND the body. Dropping only the header leaves orphaned keys that
  // TOML then reads as belonging to whatever table precedes them - which is a
  // worse outcome than not removing anything.
  else if (removed.includes(SERVER)) fail("uninstall left our table's body behind");
  else if (!removed.includes("[shell_environment_policy]")) {
    fail("uninstall ran past our table and ate the rest of the file");
  } else if (!removed.includes("[mcp_servers.other]")) fail("uninstall took the sibling table");
  else if (!removed.includes("approval_policy")) fail("uninstall dropped a top-level key");
  else ok("uninstall takes our table header AND body, stopping at the next header");
}

// ---------------------------------------------------------------------------
console.log("\n[codex] a server owns its NESTED sub-tables too");
{
  // Shaped from a real `~/.codex/config.toml`, which carried
  // `[mcp_servers.chrome-devtools]` followed by EIGHT
  // `[mcp_servers.chrome-devtools.tools.*]` sub-tables - Codex's per-tool
  // settings. A rule that stops at the first line-initial `[` removes our header
  // and leaves those behind, re-parented to whatever server precedes them. That
  // is silent corruption of a config we were asked to tidy up.
  const before = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.tedi]",
    'command = "node"',
    `args = ["${OLD_SERVER}"]`,
    "",
    "[mcp_servers.tedi.tools.sh]",
    "enabled = true",
    "",
    "[mcp_servers.tedi.tools.state]",
    "enabled = false",
    "",
    "[mcp_servers.other]",
    'command = "npx"',
    "",
  ].join("\n");

  const removed = withoutEntry(byId("codex"), before);
  if (removed.includes("[mcp_servers.tedi]")) fail("uninstall left our header");
  else if (removed.includes("mcp_servers.tedi.tools")) {
    fail("uninstall ORPHANED our nested sub-tables onto the preceding server");
  } else if (!removed.includes("[mcp_servers.other]")) fail("uninstall ate the next server");
  else if (!removed.includes('model = "gpt-5"')) fail("uninstall dropped a top-level key");
  else ok("nested sub-tables go with their server, and the next server survives");

  // Re-install must replace the whole thing, not append beside the orphans.
  const reinstalled = withEntry(byId("codex"), before, SERVER, PORT);
  if (reinstalled.includes("mcp_servers.tedi.tools")) {
    fail("re-install left stale sub-tables from the previous entry");
  } else if ((reinstalled.match(/\[mcp_servers\.tedi\]/g) ?? []).length !== 1) {
    fail("re-install did not replace the old entry");
  } else if (!reinstalled.includes("[mcp_servers.other]")) fail("re-install ate the next server");
  else ok("re-install replaces the server and its sub-tables as one unit");
}

// ---------------------------------------------------------------------------
console.log("\n[codex] our table can also be in the MIDDLE of the file");
{
  // The case that actually distinguishes a bounded match from a greedy one, and
  // the one every other check here missed: `withEntry` appends, so in a file it
  // wrote, our table is always LAST - and removing "to the end of the file" then
  // looks exactly like removing our table. A hand-written config puts it
  // wherever the user put it, and everything after it is what a greedy rule
  // eats. Mutation testing is what surfaced this; the earlier checks all passed
  // against a deliberately greedy regex.
  const before = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.tedi]",
    'command = "node"',
    `args = ["${OLD_SERVER}"]`,
    "",
    "[mcp_servers.other]",
    'command = "npx"',
    "",
    "[shell_environment_policy]",
    'inherit = "all"',
    "",
  ].join("\n");

  const removed = withoutEntry(byId("codex"), before);
  if (removed.includes("[mcp_servers.tedi]")) fail("uninstall left our table");
  else if (!removed.includes("[mcp_servers.other]")) fail("uninstall ate the table AFTER ours");
  else if (!removed.includes("[shell_environment_policy]"))
    fail("uninstall ate the rest of the file");
  else ok("removing a mid-file table leaves everything after it");

  // Same for install, which strips before it appends.
  const reinstalled = withEntry(byId("codex"), before, SERVER, PORT);
  if (!reinstalled.includes("[shell_environment_policy]")) {
    fail("re-install ate the tables after our old one");
  } else if ((reinstalled.match(/\[mcp_servers\.tedi\]/g) ?? []).length !== 1) {
    fail("re-install did not replace the old table in place");
  } else if (reinstalled.includes(OLD_SERVER)) fail("re-install left the stale path");
  else ok("re-installing over a mid-file table replaces it and keeps the rest");
}

// ---------------------------------------------------------------------------
console.log("\n[codex] our table can be the LAST thing in the file");
{
  // The dangerous ordering for a "runs to the next header" rule: there is no
  // next header, so a greedy match has nothing to stop it.
  const before = `model = "gpt-5"\n\n[mcp_servers.tedi]\ncommand = "node"\nargs = ["${OLD_SERVER}"]\n`;
  const removed = withoutEntry(byId("codex"), before);
  if (removed.includes("mcp_servers.tedi")) fail("uninstall left a trailing table");
  else if (!removed.includes('model = "gpt-5"')) fail("uninstall ate the keys above it");
  else ok("a trailing table is removed without touching what precedes it");
}

// ---------------------------------------------------------------------------
console.log("\n[stale] an entry pointing at an old install is NOT installed");
{
  // What an app update does: the resource path moves, the config still holds the
  // previous one, and every call through it fails. Reporting that as installed
  // is worse than reporting it as absent, because the fix (click install again)
  // is the thing the indicator would be hiding.
  const stale = JSON.stringify({ mcpServers: { tedi: { command: "node", args: [OLD_SERVER] } } });
  if (readsAsInstalled(byId("claude"), stale, SERVER)) fail("a stale path read as installed");
  else ok("a stale path reads as not installed, so the button offers to fix it");

  const staleToml = `[mcp_servers.tedi]\ncommand = "node"\nargs = ["${OLD_SERVER}"]\n`;
  if (readsAsInstalled(byId("codex"), staleToml, SERVER))
    fail("a stale TOML path read as installed");
  else ok("same for TOML");

  if (readsAsInstalled(byId("claude"), "{ not json", SERVER))
    fail("unparseable JSON read as installed");
  else ok("an unparseable config reads as not installed rather than throwing");
}

// ---------------------------------------------------------------------------
console.log("\n[opencode] gets its own entry shape, not the standard one");
{
  const after = withEntry(byId("opencode"), "", SERVER, PORT);
  const json = JSON.parse(after) as { mcp?: Record<string, { type?: string; command?: string[] }> };
  if (!json.mcp) fail(`opencode entry landed under ${Object.keys(json).join(", ")}, want "mcp"`);
  else if (json.mcp.tedi?.type !== "local") fail("opencode entry is missing type:local");
  else if (json.mcp.tedi.command?.[0] !== "node") fail("opencode command is not an argv array");
  else ok('opencode gets { mcp: { tedi: { type: "local", command: [...] } } }');

  const std = entryFor("mcpServers", SERVER, PORT) as { env: Record<string, string> };
  if (std.env.TEDI_DEBUG_PORT !== String(PORT)) fail("the standard entry lost its port env");
  else ok("the port reaches the server process as TEDI_DEBUG_PORT");
}

// ---------------------------------------------------------------------------
console.log("\n[targets] every target is probed before anything is written");
{
  for (const t of TARGETS) {
    // A target with no probe would have its config CREATED for a CLI the user
    // never installed, scattering files that tool will never read.
    if (!t.probes.length) fail(`${t.id} has no probe path`);
    if (!t.file) fail(`${t.id} has no config file`);
  }
  ok(`${TARGETS.length} CLI targets, all probed before writing`);
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nmcp-install: all checks passed");
