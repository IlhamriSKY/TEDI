#!/usr/bin/env node
/**
 * The stdio MCP server, and the one `callTool` the `tedi` command runs too.
 *
 * WHAT AN OUTSIDE AGENT IS OFFERED: one tool, `GATEWAY_TOOL`, pointing at `tedi <verb>`. The
 * full table cost ~5k tokens on every request of every connected session, whether it touched
 * TEDI or not, and a command costs nothing until it runs.
 *
 * Registered by the plug button in TEDI's header or `tedi mcp install`, which write the entry
 * for every AI agent on this machine. By hand, any client can run `tedi mcp`, which needs no
 * path and no environment. This process starts fine with TEDI closed, and must: a client
 * launches it at session start, long before anyone has opened the app.
 */

import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HANDLERS, narrowed } from "./handlers.mjs";
import { makeTransport } from "./transport.mjs";
import { tediDataFiles } from "./socket.mjs";
import {
  TOOL_DEFS,
  TOOL_NAMES,
  cliGuide,
  resolveVerb,
  validateArgs,
  verbArgs,
  extToolMedia,
} from "./tools.mjs";

/**
 * How tools reach TEDI. One connection, made on the first call that needs it, so a session that
 * never drives anything costs the app nothing. See `transport.mjs`.
 */
let transport = null;
const tedi = () => (transport ??= makeTransport());

/** An MCP answer is text, and a pretty-printed one bills every indent to the model. */
const MAX_RESULT_CHARS = 20000;

