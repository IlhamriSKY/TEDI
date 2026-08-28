#!/usr/bin/env node
/**
 * MCP server: how Claude Code talks to a running TEDI.
 *
 * Same `Driver` the CLI drives, exposed as MCP tools over stdio, which buys
 * three things the CLI cannot:
 *
 *   1. ONE connection for a whole session. Every `pnpm mcp <verb>` pays a
 *      fresh `/json/list`, a WebSocket attach, `Page.enable`, `Runtime.enable`
 *      and a two-frame settle before it does any work - and a page target
 *      accepts exactly one DevTools client, so each attach/detach cycle is also
 *      a chance to wedge it. Held open, that cost is paid once.
 *   2. Typed arguments. No shell quoting, which on PowerShell is where a
 *      `sh "git log --format=%H"` goes to die.
 *   3. A tool list instead of a README. The schema IS the documentation, so an
 *      agent discovers the surface rather than being told about it.
 *
 * Registered by the plug button in TEDI's header, which writes the entry (and
 * removes it) for every AI CLI on this machine plus the open folder's
 * `.mcp.json`. That file is gitignored on purpose: it names an absolute path
 * into THIS machine's install, and a tracked copy is one the switch cannot see,
 * so it kept loading after the switch was turned off. TEDI must have been
 * started with
 * `TEDI_DEBUG_PORT` set; if it was not, the tools say so and say how to fix it,
 * because this process starts fine either way (it must - Claude Code launches it
 * at session start, long before anyone has opened TEDI).
 */

import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { makeTransport } from "./transport.mjs";
import { TOOL_DEFS, TOOL_NAMES, validateArgs } from "./tools.mjs";

/**
 * True only when this file is the process entry point. `scripts/mcp/driver-verify.ts`
 * IMPORTS `TOOLS` to check every schema and every injected expression without a
 * running TEDI, and an import that hijacked the console and started reading stdin
 * would hang that check forever.
 */
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

// STDOUT IS THE PROTOCOL. `Driver` and `sweep` both print progress, and one
// stray line corrupts the JSON-RPC stream in a way that reads as the server
// crashing. Send every console channel to stderr, which Claude Code shows as
// server logs.
if (isMain) console.log = console.info = console.warn = console.debug = console.error;

/**
 * Which DevTools port to drive - i.e. WHICH TEDI the CDP-only tools reach.
 *
 * ONE PROFILE DECIDES BOTH HALVES. The socket half and the pack switches are
 * resolved from `TEDI_BUNDLE_ID`; the CDP half used to be a bare
 * `env.TEDI_DEBUG_PORT || 9222`, so with the id set and the port not, this
 * server read ONE app's switches and dispatched real keystrokes into ANOTHER
 * app's window. Not hypothetical: an end-to-end run against a dev profile sent
 * `keys` and `screenshot` straight into the installed release, because 9222 is
 * what the release happened to be listening on. The bundle id was introduced to
 * stop exactly this and only closed the settings half of it.
 *
 * So: the env var still wins (the Install button writes both together, and a
 * developer's explicit override must not be second-guessed), then the
 * `automationPort` the NAMED profile actually stores, and only then the default.
 * `null` means that profile has the channel switched off, which
 * `makeTransport` reports as such rather than silently reaching for 9222.
 */
const DEFAULT_CDP_PORT = 9222;

/**
 * The rule on its own, so `driver-verify` can check it without an app or a
 * settings file. `env` is the raw `TEDI_DEBUG_PORT`, `stored` the named
 * profile's `automationPort` (null when the file has no such key).
 */
export function resolveCdpPort(env, stored) {
  const fromEnv = Number(env);
  if (fromEnv) return fromEnv;
  // 0 is what the UI writes for "off"; absent means this profile has never been
  // wired up. Both are "no channel here", not "try the usual port".
  if (stored === 0) return null;
  return stored ?? DEFAULT_CDP_PORT;
}

const cdpPort = () => resolveCdpPort(process.env.TEDI_DEBUG_PORT, currentSurface().port);

