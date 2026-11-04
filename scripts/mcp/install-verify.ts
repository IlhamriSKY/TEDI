/**
 * Self-check for the "Install MCP" config writer.
 * Run: `npx tsx scripts/mcp/install-verify.ts` (or `pnpm verify`, which globs it).
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
import { _internals, TARGETS, type Target } from "../../src/modules/mcpInstall/install";

const { withEntry, withoutEntry, readsAsInstalled, entryFor } = _internals;

console.log("[hermes] a hand-edited config.yaml survives, comments included");
{
  const hermes = TARGETS.find((x) => x.id === "hermes") as Target;
  const server = "C:/Program Files/TEDI/mcp/server.mjs";
  const bundle = "id.ilhamrisky.tedi";
  const check = (label: string, cond: boolean, detail?: string) => {
    if (cond) console.log(`  ok: ${label}`);
    else {
      console.error(`  FAIL: ${label}`, detail ?? "");
      process.exitCode = 1;
      throw new Error(label);
    }
  };
  const before = [
    "# my hermes",
    "model:",
    "  default: nous/hermes-4 # the good one",
    "",
    "# servers I use",
    "mcp_servers:",
    "    github:",
    '        command: "npx"',
    '        args: ["-y", "@modelcontextprotocol/server-github"]',
    "",
    "# terminal settings",
    "terminal:",
    "  backend: local",
    "",
  ].join("\n");
  const after = withEntry(hermes, before, server, bundle);
  for (const kept of before.split("\n").filter(Boolean)) {
    check(`keeps "${kept.trim()}"`, after.includes(kept));
  }
  check("reads back as installed", readsAsInstalled(hermes, after, server, bundle), after);
  check("follows the file's own indent", after.includes("\n    tedi:\n        command:"), after);
  check(
    "lands inside mcp_servers, before the next key",
    after.indexOf("tedi:") > after.indexOf("mcp_servers:") &&
      after.indexOf("tedi:") < after.indexOf("# terminal settings"),
    after,
  );
  check(
    "a Windows path stays one string",
    after.includes('args: ["C:/Program Files/TEDI/mcp/server.mjs"]'),
    after,
  );
  check(
    "installing twice leaves one entry",
    withEntry(hermes, after, server, bundle) === after,
    withEntry(hermes, after, server, bundle),
  );
  const moved = withEntry(hermes, after, "D:/new/server.mjs", bundle);
  check("a stale path is replaced", moved.includes("D:/new") && !moved.includes(server), moved);
  check(
    "and a stale entry reads as not installed",
    !readsAsInstalled(hermes, after, "D:/new/server.mjs", bundle),
  );
  check(
    "removing it restores the file",
    withoutEntry(hermes, after) === before,
    withoutEntry(hermes, after),
  );

  const fresh = withEntry(hermes, "", server, bundle);
  check("an empty file gets the key", fresh.startsWith("mcp_servers:\n  tedi:\n"), fresh);
  check(
    "removing the only server leaves an empty map",
    /^mcp_servers: \{\}/m.test(withoutEntry(hermes, fresh)),
    withoutEntry(hermes, fresh),
  );

  const noKey = "model:\n  default: x\n";
  const added = withEntry(hermes, noKey, server, bundle);
  check(
    "no key yet appends one",
    added.startsWith(noKey) && /\nmcp_servers:\n  tedi:/.test(added),
    added,
  );

  for (const empty of [
    "mcp_servers: {}\n",
    "mcp_servers: null\nother: 1\n",
    "mcp_servers:\nother: 1\n",
  ]) {
    const out = withEntry(hermes, empty, server, bundle);
    check(`${JSON.stringify(empty)} takes the entry`, /^mcp_servers:\n  tedi:/m.test(out), out);
  }
  let refused = false;
  try {
    withEntry(hermes, "mcp_servers: { a: { command: x } }\n", server, bundle);
  } catch {
    refused = true;
  }
  check("a flow mapping with servers in it is left alone", refused);

  const crlf = before.replaceAll("\n", "\r\n");
  const crlfAfter = withEntry(hermes, crlf, server, bundle);
  check("CRLF stays CRLF", !/[^\r]\n/.test(crlfAfter), JSON.stringify(crlfAfter));
  check("and removes cleanly", withoutEntry(hermes, crlfAfter) === crlf);

  for (const form of [
    '"mcp_servers":\n  a:\n    command: x\n',
    "mcp_servers :\n  a:\n    command: x\n",
    "\uFEFFmcp_servers:\n  a:\n    command: x\n",
  ]) {
    const out = withEntry(hermes, form, server, bundle);
    check(
      `${JSON.stringify(form.slice(0, 16))} gets no second key`,
      (out.match(/mcp_servers/g) ?? []).length === 1 &&
        out.includes("command: x") &&
        readsAsInstalled(hermes, out, server, bundle),
      out,
    );
  }
  let flow = false;
  try {
    withoutEntry(hermes, "mcp_servers:\n  tedi: {\n    command: x\n  }\n");
  } catch {
    flow = true;
  }
  check("a flow-style entry of ours is refused, not half cut", flow);

  const commented = "mcp_servers:\n  # tedi:\n  a:\n    command: x\n";
  check("a commented-out tedi is not ours", !readsAsInstalled(hermes, commented, server, bundle));
  check("nothing of ours means nothing changes", withoutEntry(hermes, commented) === commented);
}

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};
const ok = (msg: string): void => console.log(`  ok: ${msg}`);

const SERVER = "C:/Program Files/TEDI/resources/mcp/server.mjs";
const OLD_SERVER = "C:/Users/x/old-tedi/scripts/mcp/server.mjs";
/** The installing app's own bundle id. The bridge and the pack switches both live
 *  in a directory named by it, so a config without it read another app's switches
 *  and toggling a pack changed nothing the CLI could see. */