export function asText(out) {
  const text = typeof out === "string" ? out : (JSON.stringify(out) ?? "null");
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}
... truncated at ${MAX_RESULT_CHARS} characters. Ask for something narrower.`
    : text;
}

/**
 * The handlers that need Node or the DevTools Protocol. Everything else is one implementation,
 * shared with TEDI's own agent, in `handlers.mjs`.
 *
 * TWO RULES FOR WHAT GOES IN A TOOL DESCRIPTION (`tools.mjs`), and they pull against each other.
 * A trap that produces a SILENT WRONG ANSWER belongs there: nothing else will say so. A trap that
 * raises a LOUD ERROR belongs in the error, which costs nothing until it fires and arrives
 * exactly when it is useful, because TEDI's own agent pays for every description on every step.
 */
const NODE_HANDLERS = {
  inspect: async (t, a) =>
    a.what === "logs"
      ? narrowed(await t.logs(a.level ?? null), a.filter)
      : HANDLERS.inspect(t.call, a),

  open_file: (t, a) => HANDLERS.open_file(t.call, { ...a, path: path.resolve(a.path) }),

  lsp: (t, a) => HANDLERS.lsp(t.call, { ...a, path: path.resolve(a.path) }),

  skill: (t, a) => HANDLERS.skill(t.call, { ...a, root: process.cwd() }),

  screenshot: async (t, a) => {
    const file = a.path
      ? path.resolve(a.path)
      : path.join(mkdtempSync(path.join(tmpdir(), "tedi-shot-")), "tedi.png");
    await (await t.devtools()).shot(file);
    return file;
  },

  eval_js: async (t, a) => (await t.devtools()).eval(a.expression),
};

function runnerFor(name) {
  if (NODE_HANDLERS[name]) return NODE_HANDLERS[name];
  const shared = HANDLERS[name];
  return shared && ((t, a) => shared(t.call, a));
}

/**
 * What the rest of this file (and `driver-verify`) reads: the shared
 * definition with this transport's handler attached.
 *
 * Composed rather than declared, so a tool cannot exist here without a def, or
 * carry a description that drifted from the one the other server serves.
 */
export const TOOLS = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, { ...TOOL_DEFS[name], run: runnerFor(name) }]),
);

// A def with no handler would advertise a tool that throws on use; a handler
// with no def would be an unadvertised tool with no schema. Both are build
// errors, not runtime surprises.
{
  const noHandler = TOOL_NAMES.filter((n) => typeof TOOLS[n].run !== "function");
  const noDef = [...Object.keys(HANDLERS), ...Object.keys(NODE_HANDLERS)].filter(
    (n) => !TOOL_DEFS[n],
  );
  if (noHandler.length || noDef.length) {
    throw new Error(
      "tools.mjs and handlers disagree - no handler: [" + noHandler + "], no def: [" + noDef + "]",
    );
  }
}

// --- what this server offers -----------------------------------------------
//
// What may run. An outside CLI is advertised only `GATEWAY_TOOL`, and these decide
// what the rest of the table will answer. The switches live in TEDI's header (Install MCP); this end only reads the
// answer off disk, exactly as Rust reads `automationChannelPort`.
//
// The PACK TABLE deliberately is not here. This file ships as a bundle resource
// with only `driver.mjs` beside it and cannot import from `src/`, so the UI
// owns the pack -> tools mapping and writes the resolved flat list. A second
// copy here would drift the first time a tool was renamed.

/** `{ disabled, disabledExtensions }`, or the permissive default when the file is
 *  absent or unreadable. Never throws: a surface setting must not be able to
 *  stop the server from starting. */
function readSurface() {
  for (const file of tediDataFiles("tedi-settings.json")) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return {
        disabled: new Set(Array.isArray(j.mcpDisabledTools) ? j.mcpDisabledTools : []),
        disabledExtensions: new Set(
          Array.isArray(j.mcpDisabledExtensions) ? j.mcpDisabledExtensions : [],
        ),
      };
    } catch {
      // Missing file, unreadable, or not JSON: try the next candidate.
    }
  }
  return { disabled: new Set(), disabledExtensions: new Set() };
}

/**
 * The pack switches, re-read rather than snapshotted.
 *
 * This used to be `const surface = readSurface()` at module load. Claude Code
 * starts this server once at session start and keeps it for hours, so a user
 * turning a pack off in the MCP dialog changed nothing until they restarted
 * their CLI - the switch appeared to do nothing, which is the worst failure a
 * security control can have. The file is a few hundred bytes; a 1s TTL keeps a
 * `tools/list` + `tools/call` pair down to one read while making a flipped
 * switch land on the next call.
 */
let _surface = null;
let _surfaceAt = 0;
export function currentSurface() {
  const now = Date.now();
  if (!_surface || now - _surfaceAt > 1000) {
    _surface = readSurface();
    _surfaceAt = now;
  }
  return _surface;
}

/**
 * Every enabled extension's AI tools, as verbs and as gateway tools.
 *
 * Cached to disk, because `tools/list` is usually the FIRST thing a client asks
 * and Claude Code launches this server at session start - often before TEDI is
 * open. Querying the live app is the source of truth; the cache is what makes
 * the answer survive a cold start. Prefixed `ext_` so an extension can never
 * shadow one of ours.
 */
// BESIDE THE SETTINGS FILE, so per profile and per user. A fixed name in the
// shared temp dir served one profile's tool list to another, and on Linux let any
// other local account pre-plant the file: `/tmp` is shared and the name is
// predictable, and what it holds becomes tool descriptions an agent reads.
const extCacheFile = () =>
  tediDataFiles("tedi-settings.json")
    .find((file) => existsSync(file))
    ?.replace(/tedi-settings\.json$/, "mcp-ext-tools.json");

async function extensionTools() {
  const cache = extCacheFile();
  let installed = null;
  let live = true;
  try {
    installed = await tedi().call("extensions");
    if (cache) writeFileSync(cache, JSON.stringify(installed));
  } catch {
    live = false;
    // TEDI is not up yet. Serve the last snapshot rather than silently
    // dropping a pack the user switched on.
    try {
      installed = JSON.parse(readFileSync(cache, "utf8"));
    } catch {
      return { list: [], live: false };
    }
  }
  const off = currentSurface().disabledExtensions;
  const list = (installed ?? [])
    .filter((e) => !off.has(e.id))
    .flatMap((e) =>
      (e.aiTools ?? []).map((t) => ({
        name: `ext_${t.name}`,
        description: `${t.description ?? ""} (from the ${e.name} extension)`.trim(),
        // The extension's OWN JSON Schema, so a tool with an `action` enum
        // advertises that enum instead of an anonymous bag. This used to be a
        // fixed open object because the schema did not cross the bridge; it does
        // now (`listExtensions` in `modules/extensions/store.ts`).
        //
        // The open object stays as the fallback, and is not dead code: a
        // disk-snapshot answer written by an older host carries no `parameters`,
        // and an extension may legitimately declare none. An empty `properties`
        // with `additionalProperties: false` would reject every argument, so the
        // permissive shape is the only safe stand-in for "schema unknown".
        inputSchema:
          t.parameters && typeof t.parameters === "object"
            ? t.parameters
            : { type: "object", properties: {}, additionalProperties: true },
        _ext: { extensionId: e.id, tool: t.name },
      })),
    );
  return { list, live };
}

function coreToolList() {
  const off = currentSurface().disabled;
  return TOOL_NAMES.filter((name) => !off.has(name)).map((name) => ({
    name,
    description: TOOL_DEFS[name].description,
    inputSchema: TOOL_DEFS[name].schema,
    // Annotations, where the table declares one. The spec's DEFAULTS are the
    // pessimistic ones (destructive, open-world), so an unannotated `state` -
    // the verb every agent is told to call before every move - read exactly as
    // dangerous as `eval_js` to any client that gates on them, and cost the user
    // an approval prompt per snapshot. Omitted where TEDI has nothing honest to
    // say, because an absent annotation and a wrong one are not the same thing.
    ...(TOOL_DEFS[name].annotations ? { annotations: TOOL_DEFS[name].annotations } : {}),
  }));
}

/**
 * Extension tools resolved once per process: `{ advertised, routes }`.
 *
 * Built through a cached PROMISE, not a flag, because `tools/list` and
 * `tools/call` are dispatched concurrently - replies carry their id, so a client
 * may fire both without waiting. The first version built the index inside
 * `tools/list` only, and a call that arrived first found it empty and refused
 * with "Unknown tool" for a tool the same session had just advertised. Both
 * paths await the same promise now.
 */
let extIndexPromise = null;
let extIndexKey = null;
let extIndexLive = false;
function ensureExtIndex() {
  // KEYED ON THE CURRENT PACK LIST, for the same reason `currentSurface` has a
  // TTL at all. A plain `??=` froze the routes map at first use while the packs
  // it is built from were re-read every second, and that broke the switch BOTH
  // ways: turning a pack OFF left its `ext_*` tools routable (the call-site gate
  // only asks whether SOME pack is on, and `ext_*` names never appear in
  // `surface.disabled`, so nothing else caught it - the exact bypass the switch
  // exists to prevent); turning one ON never advertised its tools, because the
  // promise had already resolved.
  const key = [...currentSurface().disabledExtensions].sort().join(",");
  // A DISK-FALLBACK ANSWER IS NOT CACHEABLE. Claude Code launches this server at
  // session start, routinely before TEDI is open, so the first `tools/list`
  // answers from the snapshot - and keying only on the pack list froze that
  // stale answer for the rest of the session. Retry until a query really reached
  // the app.
  if (extIndexPromise && extIndexKey === key && extIndexLive) return extIndexPromise;
  extIndexKey = key;
  extIndexPromise = extensionTools()
    .then(({ list, live }) => {
      // AN EMPTY ANSWER IS NOT CACHEABLE EITHER, and that one bit is the
      // difference between an outside CLI seeing the browser and never seeing
      // it. `extensions()` succeeds the moment TEDI's window is up, but an
      // extension's AI tools only exist after `activate()` has run, and the
      // extension host takes seconds to work through them all. A CLI that
      // connects in that window gets a SUCCESSFUL query returning an extension
      // with no tools yet, caches it as live, and is stuck without `ext_*` for
      // the rest of its session with nothing to retry it. Measured: probing
      // ~12s after a window reload advertised nothing; ~30s in it advertised
      // all 21 actions.
      //
      // So resolving to NOTHING is treated as an answer still on its way. It
      // retries at most once per call, and stops the moment tools appear.
      extIndexLive = live && list.length > 0;
      return {
        advertised: list.map(({ _ext, ...rest }) => rest),
        routes: new Map(list.map((t) => [t.name, t._ext])),
      };
    })
    .catch((e) => {
      // Never cache a rejection: `??=` on a rejected promise is permanent, and
      // this is awaited on the hot path of BOTH tools/list and tools/call, so
      // one transient failure would break the tool surface for the whole
      // session with no way back. Drop it so the next call retries.
      if (extIndexKey === key) {
        extIndexPromise = null;
        extIndexKey = null;
      }
      throw e;
    });
  return extIndexPromise;
}

export async function listTools() {
  return [...coreToolList(), ...(await ensureExtIndex()).advertised];
}

/**
 * All an outside AI CLI is offered: one tool that points at `tedi <verb>`.
 *
 * The full table cost ~5k tokens on every request of every connected session,
 * whether it touched TEDI or not, and a command costs nothing until it runs. This
 * tool is the way to learn that, and the way in for a client with no shell.
 * The switches and validation are untouched: everything lands in `callTool`.
 *
 * What it gives up: per-tool annotations. A client that auto-approved `state` as
 * read-only now sees one tool and asks, the same as for a shell command.
 */
export const GATEWAY_TOOL = {
  name: "tedi",
  description:
    "Drive the running TEDI window: panes, terminals, editors, workspaces, settings, extensions, " +
    "SSH and its built-in agent. With a shell, run `tedi <verb> --json` instead: `tedi tools` lists " +
    "the verbs, `tedi help <verb>` shows the arguments. Without one, call this: `verb` is a tool " +
    'name, `args` its arguments; verb "tools" lists them, and "help" with args.verb shows a schema.',
  inputSchema: {
    type: "object",
    properties: { verb: { type: "string" }, args: { type: "object" } },
    required: ["verb"],
  },
};

const INSTRUCTIONS =
  "Control the running TEDI window with the `tedi` command from your shell. `tedi panes --json` " +
  "shows what is open, `tedi tools` lists every verb, `tedi help <verb>` shows its arguments. " +
  "Piped or with --json an answer is one JSON value; on a terminal it is a table. If `tedi` is " +
  "not on PATH, use the `tedi` tool here the same way.";

/**
 * The gateway's own verbs, then anything the `tedi` command takes, shortcuts
 * included: the instructions promise "the same way", and an agent on a machine
 * without the command on PATH will call `new-tab` because that is what it read.
 */
export async function callGateway(a) {
  const verb = String(a?.verb ?? "");
  if (verb === "tools") return cliGuide(await listTools());
  if (verb === "help") {
    const found = resolveVerb(a?.args?.verb ?? "");
    const tool = found && (await listTools()).find((t) => t.name === found.tool);
    if (!tool) throw new Error(`Unknown verb "${a?.args?.verb ?? ""}". verb "tools" lists them.`);
    return { ...tool, fixedArgs: found.args };
  }
  const found = resolveVerb(verb);
  if (!found) throw new Error(`Unknown verb "${verb}". verb "tools" lists them.`);
  const out = await callTool(found.tool, verbArgs(found, a?.args));
  return found.select ? (out?.[found.select] ?? null) : out;
}

/** Hand the connection back. For `cli.mjs`, whose process ends after one call. */
export function closeTransport() {
  transport?.close();
}

export async function callTool(name, args) {
  const surface = currentSurface();

  // THE SWITCH IS ENFORCED HERE, NOT IN `tools/list`.
  //
  // This check used to live below, inside `if (!tool)`. It could never fire:
  // `driver-verify` asserts that every pack entry is a real tool, so a name in
  // `surface.disabled` is ALWAYS in `TOOLS`, so `!tool` was false and the
  // disabled tool ran. Filtering `coreToolList` hid it from the advertised list
  // and nothing else - a client that had listed once, or simply guessed a name,
  // still got `eval_js`, `sh` or `set_setting` after the user switched the pack
  // off. That is the exact bypass the switch exists to prevent, against the
  // exact client it exists to constrain.
  //
  if (surface.disabled.has(name)) {
    throw new Error(
      `"${name}" is switched off for this MCP server. Turn its pack back on in TEDI: header, Install MCP.`,
    );
  }

  // Only for an extension's name: anything else has nothing to route, and must not
  // connect to TEDI to learn that.
  const isExt = String(name).startsWith("ext_");
  const routed = isExt ? (await ensureExtIndex()).routes.get(name) : undefined;
  if (routed) {
    const out = await tedi().call(
      "runExtensionCommand",
      routed.extensionId,
      routed.tool,
      args ?? {},
    );
    if (!out) throw new Error(`${routed.extensionId} no longer answers to "${routed.tool}".`);
    if (out.kind !== "aiTool") return `ran ${routed.tool}`;
    // An image comes back as a real MCP image block rather than base64 buried in
    // a JSON string, which is the difference between a client rendering it and a
    // model being handed characters it cannot decode.
    const media = extToolMedia(out.result);
    if (!media) return out.result;
    return {
      content: [
        ...(media.text ? [{ type: "text", text: media.text }] : []),
        { type: "image", data: media.data, mimeType: media.mimeType },
      ],
    };
  }
  if (isExt) {
    throw new Error(
      `"${name}" is not available: its extension is disabled, switched off in Install MCP, or not installed.`,
    );
  }
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) {
    // Only the ENABLED names: the old message printed `Object.keys(TOOLS)`,
    // handing the caller the full list including everything just switched off.
    const have = TOOL_NAMES.filter((n) => !surface.disabled.has(n));
    throw new Error(`Unknown tool "${name}". Have: ${have.join(", ")}`);
  }
  // Shared with TEDI's own agent (`tools.mjs`), so a malformed call is
  // refused identically on both transports. This used to be per-handler
  // `if (!a.id) throw` lines that covered some tools and not others, while the
  // in-app agent got Zod validation for free - the same bad call produced a
  // different outcome depending on which server the agent happened to reach.
  const bad = validateArgs(name, args);
  if (bad) throw new Error(bad);
  return await tool.run(tedi(), args ?? {});
}

// --- JSON-RPC over stdio ----------------------------------------------------

/**
 * Protocol revisions this server answers to, newest first.
 *
 * EVERY REVISION AN MCP CLIENT IN THE WILD STILL SPEAKS IS LISTED, and that is
 * the point. Answering with a version the client does not know is not a soft
 * downgrade - the SDK's `Client.connect()` treats it as fatal and drops the
 * connection, so TEDI's whole tool surface vanishes from that host with no
 * tool-level error to explain it. A short list is therefore far more dangerous
 * than a long one.
 *
 * 2025-03-26 is included even though it made JSON-RPC batching mandatory and
 * this server refuses batches: the refusal is a well-formed `-32600` on the ONE
 * frame (see the guard in the stdin reader), and no mainstream client emits
 * batches anyway. Losing one frame shape beats losing the session.
 *
 * What this still fixes is the real bug: the version was ECHOED, so the server
 * claimed to speak any string a client named, including revisions that do not
 * exist yet.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** The client's version when we support it, otherwise our own latest. Legacy
 *  only: `initialize` never negotiates a modern version, because a modern client
 *  does not send `initialize` at all. */
function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/**
 * MODERN (2026-07-28+) revisions carry the protocol version in each request's
 * `_meta` instead of establishing a session with `initialize`. This server is
 * DUAL-ERA: it speaks the modern stateless model AND the legacy handshake at
 * once, which the spec explicitly allows
 * (`.../2026-07-28/basic/versioning#backward-compatibility`) - a request opening
 * with `initialize` is served legacy, one carrying modern `_meta` is served
 * stateless. NOTHING about the legacy path changes, so no current client breaks;
 * the additions are only reached by a client that speaks modern, and none does
 * yet. The server was already stateless in practice (no session gating), so this
 * is a `server/discover` reply, a per-request version check, and a `resultType`
 * on modern results - not a rewrite.
 */
