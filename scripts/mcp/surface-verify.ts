/**
 * Self-check for the SHARED MCP tool table (`scripts/mcp/tools.mjs`).
 *
 * Run: `npx tsx scripts/mcp/surface-verify.ts` (or `pnpm verify`, which globs it).
 *
 * `driver-verify.ts` checks the stdio server and the pack wiring. This checks
 * the thing both servers now depend on, and the two failures that made the split
 * definition worth removing in the first place:
 *
 *   1. **Arguments must survive the transport untouched.** The in-process server
 *      used to be an `McpServer` with Zod schemas, and Zod's object parse STRIPS
 *      unknown keys. `ssh {action:"connect", id:"x"}` - the call the advertised
 *      schema asked for - arrived at the handler as `{}`, took the "no id, so
 *      list" branch, and returned a connection list with no error. A silent wrong
 *      answer, from a correctly-formed call. The round-trip below is the
 *      regression test for that, run against the real SDK.
 *
 *   2. **One schema, or the two servers mean different things by one name.**
 *      Nothing here can drift now because both read the same table, so what is
 *      left to check is that the table itself is well-formed and that its
 *      validator agrees with what the schemas declare.
 *
 * The in-process server itself cannot be imported here: `tediMcpServer.ts` pulls
 * in the settings and extension stores, which pull in Tauri. So this exercises
 * the shared table through the same SDK primitives that file uses, which is the
 * part that was actually broken.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";

import { TOOL_DEFS, TOOL_NAMES, toolsInPack, validateArgs } from "./tools.mjs";

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};
const ok = (msg: string): void => console.log(`  ok: ${msg}`);

// ---------------------------------------------------------------------------
// 1. The table is well-formed.
// ---------------------------------------------------------------------------
console.log("[table] every tool has a pack, a description and an object schema");

const PACKS = new Set(["tedi", "settings", "browser", "ai", "misc"]);
for (const name of TOOL_NAMES) {
  const d = TOOL_DEFS[name];
  if (!PACKS.has(d.pack)) fail(`${name}: pack "${d.pack}" is not a known pack`);
  if (!d.description || d.description.length < 20) {
    fail(`${name}: description is missing or too short to choose from`);
  }
  if (d.schema?.type !== "object") fail(`${name}: schema.type must be "object"`);
  for (const req of d.schema?.required ?? []) {
    if (!d.schema.properties?.[req]) {
      fail(`${name}: "${req}" is required but is not a declared property`);
    }
  }
  for (const [key, spec] of Object.entries(d.schema?.properties ?? {})) {
    if (!spec.type && !spec.enum) fail(`${name}.${key}: neither a type nor an enum`);
  }
}
if (!failed) ok(`all ${TOOL_NAMES.length} tools are well-formed`);

// A tool in no pack has no switch, so it would be permanently on.
const packed = [...PACKS].flatMap((p) => toolsInPack(p as never));
const orphan = TOOL_NAMES.filter((n) => !packed.includes(n));
if (orphan.length) fail(`tools in no pack (permanently on): ${orphan.join(", ")}`);
else ok("every tool belongs to exactly one pack");

// ---------------------------------------------------------------------------
// 2. The shared validator agrees with the schemas.
// ---------------------------------------------------------------------------
console.log("\n[validate] required keys, enums and primitive types are enforced");

// Derived from the table rather than listed by hand, so a new required argument
// is covered the moment it is added.
for (const name of TOOL_NAMES) {
  const req = TOOL_DEFS[name].schema.required ?? [];
  if (!req.length) continue;
  const missing = validateArgs(name, {});
  if (!missing) fail(`${name}: an empty call passed, but "${req[0]}" is required`);
  else if (!missing.includes(req[0])) {
    fail(`${name}: the error for an empty call does not name "${req[0]}": ${missing}`);
  }
}
ok("every tool with a required argument refuses an empty call, naming the argument");

for (const name of TOOL_NAMES) {
  for (const [key, spec] of Object.entries(TOOL_DEFS[name].schema.properties ?? {})) {
    if (!spec.enum) continue;
    const bad = validateArgs(name, { ...seedRequired(name), [key]: "__not_a_member__" });
    if (!bad) fail(`${name}.${key}: an out-of-enum value passed`);
    else if (!spec.enum.every((v) => bad.includes(v))) {
      fail(`${name}.${key}: the error does not list the allowed values: ${bad}`);
    }
  }
}
ok("an out-of-enum value is refused, and the error lists what is allowed");

// A string where a number belongs is the realistic junk write - some harnesses
// stringify every argument.
if (!validateArgs("state", { tail: "3" })) fail("state.tail accepted a string");
else ok("a string for a number argument is refused");
if (validateArgs("state", { tail: 3 })) fail("state.tail rejected a valid number");
else ok("a valid call passes");

/** Fill in a tool's required args so an enum test fails on the enum, not on a
 *  missing sibling. */