/**
 * How tools reach TEDI. One object, two transports underneath.
 *
 * Prefers the authenticated local socket and pulls up the DevTools connection
 * only for the calls that genuinely need it - real input, window capture, DOM
 * reads. See `transport.mjs`; each connection is made at most once, on demand.
 *
 * A driving session that never touches those tools therefore opens NO DevTools
 * connection, which is what makes this work on macOS and Linux at all: the debug
 * port is Windows-only.
 */
let driver = null;

function tedi() {
  driver ??= makeTransport({ port: cdpPort() });
  return Promise.resolve(driver);
}

/** A dead connection must not poison every later call, so drop the cache and let
 *  the next tool reconnect. Closing TEDI mid-session is ordinary, not
 *  exceptional - and the bridge token rotates on every launch, so a restart has
 *  to be picked up rather than remembered as broken. */
function dropIfDisconnected(message) {
  if (
    /socket closed|Cannot open|Timed out attaching|No DevTools endpoint|bridge|not running/i.test(
      message,
    )
  ) {
    void driver?.close?.();
    driver = null;
  }
}

const json = (v) => JSON.stringify(v, null, 2);

/**
 * The handlers. One per name in `TOOL_DEFS` (`./tools.mjs`), which owns every
 * description and schema so the in-process server serves the identical contract.
 *
 * TWO RULES FOR WHAT GOES IN A DESCRIPTION, and they pull against each other:
 *
 *   1. The description IS the documentation. An agent picks from this list and
 *      never reads the source, so a trap that produces a SILENT WRONG ANSWER
 *      belongs there - that terminals have no DOM text, that CodeMirror
 *      virtualises, that a `sh` write bypasses the AI-CLI detector. Each of
 *      those returns something plausible and false, and no error would say so.
 *
 *   2. That list is loaded into EVERY request of every AI CLI that connects, for
 *      the whole session, whether it drives TEDI or not. Prose there is a tax on
 *      every turn. So a trap that raises a LOUD ERROR does not belong in the
 *      schema - it belongs in the error, which costs nothing until it fires and
 *      arrives exactly when it is useful. `click` naming the toast that covered
 *      the button, `sh` listing the terminals when the leaf was wrong,
 *      `extension` naming the installed ids: those are messages, not schema.
 */
