#!/usr/bin/env node
/**
 * MCP server: how Claude Code talks to a running TEDI.
 *
 * Same `Director` the CLI drives, exposed as MCP tools over stdio, which buys
 * three things the CLI cannot:
 *
 *   1. ONE connection for a whole session. Every `pnpm director <verb>` pays a
 *      fresh `/json/list`, a WebSocket attach, `Page.enable`, `Runtime.enable`
 *      and a two-frame settle before it does any work - and a page target
 *      accepts exactly one DevTools client, so each attach/detach cycle is also
 *      a chance to wedge it. Held open, that cost is paid once.
 *   2. Typed arguments. No shell quoting, which on PowerShell is where a
 *      `sh "git log --format=%H"` goes to die.
 *   3. A tool list instead of a README. The schema IS the documentation, so an
 *      agent discovers the surface rather than being told about it.
 *
 * Registered for this repo in `.mcp.json`. TEDI must have been started with
 * `TEDI_DEBUG_PORT` set; if it was not, the tools say so and say how to fix it,
 * because this process starts fine either way (it must - Claude Code launches it
 * at session start, long before anyone has opened TEDI).
 */

import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { connect } from "./director.mjs";

/**
 * True only when this file is the process entry point. `scripts/director-verify.ts`
 * IMPORTS `TOOLS` to check every schema and every injected expression without a
 * running TEDI, and an import that hijacked the console and started reading stdin
 * would hang that check forever.
 */
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

// STDOUT IS THE PROTOCOL. `Director` and `sweep` both print progress, and one
// stray line corrupts the JSON-RPC stream in a way that reads as the server
// crashing. Send every console channel to stderr, which Claude Code shows as
// server logs.
if (isMain) console.log = console.info = console.warn = console.debug = console.error;

const PORT = Number(process.env.TEDI_DEBUG_PORT) || 9222;

/** One connection, made on first use and rebuilt if TEDI restarts under us. */
let director = null;
/** The in-flight connect, cached so two tools called in the same breath share it.
 *  A page target accepts ONE DevTools client, so a race that opens two sockets
 *  does not merely waste one - the loser wedges the target for everyone. */
let connecting = null;

function tedi() {
  if (director) return Promise.resolve(director);
  connecting ??= connect({ port: PORT }).then(
    (d) => {
      director = d;
      connecting = null;
      return d;
    },
    (err) => {
      connecting = null;
      throw err;
    },
  );
  return connecting;
}

/** A dead socket must not poison every later call, so drop the cache and let the
 *  next tool reconnect. Closing TEDI mid-session is ordinary, not exceptional. */
function dropIfDisconnected(message) {
  if (/socket closed|Cannot open|Timed out attaching|No DevTools endpoint/i.test(message)) {
    director = null;
  }
}

const json = (v) => JSON.stringify(v, null, 2);
/**
 * The tool surface. Each entry is name -> description + JSON Schema + handler.
 *
 * TWO RULES, and they pull against each other:
 *
 *   1. The description IS the documentation. An agent picks from this list and
 *      never reads the source, so a trap that produces a SILENT WRONG ANSWER
 *      belongs here - that terminals have no DOM text, that CodeMirror
 *      virtualises, that a `sh` write bypasses the AI-CLI detector. Each of
 *      those returns something plausible and false, and no error would ever say
 *      so.
 *
 *   2. This list is loaded into EVERY request of every AI CLI that connects, for
 *      the whole session, whether it drives TEDI or not. Prose here is a tax on
 *      every turn. So a trap that raises a LOUD ERROR does not belong here - it
 *      belongs in the error, which costs nothing until it fires and arrives
 *      exactly when it is useful. `click` naming the toast that covered the
 *      button, `sh` listing the terminals when the leaf was wrong, `extension`
 *      naming the installed ids: all of those are messages, not schema.
 *
 * Same reason the listing verbs are ONE tool (`inspect`) rather than four: a
 * fourth thing to list costs an enum value here instead of another ~110 tokens
 * of description on every request forever.
 */
