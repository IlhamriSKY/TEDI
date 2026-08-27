#!/usr/bin/env node
/**
 * Human-facing CLI over `driver.mjs`, for driving a running TEDI window by
 * hand and for debugging the driver itself.
 *
 * Claude Code does NOT go through here - it talks to `server.mjs`, which holds ONE
 * connection open for a whole session instead of paying an attach/detach per
 * call. Everything below is the same `Driver`, so a verb proven here works
 * there.
 *
 * TEDI must have been started with the debug port open:
 *   $env:TEDI_DEBUG_PORT = "9222"; pnpm tauri:dev
 *
 * Then, from the repo root:
 *   pnpm mcp state
 *   pnpm mcp cmd pane.splitRight
 *   pnpm mcp sh "git status"
 *   pnpm mcp sweep
 */

import path from "node:path";
import { connect, listTargets } from "./driver.mjs";

const USAGE = `tedi mcp - drive a running TEDI window

seeing
  targets                        list DevTools targets (also the liveness check)
  state                          one snapshot: every pane in every tab, focus, dialogs, buttons
  panes                          every pane in every tab: kind, cwd/path/url, agent, busy
  extensions                     installed extensions + the commands and panels they add
  settings                       every preference the app is running on
  logs [level]                   console output + uncaught errors since connecting
  term [leafId]                  a terminal's buffer (the only way to read one)
  editors                        every open editor: path + live buffer, unsaved edits included
  text <selector>                read the DOM back (tree, dialogs; NOT terminals or long files)
  shot <file.png>                capture a still
  eval <js>                      evaluate JS in the window, print the result

driving
  commands                       list runnable TEDI command ids
  cmd <commandId>                run a TEDI command by id
  ext <extensionId> <commandId>  run a command an extension declared
  extctl <action> <extensionId>  enable | disable | reload | update | uninstall
  set <key> <value>              change one preference (see \`settings\`)
  wait [--leaf n] [--text s]     block until a pane is back at its prompt (or prints s)
  keys <chord> [chord...]        press chords, e.g. Ctrl+Shift+P
  type <text>                    type text as real keystrokes, character at a time
  sh <command>                   run a shell command in a terminal, wait, print the output
  open <file>                    open a file in the editor by path
  save [leafId]                  save an editor pane
  focus <leafId>                 give a pane keyboard focus without clicking it
  click <selector>               real mouse click at a selector's centre
  drag <selector> <dx> <dy>      drag a selector (pane splitters resize this way)

checking
  sweep                          walk the whole surface and assert a change per area

options
  --port <n>       DevTools port (default $TEDI_DEBUG_PORT or 9222)
  --target <text>  match a window by url/title substring (default: the main window)
  --leaf <n>       which pane \`sh\` runs in (default: the focused terminal)
  --size <WxH>     override the viewport, e.g. 1920x1080
  --delay <ms>     per-character delay for \`type\` (default 45)
  --nth <n>        which match to click/drag when a selector hits several
  --lines <n>      terminal lines to read back (default 200; 60 for \`sh\`)
  --timeout <ms>   how long \`sh\` waits for the prompt (default 20000; \`wait\` 60000)
  --text <s>       for \`wait\`: stop when this appears instead of at the prompt
  --trace          print the stack as well as the message when something fails
`;

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { opts, rest };
}

const { opts, rest } = parseArgs(process.argv.slice(2));
const [verb, ...args] = rest;