const HANDLERS = {
  state: async (d, a) => json(await d.state({ tail: a.tail ?? 3, buttons: a.buttons === true })),

  inspect: async (d, a) => {
    switch (a.what) {
      case "commands":
        return (await d.commands()).join("\n");
      case "extensions":
        return json(await d.extensions());
      case "settings":
        return json(await d.settings());
      case "logs": {
        // Awaited because the transport proxy is uniformly async (see
        // `transport.mjs`); `logs` itself is a synchronous read of the CDP
        // console ring buffer held in this process.
        const list = await d.logs(a.level ?? null);
        return list.length
          ? list.map((l) => `${l.level}: ${l.text}`).join("\n")
          : "(nothing logged since this session connected)";
      }
      default:
        throw new Error(`Unknown "what": ${a.what}. Have: commands, extensions, settings, logs.`);
    }
  },

  read: async (d, a) => {
    const cap = a.maxChars ?? 20000;
    switch (a.source) {
      case "terminal": {
        const list = await d.terminals(a.lines ?? 200);
        if (!list.length) return "(no terminal panes open)";
        const want = a.leafId ?? (await d.focusedLeaf());
        // The fallback is for the case where NOTHING was named and focus is not
        // in a terminal. A leafId the caller actually passed and that does not
        // exist must not quietly return a different pane's scrollback: that
        // answers a question about pane A with pane B's output, labelled as
        // success, which is the one failure no error message ever follows. Same
        // rule `sh` and `wait_for_terminal` apply.
        const one =
          list.find((t) => t.leafId === want) ?? (a.leafId === undefined ? list.at(-1) : null);
        if (!one) {
          throw new Error(
            `Leaf ${a.leafId} is not a terminal. Terminals: ${list.map((t) => t.leafId).join(", ")}`,
          );
        }
        return `[leaf ${one.leafId} atPrompt=${one.atPrompt} running=${one.running}]\n${one.text}`;
      }
      case "editors": {
        const list = await d.editors(cap);
        if (!list.length) return "(no editor panes open)";
        return list
          .map(
            (e) => `--- leaf ${e.leafId}: ${e.path}${e.truncated ? " (truncated)" : ""}\n${e.text}`,
          )
          .join("\n\n");
      }
      case "dom": {
        if (!a.selector) throw new Error('read source:"dom" needs a `selector`.');
        const text = await d.text(a.selector, { nth: a.nth ?? 0 });
        if (text === null) return "(no match)";
        // Capped, because an unbounded selector read is how a tool result
        // eats an agent's context: `.cm-content` on a big file, or a status
        // bar that happens to wrap the whole workspace.
        return text.length > cap ? `${text.slice(0, cap)}\n\n[truncated at ${cap} chars]` : text;
      }
      default:
        throw new Error(`Unknown source: ${a.source}. Have: terminal, editors, dom.`);
    }
  },

  run_command: async (d, a) => {
    if (a.extensionId) {
      const out = await d.extCommand(a.extensionId, a.id, a.args);
      if (!out) {
        throw new Error(
          `Nothing answers to "${a.id}" in ${a.extensionId}. Its extension may be disabled, ` +
            `or the id was declared but never given a handler. ` +
            `\`inspect extensions\` lists the commands and AI tools it really has.`,
        );
      }
      // An AI tool's answer IS the point of calling it; a command has none.
      return out.kind === "aiTool" ? json(out.result) : `ran ${a.extensionId}:${a.id}`;
    }
    await d.cmd(a.id);
    return `ran ${a.id}`;
  },

  set_setting: async (d, a) => {
    const r = await d.setSetting(a.key, a.value);
    if (r !== true) throw new Error(String(r));
    return `${a.key} = ${JSON.stringify(a.value)}`;
  },

  extension: async (d, a) => {
    const r = await d.extControl(a.action, a.id);
    if (r !== true) throw new Error(String(r));
    // Not `${a.action}d` - that produced "reloadd" and "uninstalld".
    return `${a.action}: ${a.id}`;
  },

  wait_for_terminal: async (d, a) => {
    const r = await d.waitTerminal({
      leafId: a.leafId ?? null,
      text: a.text ?? null,
      timeout: a.timeout ?? 60000,
    });
    return `leaf ${r.leafId}: ${r.done ? "done" : "NOT done"} (${r.reason})\n${r.tail}`;
  },

  sh: async (d, a) => {
    const out = await d.sh(a.command, {
      leafId: a.leafId ?? null,
      timeout: a.timeout ?? 20000,
      lines: a.lines ?? 60,
    });
    return out.timedOut
      ? `${out.text}\n\n[leaf ${out.leafId}: still running after the timeout]`
      : `${out.text}\n\n[leaf ${out.leafId}]`;
  },

  open_file: async (d, a) => {
    await d.openFile(path.resolve(a.path));
    return `opened ${a.path}`;
  },

  save_editor: async (d, a) => {
    const leaf = a.leafId ?? (await d.focusedLeaf());
    if (!(await d.editorSave(leaf))) throw new Error(`Leaf ${leaf} is not an editor`);
    return `saved leaf ${leaf}`;
  },

  keys: async (d, a) => {
    await d.keys(...a.chords);
    return `pressed ${a.chords.join(" ")}`;
  },

  type_text: async (d, a) => {
    await d.type(a.text, { delay: a.delay ?? 10 });
    return `typed ${a.text.length} chars`;
  },

  click: async (d, a) => {
    await d.click(a.selector, { nth: a.nth ?? 0 });
    return `clicked ${a.selector}`;
  },

  focus_pane: async (d, a) => `focused leaf ${a.leafId}: ${await d.focusPane(a.leafId)}`,

  drag: async (d, a) => {
    await d.drag(a.selector, a.dx, a.dy, { nth: a.nth ?? 0 });
    return `dragged ${a.selector} by ${a.dx},${a.dy}`;
  },

  screenshot: async (d, a) => {
    const file = a.path
      ? path.resolve(a.path)
      : path.join(mkdtempSync(path.join(tmpdir(), "tedi-shot-")), "tedi.png");
    await d.shot(file);
    return file;
  },

  ai: async (d, a) => {
    switch (a.action) {
      case "status":
        return json(await d.ai());
      case "read":
        return json(await d.aiMessages(a.sessionId ?? null, a.maxChars ?? 8000));
      case "send": {
        if (!a.text) throw new Error("send needs `text`.");
        const r = await d.aiSend(a.text);
        if (r !== true) throw new Error(String(r));
        return `queued for the built-in agent: ${a.text.slice(0, 80)}`;
      }
      default:
        throw new Error(`Unknown action: ${a.action}. Have: status, read, send.`);
    }
  },

  ssh: async (d, a) => {
    if (a.action === "list") return json(await d.sshConnections());
    if (a.action !== "connect")
      throw new Error(`Unknown action: ${a.action}. Have: list, connect.`);
    if (!a.id) throw new Error("connect needs `id` (from `ssh list`).");
    const r = await d.sshConnect(a.id, a.private === true);
    if (r !== true) throw new Error(String(r));
    return `opened SSH connection ${a.id}`;
  },

  browser: async (d, a) => {
    // History and the address bar are ordinary registered commands and act on
    // the FOCUSED pane; the rest are Rust calls that need the leaf.
    const byCommand = {
      back: "browser.back",
      forward: "browser.forward",
      reload: "browser.reload",
      address: "browser.focusAddressBar",
    };
    if (byCommand[a.action]) {
      await d.cmd(byCommand[a.action]);
      return `ran ${byCommand[a.action]}`;
    }
    if (a.action === "list") return json(await d.browserList());
    if (a.action === "open") {
      if (!a.url) throw new Error("open needs `url`.");
      const tab = await d.browserOpen(a.url);
      // A string means it could not: the helper answers with the reason
      // rather than null, which the driver would read as a missing surface.
      if (typeof tab === "number") return `opened ${a.url} (tab ${tab})`;
      // Fall back to the two steps that are independently proven: the command
      // registry makes a blank preview pane, then setting the LEAF's url is
      // what BrowserPane actually watches. (Driving `preview_embed_navigate`
      // instead would silently no-op - a blank pane has no native webview
      // until the app has given it a url.)
      const before = new Set((await d.browserList()).map((b) => b.leafId));
      await d.cmd("tab.newPreview");
      await d.wait(1500);
      const fresh = (await d.browserList()).find((b) => !before.has(b.leafId));
      if (!fresh) throw new Error(`${tab} (and opening a preview tab did not create one either)`);
      const nav = await d.browserNav(fresh.leafId, a.url);
      if (nav !== true) throw new Error(String(nav));
      return `opened ${a.url} (leaf ${fresh.leafId})`;
    }
    // Resolve AND authorize against the same list, always.
    //
    // `browserList()` is privacy-filtered in the app (`buildLiveContext`), but
    // an explicitly-passed `leafId` used to skip it entirely - and two actions
    // below (`url`, `console`) then call `preview_embed_*` by raw tab id,
    // which has no notion of privacy on the Rust side. That read a private
    // browser pane's address and console output by id. `navigate` and `read`
    // route through the filtered context and were already safe; checking here
    // covers all four the same way, and keeps a future action from inheriting
    // the hole by being written against `leaf` directly.
    const visible = await d.browserList();
    if (!visible.length) {
      throw new Error('No browser pane is open. Use action "open" with a `url` first.');
    }
    const leaf = a.leafId ?? visible[0].leafId;
    if (!visible.some((b) => b.leafId === leaf)) {
      throw new Error(
        `No browser pane with leafId ${leaf}. Open ones: ${visible.map((b) => b.leafId).join(", ")}.`,
      );
    }
    switch (a.action) {
      case "navigate":
        if (!a.url) throw new Error("navigate needs `url`.");
        {
          const r = await d.browserNav(leaf, a.url);
          if (r !== true) throw new Error(String(r));
          return `navigated leaf ${leaf} to ${a.url}`;
        }
      case "url":
        return String((await d.invoke("preview_embed_url", { tabId: leaf })) ?? "(none)");
      case "read":
        return String(
          (await d.browserRead(leaf, false)) ?? "(nothing to read - has this pane loaded a page?)",
        );
      case "console":
        return json(await d.invoke("preview_embed_console", { tabId: leaf }));
      default:
        throw new Error(`Unknown action: ${a.action}`);
    }
  },

  eval_js: async (d, a) => json(await d.eval(a.expression)),
};