function seedRequired(name: string): Record<string, unknown> {
  const d = TOOL_DEFS[name];
  const out: Record<string, unknown> = {};
  for (const key of d.schema.required ?? []) {
    const spec = d.schema.properties?.[key];
    out[key] = spec?.enum ? spec.enum[0] : spec?.type === "number" ? 1 : "x";
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. THE REGRESSION: arguments reach the handler exactly as sent.
// ---------------------------------------------------------------------------
console.log("\n[round trip] the SDK serves the shared schema and does not touch arguments");

const seen: { name?: string; args?: unknown } = {};
const server = new Server({ name: "tedi", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DEFS[name].description,
    inputSchema: TOOL_DEFS[name].schema,
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  seen.name = req.params.name;
  seen.args = req.params.arguments;
  return { content: [{ type: "text", text: "ok" }] };
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "verify", version: "1.0.0" }, { capabilities: {} });
await client.connect(clientTransport);

const listed = await client.listTools();
if (listed.tools.length !== TOOL_NAMES.length) {
  fail(`tools/list returned ${listed.tools.length}, table has ${TOOL_NAMES.length}`);
} else ok(`tools/list serves all ${TOOL_NAMES.length} tools`);

// Served VERBATIM: an agent reading the advertised schema must be reading the
// same object the table declares, not a lossy conversion of it.
const listedSsh = listed.tools.find((t) => t.name === "ssh");
if (JSON.stringify(listedSsh?.inputSchema) !== JSON.stringify(TOOL_DEFS.ssh.schema)) {
  fail("the advertised ssh schema is not the table's schema");
} else ok("the advertised schema is the table's schema, byte for byte");

// The exact call that used to come back as `{}`.
await client.callTool({ name: "ssh", arguments: { action: "connect", id: "abc" } });
if (seen.name !== "ssh") fail(`handler saw tool "${seen.name}"`);
if (JSON.stringify(seen.args) !== JSON.stringify({ action: "connect", id: "abc" })) {
  fail(`ssh connect args were altered in transit: ${JSON.stringify(seen.args)}`);
} else ok('ssh {action:"connect", id:"abc"} reaches the handler intact');

await client.close();

// ---------------------------------------------------------------------------
// 4. Structural: the stdio server enforces the switch BEFORE it dispatches.
// ---------------------------------------------------------------------------
console.log("\n[switch] a disabled tool is refused at call time, not merely unlisted");

const mcpSrc = await readFile("scripts/mcp/server.mjs", "utf8");
const callBody = mcpSrc.slice(
  mcpSrc.indexOf("async function callTool"),
  mcpSrc.indexOf("// --- JSON-RPC over stdio"),
);
const guardAt = callBody.indexOf("surface.disabled.has(name)");
const dispatchAt = callBody.indexOf("TOOLS[name]");
if (guardAt < 0) {
  fail("callTool no longer checks surface.disabled - a switched-off tool would run");
} else if (dispatchAt >= 0 && guardAt > dispatchAt) {
  // This is exactly how it shipped broken: the check sat inside `if (!tool)`,
  // which is unreachable for a disabled tool because a disabled tool IS in
  // TOOLS. Filtering `tools/list` hid it and nothing more.
  fail("callTool checks surface.disabled AFTER looking the tool up - the check cannot refuse it");
} else ok("callTool refuses a disabled tool before it reaches the handler table");

// The same rule on the in-process side: never register what is switched off.
const tediSrc = await readFile("src/modules/ai/lib/tediMcpServer.ts", "utf8");
if (!/off\.has\(name\)/.test(tediSrc)) {
  fail("tediMcpServer no longer filters on the disabled list");
} else ok("the in-process server neither advertises nor dispatches a disabled tool");

// ---------------------------------------------------------------------------
// 5. The security-relevant preferences an agent must not write.
// ---------------------------------------------------------------------------
console.log("\n[settings] set_setting cannot re-grant the agent its own capabilities");

const storeSrc = await readFile("src/modules/settings/store.ts", "utf8");
const denied = storeSrc.slice(
  storeSrc.indexOf("const AGENT_DENIED_PREFS"),
  storeSrc.indexOf("export async function _writePreference"),
);
for (const key of [
  "approvalMode",
  "disabledTools",
  "lmstudioBaseURL",
  "openaiCompatibleBaseURL",
  "openaiCompatibleInstances",
  "terminalEnvPath",
]) {
  if (!denied.includes(`"${key}"`)) {
    fail(`${key} is agent-writable - it decides what the agent may do, or where its keys go`);
  }
}
if (!/AGENT_DENIED_PREFS\.has\(key as PrefKey\)/.test(storeSrc)) {
  fail("_writePreference does not consult AGENT_DENIED_PREFS");
} else ok("the deny-set is declared and enforced in _writePreference");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS");
if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