export const TOOLS = {
  state: {
    description:
      "Snapshot of the window. Call it first: it names the leafIds every other tool takes. `panes` " +
      "is EVERY pane in EVERY tab with what identifies it - a terminal's cwd, ssh host, running AI " +
      "CLI, prompt state and last output; an editor's path and dirty flag; a browser's url. Plus " +
      "tabs, focus, open modal, toast count, and `paneHandle` for `drag`. Private panes are absent " +
      "by design. One round trip; call it freely.",
    schema: {
      type: "object",
      properties: {
        tail: { type: "number", description: "Terminal lines per pane, default 3." },
        buttons: {
          type: "boolean",
          description: "Also every clickable aria-label. Long; fetch once.",
        },
      },
    },
    run: async (d, a) => json(await d.state({ tail: a.tail ?? 3, buttons: a.buttons === true })),
  },

  inspect: {
    description:
      "List what TEDI has. `commands`: ids for `run_command`. `extensions`: what is installed, " +
      "whether each is ENABLED, and its commands/panels/AI tools - a disabled extension and an " +
      "absent one look identical in the UI. `settings`: every preference the app is running on " +
      "(write with `set_setting`). `logs`: console output and uncaught errors - the only place a " +
      "half-rendered window says why.",
    schema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["commands", "extensions", "settings", "logs"] },
        level: {
          type: "string",
          enum: ["log", "info", "warn", "error"],
          description: "logs only.",
        },
      },
      required: ["what"],
    },
    run: async (d, a) => {
      switch (a.what) {
        case "commands":
          return (await d.commands()).join("\n");
        case "extensions":
          return json(await d.extensions());
        case "settings":
          return json(await d.settings());
        case "logs": {
          const list = d.logs(a.level ?? null);
          return list.length
            ? list.map((l) => `${l.level}: ${l.text}`).join("\n")
            : "(nothing logged since this session connected)";
        }
        default:
          throw new Error(`Unknown "what": ${a.what}. Have: commands, extensions, settings, logs.`);
      }
    },
  },

  read: {
    description:
      "Read one surface. `terminal`: a pane's scrollback, and the ONLY way to see a terminal - xterm " +
      "draws to a WebGL canvas, so DOM tools return nothing for one. `editors`: every open editor's " +
      "path and LIVE buffer, unsaved edits included; never scrape `.cm-content` instead, CodeMirror " +
      "virtualises and a long file comes back short and plausible. `dom`: text of a selector - " +
      "dialogs, the file tree, the AI reply, the status bar.",
    schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["terminal", "editors", "dom"] },
        selector: { type: "string", description: "dom: required." },
        leafId: { type: "number", description: "terminal: default focused." },
        nth: { type: "number" },
        lines: { type: "number", description: "terminal, default 200." },
        maxChars: { type: "number", description: "default 20000." },
      },
      required: ["source"],
    },
    run: async (d, a) => {
      const cap = a.maxChars ?? 20000;
      switch (a.source) {
        case "terminal": {
          const list = await d.terminals(a.lines ?? 200);
          if (!list.length) return "(no terminal panes open)";
          const want = a.leafId ?? (await d.focusedLeaf());
          const one = list.find((t) => t.leafId === want) ?? list.at(-1);
          return `[leaf ${one.leafId} atPrompt=${one.atPrompt} running=${one.running}]\n${one.text}`;
        }
        case "editors": {
          const list = await d.editors(cap);
          if (!list.length) return "(no editor panes open)";
          return list
            .map(
              (e) =>
                `--- leaf ${e.leafId}: ${e.path}${e.truncated ? " (truncated)" : ""}\n${e.text}`,
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
  },

  run_command: {
    description:
      "Run a command by id, bypassing the Command Palette and its fuzzy match. The reliable way to " +
      "split panes, open tabs, toggle the sidebar, open Source Control, zoom. Ids from `inspect " +
      "commands`; pass `extensionId` for one an EXTENSION declared (those live in a registry of " +
      "their own - ids from `inspect extensions`).",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A command id, e.g. pane.splitRight." },
        extensionId: {
          type: "string",
          description: "Set when the command belongs to an extension.",
        },
      },
      required: ["id"],
    },
    run: async (d, a) => {
      if (a.extensionId) {
        if (!(await d.extCommand(a.extensionId, a.id))) {
          throw new Error(
            `Nothing answers to "${a.id}" in ${a.extensionId}. Its extension may be disabled, ` +
              `or the command was declared in the manifest but never given a handler.`,
          );
        }
        return `ran ${a.extensionId}:${a.id}`;
      }
      await d.cmd(a.id);
      return `ran ${a.id}`;
    },
  },

  set_setting: {
    description:
      "Change one TEDI preference; keys and current values from `inspect settings`. Applies live and " +
      "persists. The Settings page is a separate webview no tool here can read or click, so this is " +
      "the only route to it.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "e.g. theme, editorFontSize, vimMode." },
        // A plain string, coerced against the preference's own type on arrival.
        // A union `type: [...]` is legal JSON Schema and the obvious choice, but
        // not every AI CLI's schema converter accepts one, and this tool exists
        // so that ALL of them can drive TEDI.
        value: {
          type: "string",
          description: 'As text: "dark", "true", "14"; JSON for a list or object.',
        },
      },
      required: ["key", "value"],
    },
    run: async (d, a) => {
      const r = await d.setSetting(a.key, a.value);
      if (r !== true) throw new Error(String(r));
      return `${a.key} = ${JSON.stringify(a.value)}`;
    },
  },

  extension: {
    description:
      "Turn an installed extension on or off, reload, update or uninstall it; ids from `inspect " +
      "extensions`. INSTALLING IS NOT HERE - it runs third-party code under a permission set the " +
      "user must review, so send them to that dialog with `run_command settings.open`.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enable", "disable", "reload", "update", "uninstall"] },
        id: { type: "string", description: "e.g. tedi.sql-explorer." },
      },
      required: ["action", "id"],
    },
    run: async (d, a) => {
      const r = await d.extControl(a.action, a.id);
      if (r !== true) throw new Error(String(r));
      return `${a.action}d ${a.id}`;
    },
  },

  wait_for_terminal: {
    description:
      "Block until a terminal pane finishes; returns why it stopped plus its last lines. USE THIS " +
      "INSTEAD OF POLLING `read`. No `text`: waits for the shell prompt, right for a command. " +
      "`text`: waits for that string to appear - the only signal that works for something that never " +
      "returns (dev server, TUI, another AI CLI asking a question). A timeout is reported, not " +
      "thrown.",
    schema: {
      type: "object",
      properties: {
        leafId: { type: "number", description: "Default: focused." },
        text: { type: "string" },
        timeout: { type: "number", description: "ms, default 60000." },
      },
    },
    run: async (d, a) => {
      const r = await d.waitTerminal({
        leafId: a.leafId ?? null,
        text: a.text ?? null,
        timeout: a.timeout ?? 60000,
      });
      return `leaf ${r.leafId}: ${r.done ? "done" : "NOT done"} (${r.reason})\n${r.tail}`;
    },
  },

  sh: {
    description:
      "Run a shell command in a TEDI terminal pane and return its output - the USER'S shell, cwd, " +
      "env and SSH session. Use your own Bash tool for ordinary work. Written to the PTY, so it " +
      "cannot lose characters, and it waits for the prompt. That bypasses xterm input, so TEDI's " +
      "AI-CLI detector never fires: launch an AI CLI with `type_text` + `keys`, or the pane is not " +
      "recognised as running one.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        leafId: {
          type: "number",
          description: "Omit only when focus is in a terminal, or one is open.",
        },
        timeout: {
          type: "number",
          description: "ms for the prompt, default 20000. A TUI never returns; you get the buffer.",
        },
        lines: { type: "number", description: "default 60." },
      },
      required: ["command"],
    },
    run: async (d, a) => {
      const out = await d.sh(a.command, {
        leafId: a.leafId ?? null,
        timeout: a.timeout ?? 20000,
        lines: a.lines ?? 60,
      });
      return out.timedOut
        ? `${out.text}\n\n[leaf ${out.leafId}: still running after the timeout]`
        : `${out.text}\n\n[leaf ${out.leafId}]`;
    },
  },

  open_file: {
    description:
      "Open a file in TEDI's editor by absolute path, exactly as clicking it in the explorer would " +
      "(a PDF still opens in a browser pane). Use it to show the user what you are talking about; " +
      "clicking the tree only reaches paths already expanded into view.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path." } },
      required: ["path"],
    },
    run: async (d, a) => {
      await d.openFile(path.resolve(a.path));
      return `opened ${a.path}`;
    },
  },

  save_editor: {
    description: "Save an editor pane to disk. Use after `type_text` into an editor.",
    schema: {
      type: "object",
      properties: { leafId: { type: "number", description: "Default: the focused pane." } },
    },
    run: async (d, a) => {
      const leaf = a.leafId ?? (await d.focusedLeaf());
      if (!(await d.editorSave(leaf))) throw new Error(`Leaf ${leaf} is not an editor`);
      return `saved leaf ${leaf}`;
    },
  },

  keys: {
    description:
      'Press real key chords in order, e.g. ["Ctrl+Shift+P", "Escape"]. Modifiers: Ctrl, Alt, Shift, ' +
      "Meta/Cmd, Mod (Ctrl, or Cmd on macOS). Needed for anything the app takes off the keyboard " +
      "rather than the command registry: Ctrl+S, Ctrl+/ to comment, Enter to send in the AI " +
      "composer. Also how you close a menu you opened.",
    schema: {
      type: "object",
      properties: { chords: { type: "array", items: { type: "string" } } },
      required: ["chords"],
    },
    run: async (d, a) => {
      await d.keys(...a.chords);
      return `pressed ${a.chords.join(" ")}`;
    },
  },

  type_text: {
    description:
      "Type text as real keystrokes into whatever has focus - an editor, a search box, the AI " +
      "composer. Sends no Enter. For a shell command prefer `sh`, which is instant and cannot drop " +
      "the first character.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        delay: { type: "number", description: "ms between characters (default 10)." },
      },
      required: ["text"],
    },
    run: async (d, a) => {
      await d.type(a.text, { delay: a.delay ?? 10 });
      return `typed ${a.text.length} chars`;
    },
  },

  click: {
    description:
      "Real mouse click at a selector's centre. Scrolls it into view first, and refuses with the " +
      "reason when something covers it. Controls carry `aria-label`, not `title` - list them with " +
      "`state buttons:true`. Tree rows carry `data-fs-path`.",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        nth: { type: "number", description: "Which match (default 0)." },
      },
      required: ["selector"],
    },
    run: async (d, a) => {
      await d.click(a.selector, { nth: a.nth ?? 0 });
      return `clicked ${a.selector}`;
    },
  },

  focus_pane: {
    description:
      "Give a pane keyboard focus without clicking into it, so the next `keys`/`type_text` lands " +
      "there. Clicking works too but moves an editor's caret to wherever the pane's centre was.",
    schema: { type: "object", properties: { leafId: { type: "number" } }, required: ["leafId"] },
    run: async (d, a) => `focused leaf ${a.leafId}: ${await d.focusPane(a.leafId)}`,
  },

  drag: {
    description:
      "Drag a selector by (dx, dy) with real pointer moves. How panes and the sidebar get resized. " +
      "Take the pane splitter's index from `state.paneHandle`; never guess an nth, and -1 means only " +
      "one pane is open.",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        dx: { type: "number" },
        dy: { type: "number" },
        nth: { type: "number" },
      },
      required: ["selector", "dx", "dy"],
    },
    run: async (d, a) => {
      await d.drag(a.selector, a.dx, a.dy, { nth: a.nth ?? 0 });
      return `dragged ${a.selector} by ${a.dx},${a.dy}`;
    },
  },

  screenshot: {
    description:
      "Capture the TEDI window to a PNG and return its path - read that path back to see it. Main " +
      "webview only: browser preview panes and floated panes are separate native webviews and come " +
      "out blank.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to write it. Default: a temp file." },
      },
    },
    run: async (d, a) => {
      const file = a.path
        ? path.resolve(a.path)
        : path.join(mkdtempSync(path.join(tmpdir(), "tedi-shot-")), "tedi.png");
      await d.shot(file);
      return file;
    },
  },

  eval_js: {
    description:
      "Evaluate JavaScript in the TEDI window and return the result (promises awaited). The escape " +
      "hatch for anything the tools above do not model - a store, a computed style, an element " +
      "count. `__TAURI_INTERNALS__.invoke` is reachable from here, so every Rust command is too.",
    schema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    run: async (d, a) => json(await d.eval(a.expression)),
  },
};

const toolList = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: t.schema,
}));

async function callTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool "${name}". Have: ${Object.keys(TOOLS).join(", ")}`);
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
      return reply({ tools: toolList });
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
    await director?.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