/**
 * What the rest of this file (and `driver-verify`) reads: the shared
 * definition with this transport's handler attached.
 *
 * Composed rather than declared, so a tool cannot exist here without a def, or
 * carry a description that drifted from the one the other server serves.
 */
export const TOOLS = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, { ...TOOL_DEFS[name], run: HANDLERS[name] }]),
);

// A def with no handler would advertise a tool that throws on use; a handler
// with no def would be an unadvertised tool with no schema. Both are build
// errors, not runtime surprises.
{
  const noHandler = TOOL_NAMES.filter((n) => typeof HANDLERS[n] !== "function");
  const noDef = Object.keys(HANDLERS).filter((n) => !TOOL_DEFS[n]);
  if (noHandler.length || noDef.length) {
    throw new Error(
      "tools.mjs and mcp.mjs disagree - no handler: [" + noHandler + "], no def: [" + noDef + "]",
    );
  }
}

// --- what this server offers -----------------------------------------------
//
// The tool list is loaded into EVERY request of a connected CLI for the whole
// session, so it is a standing bill and the user gets to decide how big it is.
// The switches live in TEDI's header (Install MCP); this end only reads the
// answer off disk, exactly as Rust reads `automationPort`.
//
// The PACK TABLE deliberately is not here. This file ships as a bundle resource
// with only `driver.mjs` beside it and cannot import from `src/`, so the UI
// owns the pack -> tools mapping and writes the resolved flat list. A second
// copy here would drift the first time a tool was renamed.