const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];

/** What `server/discover` advertises and the per-request gate accepts: modern
 *  first (preferred), then every legacy revision still spoken. */
export const ALL_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS];

/** Identity reported in both `initialize` and `server/discover`. `title` is the
 *  display name (2025-11-25+), `name` the programmatic id. */
const SERVER_INFO = { name: "tedi", title: "TEDI", version: "1.0.0" };

/** Whether a request opts into the modern era, i.e. carries a modern protocol
 *  version in `_meta`. Legacy requests put their version in `params.protocolVersion`
 *  on `initialize` only, never in `_meta`, so they read as false. */
function isModernRequest(msg) {
  return Boolean(msg?.params?._meta?.["io.modelcontextprotocol/protocolVersion"]);
}

/**
 * The `server/discover` result (a MUST in modern MCP). Pure and exported so
 * `mcp-conformance-verify` pins its shape without spawning the process. Matches
 * the spec's `DiscoverResult`: `resultType`, `supportedVersions`, `capabilities`,
 * and the identity under the modern `_meta` key.
 */
export function discoverResult() {
  return {
    resultType: "complete",
    supportedVersions: ALL_PROTOCOL_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
  };
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  // A notification carries no id and takes no reply. `notifications/initialized`
  // is the only one that arrives here; answering it is a protocol violation.
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });

  // MODERN per-request version gate. A request that names a modern protocol
  // version we do not speak is refused with -32022, the error a modern client
  // retries on with a version from `data.supported`. Legacy requests carry no
  // such `_meta`, so this is additive and never touches them.
  const modernVersion = msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (modernVersion && !ALL_PROTOCOL_VERSIONS.includes(modernVersion)) {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: ALL_PROTOCOL_VERSIONS, requested: modernVersion },
      },
    });
  }
  const modern = isModernRequest(msg);

  switch (msg.method) {
    // MODERN discovery: supported versions, capabilities and identity in one
    // reply. A dual-era client sends this first on stdio to tell a modern server
    // from a legacy one; a legacy client never sends it.
    case "server/discover":
      return reply(discoverResult());
    case "initialize":
      return reply({
        // NEGOTIATE, do not echo. The spec is explicit: if the server supports
        // the requested version it MUST answer with that same version, and
        // otherwise MUST answer with one it DOES support, leaving the client to
        // accept or disconnect. Echoing whatever arrived meant the server
        // claimed to speak any string a client named - including 2025-03-26,
        // whose mandatory JSON-RPC batching this server does not implement, and
        // including future revisions it has never seen. Answering with our own
        // latest is the spec's own downgrade signal, not a downgrade bug.
        protocolVersion: negotiateProtocol(msg.params?.protocolVersion),
        // `listChanged: false`, DECLARED not omitted: the spec says a tools
        // server MUST carry the boolean, and false is the honest value - this
        // server never pushes `notifications/tools/list_changed`. The tool set
        // does shift (a pack toggled, an extension finishing `activate()`), but
        // a client re-lists on its own and `ensureExtIndex` retries an
        // not-yet-ready extension answer, so there is nothing to notify about
        // rather than a notification we quietly fail to send.
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        // `title` is the display name the client shows (Implementation.title,
        // 2025-11-25); `name` stays the programmatic id. Older clients ignore it.
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply({});
    case "tools/list": {
      // `resultType: "complete"` ONLY for a modern request. A legacy tools/list
      // result stays byte-identical to what shipped, so a strict legacy client
      // cannot be tripped by a field it never expected.
      const result = { tools: [GATEWAY_TOOL] };
      return reply(modern ? { resultType: "complete", ...result } : result);
    }
    case "tools/call": {
      let result;
      try {
        // Old names still answer: a session that listed before this change keeps
        // working, and they are what `tedi tools` and the gateway name anyway.
        const name = msg.params?.name;
        const out =
          name === GATEWAY_TOOL.name
            ? await callGateway(msg.params?.arguments)
            : await callTool(name, msg.params?.arguments);
        // A handler may answer with ready-made content blocks (an image) instead
        // of a string; everything else is still wrapped as one text block.
        result =
          out && typeof out === "object" && Array.isArray(out.content)
            ? out
            : { content: [{ type: "text", text: asText(out) }] };
      } catch (err) {
        // `isError`, not a JSON-RPC error: a tool failing is something the agent
        // should read and act on (start TEDI, dismiss the toast, pick a real
        // leaf id), not a transport fault that hides the message.
        result = { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
      return reply(modern ? { resultType: "complete", ...result } : result);
    }
    default:
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
}

/** Speak MCP on stdin and stdout until the client hangs up. */
export function serveStdio() {
  // STDOUT IS THE PROTOCOL, and one stray line corrupts the JSON-RPC stream in a way that reads
  // as the server crashing. Every console channel goes to stderr, which clients show as logs.
  console.log = console.info = console.warn = console.debug = console.error;

  /** Calls still running. Drained on shutdown so a client that closes stdin the
   *  moment it sends its last request still gets that request's answer. */
  const inflight = new Set();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // A frame we cannot parse has no id to answer on.
      }
      // A batch (array), a bare `null`, or a scalar. Nothing between the parse
      // and the dispatch used to check that a frame is a JSON-RPC OBJECT, and
      // `handle` assumes it is:
      //   * an array's `.id` is undefined, so it hit the notification guard and
      //     was answered with SILENCE - every request inside it hung forever;
      //   * `null.id` THREW inside handle, and the `.catch` below dereferenced
      //     the same null again, so one malformed line killed the process and
      //     took every in-flight call with it.
      // Batching was removed from MCP in 2025-06-18. Refuse it out loud.
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        send({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Invalid Request: batches and non-object frames are not supported",
          },
        });
        continue;
      }
      // Not awaited: JSON-RPC replies carry their id, so order does not matter,
      // and a 20-second `sh` must not hold a `state` behind it. Tracked, though -
      // stdin closing while a call is in flight must not kill it unanswered.
      const call = handle(msg).catch((err) => {
        if (msg.id !== undefined) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } });
        }
      });
      inflight.add(call);
      void call.finally(() => inflight.delete(call));
    }
  });

  // Hand the page target back on the way out. Leaving the socket half-open keeps
  // the target occupied on the WebView2 side, and the next client hangs on
  // connect with no error at all.
  const shutdown = async () => {
    await Promise.allSettled([...inflight]);
    closeTransport();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Real paths on both sides: node runs the main module from its real path. An import
// (`cli.mjs`, the verify scripts) must not start reading stdin.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveStdio();
}