if (!verb || verb === "help" || verb === "--help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

const port = Number(opts.port) || Number(process.env.TEDI_DEBUG_PORT) || 9222;

if (verb === "targets") {
  const targets = await listTargets(port);
  for (const t of targets)
    console.log(`${t.type.padEnd(8)} ${t.title || "(untitled)"}\n         ${t.url}`);
  process.exit(0);
}

const d = await connect({ port, target: opts.target });

if (opts.size) {
  const [w, h] = opts.size.split("x").map(Number);
  if (!w || !h) throw new Error(`--size wants WxH, got "${opts.size}"`);
  await d.setViewport(w, h);
}

const leafOpt = opts.leaf === undefined ? null : Number(opts.leaf);

// `finally`, not a trailing call: a verb that throws must still hand the page
// target back. A page target accepts ONE DevTools client, so a half-open socket
// leaves it occupied and the NEXT run hangs on connect with no error at all.
try {
  switch (verb) {
    case "commands":
      console.log((await d.commands()).join("\n"));
      break;
    case "eval":
      console.log(JSON.stringify(await d.eval(args.join(" ")), null, 2));
      break;
    case "cmd":
      await d.cmd(args[0]);
      break;
    case "keys":
      await d.keys(...args);
      break;
    case "type":
      await d.type(args.join(" "), { delay: Number(opts.delay ?? 45) });
      break;
    case "state":
      console.log(JSON.stringify(await d.state(), null, 2));
      break;
    case "panes":
      console.log(JSON.stringify(await d.panes(), null, 2));
      break;
    case "extensions":
      console.log(JSON.stringify(await d.extensions(), null, 2));
      break;
    case "ext": {
      // A third argument is JSON, for an extension AI TOOL (which takes
      // arguments and returns data) rather than a command (which takes none).
      // Both live behind the same id lookup; only the answer differs.
      const extArgs = args[2] ? JSON.parse(args.slice(2).join(" ")) : undefined;
      const out = await d.extCommand(args[0], args[1], extArgs);
      if (!out) {
        throw new Error(`Nothing answers to "${args[1]}" in ${args[0]} (disabled, or no handler)`);
      }
      if (out.kind === "aiTool") console.log(JSON.stringify(out.result, null, 2));
      break;
    }
    case "extctl": {
      const r = await d.extControl(args[0], args[1]);
      if (r !== true) throw new Error(String(r));
      break;
    }
    case "settings":
      console.log(JSON.stringify(await d.settings(), null, 2));
      break;
    case "set": {
      // The value arrives as shell text and is coerced against the
      // preference's own type on the other side, so `set vimMode true` works
      // without the caller having to think about JSON.
      const r = await d.setSetting(args[0], args.slice(1).join(" "));
      if (r !== true) throw new Error(String(r));
      break;
    }
    case "logs": {
      const list = d.logs(args[0] ?? null);
      console.log(list.map((l) => `${l.level}: ${l.text}`).join("\n") || "(nothing logged)");
      break;
    }
    case "wait": {
      const r = await d.waitTerminal({
        leafId: leafOpt,
        text: opts.text ?? null,
        timeout: Number(opts.timeout ?? 60000),
      });
      console.log(`leaf ${r.leafId}: ${r.done ? "done" : "NOT done"} (${r.reason})`);
      console.log(r.tail);
      if (!r.done) process.exitCode = 1;
      break;
    }
    case "sh": {
      const out = await d.sh(args.join(" "), {
        leafId: leafOpt,
        lines: Number(opts.lines ?? 60),
        timeout: Number(opts.timeout ?? 20000),
      });
      console.log(out.text);
      // A TUI legitimately never returns to a prompt, so this is a note, not a
      // failure - but a caller that reads stdout alone must still be told the
      // output may be a half-finished command.
      if (out.timedOut) console.error(`(still running after the timeout, leaf ${out.leafId})`);
      break;
    }
    case "term": {
      const list = await d.terminals(Number(opts.lines ?? 200));
      const want = args[0] ? Number(args[0]) : await d.focusedLeaf();
      const one = list.find((t) => t.leafId === want) ?? list.at(-1);
      if (!one) throw new Error("No terminal panes are open.");
      console.log(one.text);
      break;
    }
    case "editors": {
      const list = await d.editors();
      for (const e of list) {
        console.log(`--- leaf ${e.leafId}: ${e.path}${e.truncated ? " (truncated)" : ""}`);
        console.log(e.text);
      }
      if (!list.length) console.log("(no editor panes open)");
      break;
    }
    case "open":
      await d.openFile(path.resolve(args[0]));
      break;
    case "save":
      await d.editorSave(args[0] ? Number(args[0]) : await d.focusedLeaf());
      break;
    case "focus":
      await d.focusPane(Number(args[0]));
      break;
    case "text":
      console.log(await d.text(args[0], { nth: Number(opts.nth ?? 0) }));
      break;
    case "click":
      await d.click(args[0], { nth: Number(opts.nth ?? 0) });
      break;
    case "drag":
      await d.drag(args[0], Number(args[1]), Number(args[2]), { nth: Number(opts.nth ?? 0) });
      break;
    case "shot":
      console.log(await d.shot(path.resolve(args[0] ?? "shot.png")));
      break;
    case "sweep": {
      // Imported here, not at the top: it is 700 lines of checks that no other
      // verb needs loaded.
      const { default: sweep } = await import("./sweep.mjs");
      const { pass, total } = await sweep(d);
      if (pass < total) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write(`Unknown verb "${verb}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
} catch (err) {
  // The message, not a stack. Every error thrown down here is meant for a
  // person - "this build predates termWrite", "a modal is open and swallows the
  // click", "leaf 4 is not a terminal" - and a Node stack trace buries all three
  // under the same wall of frames. `--trace` when the frames are what you want.
  process.stderr.write(`${err.message}\n`);
  if (opts.trace !== undefined) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
} finally {
  await d.close();
}