/** Settings file, without an AppHandle. Both candidates because
 *  `tauri-plugin-store` resolves against the app CONFIG dir, which on Windows is
 *  the same Roaming folder as the data dir but on Linux is not. */
function settingsCandidates() {
  const home = process.env.APPDATA || process.env.XDG_CONFIG_HOME || process.env.HOME || "";
  const id = process.env.TEDI_BUNDLE_ID || "id.ilhamrisky.tedi";
  const roots = [
    process.env.APPDATA,
    process.env.XDG_CONFIG_HOME,
    process.env.HOME && path.join(process.env.HOME, ".config"),
    process.env.HOME && path.join(process.env.HOME, ".local", "share"),
    home,
  ].filter(Boolean);
  return [...new Set(roots)].map((r) => path.join(r, id, "tedi-settings.json"));
}

/** `{ disabledTools, extensions }`, or the permissive default when the file is
 *  absent or unreadable. Never throws: a surface setting must not be able to
 *  stop the server from starting. */
function readSurface() {
  for (const file of settingsCandidates()) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return {
        disabled: new Set(Array.isArray(j.mcpDisabledTools) ? j.mcpDisabledTools : []),
        extensions: Array.isArray(j.mcpExtensionPacks) ? j.mcpExtensionPacks : [],
        // Read HERE because this is already the file that says which app we are
        // configured for - see `cdpPort` for why that matters.
        port: typeof j.automationPort === "number" ? j.automationPort : null,
      };
    } catch {
      // Missing file, unreadable, or not JSON: try the next candidate.
    }
  }
  return { disabled: new Set(), extensions: [], port: null };
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
function currentSurface() {
  const now = Date.now();
  if (!_surface || now - _surfaceAt > 1000) {
    _surface = readSurface();
    _surfaceAt = now;
  }
  return _surface;
}

/**
 * An enabled extension pack's AI tools, advertised as real MCP tools.
 *
 * Cached to disk, because `tools/list` is usually the FIRST thing a client asks
 * and Claude Code launches this server at session start - often before TEDI is
 * open. Querying the live app is the source of truth; the cache is what makes
 * the answer survive a cold start. Prefixed `ext_` so an extension can never
 * shadow one of ours.
 */
const CACHE = path.join(tmpdir(), "tedi-mcp-ext-tools.json");