const BUNDLE = "id.ilhamrisky.tedi";

const byId = (id: string): Target => {
  const t = TARGETS.find((x) => x.id === id);
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
  const after = withEntry(byId("claude"), before, SERVER, BUNDLE);
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

  if (!readsAsInstalled(byId("claude"), after, SERVER, BUNDLE))
    fail("its own entry does not read back");
  else ok("the entry reads back as installed");

  // The bundle id picks which app to reach and whose pack switches to read.
  if (!JSON.stringify(json.mcpServers.tedi).includes("TEDI_BUNDLE_ID"))
    fail("the entry does not carry TEDI_BUNDLE_ID - pack toggles will not reach the CLI");
  else ok("the entry names the profile whose switches it reads");

  // An entry written before the id was stamped, or by the OTHER build, has to
  // read as NOT installed, so the button offers to fix it instead of showing a
  // green light on a config that reads the wrong profile.
  const noBundle = after.replace(/,?\s*"TEDI_BUNDLE_ID":\s*"[^"]*"/, "");
  if (readsAsInstalled(byId("claude"), noBundle, SERVER, BUNDLE))
    fail("an entry with no bundle id read as installed");
  else ok("an entry with no bundle id reads as stale, so the button offers to fix it");

  // Idempotence, and the round trip.
  const twice = withEntry(byId("claude"), after, SERVER, BUNDLE);
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
// `claude mcp add` writes to the PROJECT bag by default ("local" scope), not to
// the top-level one. Reading only the top level made the switch show OFF while
// Claude Code loaded TEDI on every session from that bag, and turning it off
// then removed nothing - the user's report that "the MCP is on even though I
// switched it off".
console.log("\n[mcpServers] the per-project scope of ~/.claude.json counts too");
{
  const localScope = JSON.stringify(
    {
      numStartups: 412,
      mcpServers: { other: { command: "npx", args: ["-y", "@some/server"] } },
      projects: {
        "D:\\repo": {
          history: [{ display: "hi" }],
          mcpServers: {
            tedi: entryFor("mcpServers", SERVER, BUNDLE),
            keepme: { command: "node", args: ["x.mjs"] },
          },
        },
      },
    },
    null,
    2,
  );

  if (!readsAsInstalled(byId("claude"), localScope, SERVER, BUNDLE))
    fail("a project-scoped entry read as NOT installed - the switch would lie");
  else ok("a project-scoped entry reads as installed");

  const removed = withoutEntry(byId("claude"), localScope);
  const back = JSON.parse(removed) as {
    numStartups: number;
    mcpServers: Record<string, unknown>;
    projects: Record<string, { mcpServers: Record<string, unknown>; history: unknown }>;
  };
  if (back.projects["D:\\repo"].mcpServers.tedi)
    fail("uninstall left the project-scoped entry behind");
  else if (!back.projects["D:\\repo"].mcpServers.keepme)
    fail("uninstall took a sibling project-scoped server with it");
  else if (!back.projects["D:\\repo"].history || !back.mcpServers.other || back.numStartups !== 412)
    fail("uninstall damaged the rest of the file");
  else ok("uninstall clears the project scope and leaves everything else");

  // Installing has to converge on ONE entry: a leftover project-scoped copy
  // outranks the top-level one and would keep pointing at its own old path.
  const installed = JSON.parse(withEntry(byId("claude"), localScope, SERVER, BUNDLE)) as {
    mcpServers: Record<string, unknown>;
    projects: Record<string, { mcpServers: Record<string, unknown> }>;
  };
  if (installed.projects["D:\\repo"].mcpServers.tedi)
    fail("install left a second, project-scoped entry that outranks the one it wrote");
  else if (!installed.mcpServers.tedi) fail("install did not write the top-level entry");
  else if (!installed.projects["D:\\repo"].mcpServers.keepme)
    fail("install took a sibling project-scoped server with it");
  else ok("install converges on one entry, at the top level");
}

// ---------------------------------------------------------------------------
console.log("\n[mcpServers] an empty or missing file becomes a valid config");
{
  const fresh = withEntry(byId("cursor"), "", SERVER, BUNDLE);
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

  const after = withEntry(byId("codex"), before, SERVER, BUNDLE);
  if (!after.includes('model = "gpt-5"')) fail("dropped a top-level key");
  else if (!after.includes("[mcp_servers.other]")) fail("dropped a sibling server table");
  else if (!after.includes("[shell_environment_policy]")) fail("dropped a later table");
  else ok("every other table survives the install");

  if (!after.includes("[mcp_servers.tedi]")) fail("did not write our table");
  else if (!after.includes(JSON.stringify(SERVER))) fail("path is not TOML-quoted");
  else ok("our table is written with a quoted path");

  // Text format: this is the one that can genuinely duplicate.
  const twice = withEntry(byId("codex"), after, SERVER, BUNDLE);
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
  const reinstalled = withEntry(byId("codex"), before, SERVER, BUNDLE);
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
  const reinstalled = withEntry(byId("codex"), before, SERVER, BUNDLE);
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
  if (readsAsInstalled(byId("claude"), stale, SERVER, BUNDLE))
    fail("a stale path read as installed");
  else ok("a stale path reads as not installed, so the button offers to fix it");

  const staleToml = `[mcp_servers.tedi]\ncommand = "node"\nargs = ["${OLD_SERVER}"]\n`;
  if (readsAsInstalled(byId("codex"), staleToml, SERVER, BUNDLE))
    fail("a stale TOML path read as installed");
  else ok("same for TOML");

  if (readsAsInstalled(byId("claude"), "{ not json", SERVER, BUNDLE))
    fail("unparseable JSON read as installed");
  else ok("an unparseable config reads as not installed rather than throwing");
}

// ---------------------------------------------------------------------------
console.log("\n[opencode] gets its own entry shape, not the standard one");
{
  const after = withEntry(byId("opencode"), "", SERVER, BUNDLE);
  const json = JSON.parse(after) as { mcp?: Record<string, { type?: string; command?: string[] }> };
  if (!json.mcp) fail(`opencode entry landed under ${Object.keys(json).join(", ")}, want "mcp"`);
  else if (json.mcp.tedi?.type !== "local") fail("opencode entry is missing type:local");
  else if (json.mcp.tedi.command?.[0] !== "node") fail("opencode command is not an argv array");
  else ok('opencode gets { mcp: { tedi: { type: "local", command: [...] } } }');

  const std = entryFor("mcpServers", SERVER, BUNDLE) as { env: Record<string, string> };
  // A port here is an override the server obeys with the bridge down, which drives
  // whichever TEDI holds it. No tool needs one.
  if ("TEDI_DEBUG_PORT" in std.env) fail("the entry names a port again");
  else ok("the entry names no port");
  if (/TEDI_DEBUG_PORT/.test(withEntry(byId("codex"), "", SERVER, BUNDLE))) {
    fail("the Codex entry names a port again");
  } else ok("nor does the Codex one");
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
