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
 * Descriptions carry the traps, not just the verb: an agent picking a tool from
 * a list has no other place to learn that terminals have no DOM text, or that a
 * `sh` write bypasses the AI-CLI detector.
 */
export const TOOLS = {
  state: {
    description:
      "Snapshot of the whole TEDI window. `panes` is the important part: EVERY pane in EVERY " +
      "tab (not just the visible one) with its leafId, kind, owning tab, and what identifies " +
      "it - a terminal's cwd, ssh host, running AI CLI, whether it is at a prompt and its last " +
      "output; an editor's path and dirty flag; a browser's url; an extension panel's owner. " +
      "Also tabs and labels, focus, any open modal, toast count, every aria-label you can " +
      "click, and the pane-splitter index for `drag`. START HERE - one round trip, and it names " +
      "the leafIds every other tool takes. Panes the user marked private are absent by design.",
    schema: { type: "object", properties: { tail: { type: "number", description: "Terminal lines to include per pane (default 3)." } } },
    run: async (d, a) => json(await d.state({ tail: a.tail ?? 3 })),
  },

  commands: {
    description:
      "Every command id this build has registered, runnable with `run_command`. Two documented " +
      "ids own no handler (`ai.send`, `editor.toggleComment`) because their owners take the key " +
      "directly - drive those with `keys` instead.",
    schema: { type: "object", properties: {} },
    run: async (d) => (await d.commands()).join("\n"),
  },

  run_command: {
    description:
      "Run a command by id, bypassing the Command Palette and its fuzzy match. The reliable way " +
      "to split panes, open tabs, toggle the sidebar, open Source Control, zoom. Pass " +
      "`extensionId` to run a command an EXTENSION declared - those live in a registry of their " +
      "own that `commands` does not list, so get their ids from `extensions`. NOTE: " +
      "`settings.open` and `shortcuts.open` work, but Settings is a SEPARATE webview - no tool " +
      "here can read or click inside it. Drive that window from a shell with " +
      "`pnpm director --target settings <verb>`.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A command id, e.g. pane.splitRight." },
        extensionId: { type: "string", description: "Set when the command belongs to an extension." },
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

  extensions: {
    description:
      "Installed extensions: id, version, whether enabled, and what each contributes - its " +
      "commands (run them with `run_command` + `extensionId`), its panels, and the AI tools it " +
      "lends TEDI's own agent. Check here before concluding a feature is missing: a disabled " +
      "extension and an absent one look identical from the UI.",
    schema: { type: "object", properties: {} },
    run: async (d) => json(await d.extensions()),
  },

  wait_for_terminal: {
    description:
      "Block until a terminal pane finishes, then return why it stopped plus its last lines. " +
      "USE THIS INSTEAD OF POLLING `read_terminal` - one call costs one round trip where a poll " +
      "loop costs one per second. With no `text` it waits for the shell prompt to come back " +
      "(the right signal for a command). With `text` it waits for that string to appear, which " +
      "is the only workable signal for something that never returns: a dev server printing its " +
      "port, a TUI reaching a screen, another AI CLI asking a question. A timeout is reported, " +
      "not thrown - \"still going\" is an answer.",
    schema: {
      type: "object",
      properties: {
        leafId: { type: "number", description: "Which pane (from `state`.panes). Default: the focused one." },
        text: { type: "string", description: "Wait for this string in the buffer instead of for the prompt." },
        timeout: { type: "number", description: "ms (default 60000)." },
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
      "Run a shell command in a TEDI terminal pane and return what it printed. Written straight " +
      "to the PTY, so it is instant and cannot lose characters, and it waits for the prompt to " +
      "come back before reading. Use this to run things in the USER'S terminal, with their shell, " +
      "cwd, env and SSH session; use your own Bash tool for ordinary work. Bypasses xterm input, " +
      "so TEDI's AI-CLI detector does not fire - launch an AI CLI with `type_text` + `keys` instead.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        leafId: { type: "number", description: "Which terminal pane (from `state`.panes). Omit ONLY when the focused pane is a terminal, or exactly one is open - otherwise this refuses rather than guess." },
        timeout: { type: "number", description: "ms to wait for the prompt (default 20000). A TUI never returns; you get the buffer and timedOut:true." },
        lines: { type: "number", description: "Lines of buffer to return (default 60)." },
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

  read_terminal: {
    description:
      "A terminal pane's scrollback. THE ONLY WAY TO SEE A TERMINAL: xterm draws to a WebGL " +
      "canvas, so no DOM-reading tool returns anything for one. Use after starting something " +
      "long-running, or to read a pane you did not run the command in.",
    schema: {
      type: "object",
      properties: {
        leafId: { type: "number", description: "Default: the focused pane." },
        lines: { type: "number", description: "Default 200." },
      },
    },
    run: async (d, a) => {
      const list = await d.terminals(a.lines ?? 200);
      if (!list.length) return "(no terminal panes open)";
      const want = a.leafId ?? (await d.focusedLeaf());
      const one = list.find((t) => t.leafId === want) ?? list.at(-1);
      return `[leaf ${one.leafId} atPrompt=${one.atPrompt} running=${one.running}]\n${one.text}`;
    },
  },

  read_editors: {
    description:
      "Every open editor pane: path plus its LIVE buffer, unsaved edits included. Read this " +
      "rather than the file on disk when you need to know what the user is actually looking at - " +
      "and before writing a file TEDI has open with unsaved changes, which your write would lose.",
    schema: { type: "object", properties: { maxChars: { type: "number", description: "Per-file cap (default 20000)." } } },
    run: async (d, a) => {
      const list = await d.editors(a.maxChars ?? 20000);
      if (!list.length) return "(no editor panes open)";
      return list
        .map((e) => `--- leaf ${e.leafId}: ${e.path}${e.truncated ? " (truncated)" : ""}\n${e.text}`)
        .join("\n\n");
    },
  },

  open_file: {
    description:
      "Open a file in TEDI's editor by absolute path, exactly as clicking it in the explorer " +
      "would (a PDF still opens in a browser pane). Use this to show the user what you are " +
      "talking about; clicking the tree only reaches paths already expanded into view.",
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
    description: "Save an editor pane to disk. Use after the user edits, or after `type_text` into an editor.",
    schema: { type: "object", properties: { leafId: { type: "number", description: "Default: the focused pane." } } },
    run: async (d, a) => {
      const leaf = a.leafId ?? (await d.focusedLeaf());
      if (!(await d.editorSave(leaf))) throw new Error(`Leaf ${leaf} is not an editor`);
      return `saved leaf ${leaf}`;
    },
  },

  keys: {
    description:
      "Press real key chords in order, e.g. [\"Ctrl+Shift+P\", \"Escape\"]. Modifiers: Ctrl, Alt, " +
      "Shift, Meta/Cmd, Mod (Ctrl, or Cmd on macOS). Needed for anything the app takes off the " +
      "keyboard rather than the registry: Ctrl+S to save, Ctrl+/ to comment, Enter to send in the " +
      "AI composer. Also how you close a menu you opened (Escape).",
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
      "composer. Sends no Enter. For a shell command prefer `sh`, which is instant and cannot " +
      "drop the first character.",
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
      "Real mouse click at a selector's centre. Scrolls it into view first, and REFUSES with the " +
      "reason when something covers it (an open modal makes the whole body ignore clicks; a toast " +
      "sits over the header icons - dismiss it or answer the dialog). Controls carry `aria-label`, " +
      "not `title`; `state.buttons` lists them. Tree rows carry `data-fs-path`.",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        nth: { type: "number", description: "Which match, when the selector hits several (default 0)." },
      },
      required: ["selector"],
    },
    run: async (d, a) => {
      await d.click(a.selector, { nth: a.nth ?? 0 });
      return `clicked ${a.selector}`;
    },
  },

  read_dom: {
    description:
      "Text of a DOM selector: dialogs, the file tree, the AI reply, status bar. NOT for terminals " +
      "(WebGL canvas - use `read_terminal`) and NOT for editors (CodeMirror virtualises, so a long " +
      "file reads back short and plausible - use `read_editors`).",
    schema: {
      type: "object",
      properties: { selector: { type: "string" }, nth: { type: "number" } },
      required: ["selector"],
    },
    run: async (d, a) => (await d.text(a.selector, { nth: a.nth ?? 0 })) ?? "(no match)",
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
      "Drag a selector by (dx, dy) with real pointer moves. This is how panes and the sidebar get " +
      "resized - they are resizable-panel handles. Take the pane splitter's index from " +
      "`state.paneHandle`; never guess an nth, and -1 means only one pane is open.",
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
      "Capture the TEDI window to a PNG and return its path - read that path back to actually see " +
      "it. Captures the main webview only: browser preview panes and floated panes are separate " +
      "native webviews and come out blank.",
    schema: { type: "object", properties: { path: { type: "string", description: "Where to write it. Default: a temp file." } } },
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
      "hatch for anything the tools above do not model - reading a store, checking a computed " +
      "style, counting elements.",
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