async function extensionTools() {
  if (!currentSurface().extensions.length) return [];
  let installed = null;
  try {
    installed = await (await tedi()).extensions();
    writeFileSync(CACHE, JSON.stringify(installed));
  } catch {
    // TEDI is not up yet. Serve the last snapshot rather than silently
    // dropping a pack the user switched on.
    try {
      installed = JSON.parse(readFileSync(CACHE, "utf8"));
    } catch {
      return [];
    }
  }
  const wanted = new Set(currentSurface().extensions);
  return (installed ?? [])
    .filter((e) => wanted.has(e.id))
    .flatMap((e) =>
      (e.aiTools ?? []).map((t) => ({
        name: `ext_${t.name}`,
        description: `${t.description ?? ""} (from the ${e.name} extension)`.trim(),
        // The extension owns the real schema; it is not on this side of the
        // boundary, so take an open object and let the handler pass it through.
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        _ext: { extensionId: e.id, tool: t.name },
      })),
    );
}

function coreToolList() {
  const off = currentSurface().disabled;
  return TOOL_NAMES.filter((name) => !off.has(name)).map((name) => ({
    name,
    description: TOOL_DEFS[name].description,
    inputSchema: TOOL_DEFS[name].schema,
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
function ensureExtIndex() {
  extIndexPromise ??= extensionTools().then((list) => ({
    advertised: list.map(({ _ext, ...rest }) => rest),
    routes: new Map(list.map((t) => [t.name, t._ext])),
  }));
  return extIndexPromise;
}

async function listTools() {
  return [...coreToolList(), ...(await ensureExtIndex()).advertised];
}

async function callTool(name, args) {
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
  // The in-process twin (`ai/lib/tediMcpServer.ts`) never had this bug because
  // it never REGISTERS a disabled tool, so there is no handler to reach.
  if (surface.disabled.has(name)) {
    throw new Error(
      `"${name}" is switched off for this MCP server. Turn its pack back on in TEDI: header, Install MCP.`,
    );
  }

  // Only when a pack is actually enabled: otherwise this would connect to TEDI
  // just to learn there is nothing to route.
  const routed = surface.extensions.length ? (await ensureExtIndex()).routes.get(name) : undefined;
  if (routed) {
    const d = await tedi();
    const out = await d.extCommand(routed.extensionId, routed.tool, args ?? {});
    if (!out) throw new Error(`${routed.extensionId} no longer answers to "${routed.tool}".`);
    return out.kind === "aiTool" ? json(out.result) : `ran ${routed.tool}`;
  }
  const tool = TOOLS[name];
  if (!tool) {
    // Only the ENABLED names: the old message printed `Object.keys(TOOLS)`,
    // handing the caller the full list including everything just switched off.
    const have = TOOL_NAMES.filter((n) => !surface.disabled.has(n));
    throw new Error(`Unknown tool "${name}". Have: ${have.join(", ")}`);
  }
  // Shared with the in-process server (`tools.mjs`), so a malformed call is
  // refused identically on both transports. This used to be per-handler
  // `if (!a.id) throw` lines that covered some tools and not others, while the
  // in-process twin got Zod validation for free - the same bad call produced a
  // different outcome depending on which server the agent happened to reach.
  const bad = validateArgs(name, args);
  if (bad) throw new Error(bad);
  const d = await tedi();
  return await tool.run(d, args ?? {});
}

// --- JSON-RPC over stdio ----------------------------------------------------

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  // A notification carries no id and takes no reply. `notifications/initialized`
  // is the only one that arrives here; answering it is a protocol violation.
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize":
      return reply({
        // Echo the client's version when it names one: the field is a
        // negotiation, and pinning our own would make a newer client downgrade.
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tedi", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: await listTools() });
    case "tools/call":
      try {
        const text = await callTool(msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: "text", text: String(text) }] });
      } catch (err) {
        // `isError`, not a JSON-RPC error: a tool failing is something the agent
        // should read and act on (start TEDI, dismiss the toast, pick a real
        // leaf id), not a transport fault that hides the message.
        dropIfDisconnected(err.message);
        return reply({ content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true });
      }
    default:
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
}

if (isMain) {
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
    await driver?.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
