#!/usr/bin/env node
/**
 * CLI over `director.mjs`. Drives and records a running TEDI window.
 *
 * TEDI must be started with the debug port open:
 *   $env:TEDI_DEBUG_PORT = "9222"; pnpm tauri:dev
 *
 * Then, from the repo root:
 *   pnpm director targets
 *   pnpm director commands
 *   pnpm director cmd pane.splitRight
 *   pnpm director keys Ctrl+Shift+P Escape
 *   pnpm director shot out.png
 *   pnpm director rec intro --seconds 20
 *   pnpm director run scripts/director/takes/demo.mjs --rec demo
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, listTargets, sleep } from "./director.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = path.join(REPO_ROOT, "recordings");

const USAGE = `tedi director - drive and record a running TEDI window

  targets                        list DevTools targets (liveness check)
  state                          one snapshot: tabs, panes, focus, dialogs, terminals
  commands                       list runnable TEDI command ids
  eval <js>                      evaluate JS in the window, print the result
  cmd <commandId>                run a TEDI command by id
  keys <chord> [chord...]        press chords, e.g. Ctrl+Shift+P
  type <text>                    type text with a human cadence
  sh <command>                   run a shell command in the focused terminal, wait for the prompt
  term [leafId]                  print a terminal's buffer (the only way to read one)
  text <selector>                read a pane back (editor, tree, dialogs; not terminals)
  click <selector>               real mouse click at a selector's centre
  drag <selector> <dx> <dy>      drag a selector (pane splitters resize this way)
  shot <file.png>                capture a still
  rec <name> [--seconds N]       record a screencast (Ctrl+C to stop if no --seconds)
  run <take.mjs> [--rec <name>]  run a take script, optionally recording it

options
  --port <n>       DevTools port (default $TEDI_DEBUG_PORT or 9222)
  --target <text>  match a window by url/title substring (default: the main window)
  --out <dir>      recording root (default recordings/)
  --size <WxH>     override the recorded viewport, e.g. 1920x1080
  --delay <ms>     per-character delay for \`type\` (default 45)
  --nth <n>        which match to click/drag when a selector hits several
  --lines <n>      terminal lines to read back (default 200; 40 for \`sh\`)
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
  for (const t of targets) console.log(`${t.type.padEnd(8)} ${t.title || "(untitled)"}\n         ${t.url}`);
  process.exit(0);
}

const d = await connect({ port, target: opts.target });

if (opts.size) {
  const [w, h] = opts.size.split("x").map(Number);
  if (!w || !h) throw new Error(`--size wants WxH, got "${opts.size}"`);
  await d.setViewport(w, h);
}

/**
 * Record into `<out>/<name>`, stopping on --seconds or Ctrl+C, then report.
 * `after` runs once the recording has STOPPED, so a take can put the app back
 * without its cleanup ending up in the footage.
 */
async function recordUntilDone(name, body, after) {
  const dir = path.join(path.resolve(opts.out ?? DEFAULT_OUT), name);
  await d.record(dir);
  console.log(`recording -> ${dir}`);
  let stopped = false;
  const finish = async (code = 0) => {
    if (stopped) return;
    stopped = true;
    const take = await d.stop();
    console.log(
      `${take.frames.length} frames, ${take.durationSec.toFixed(1)}s, ${take.width}x${take.height}`,
    );
    if (after) {
      try {
        await after();
      } catch (err) {
        console.error(`teardown failed: ${err.message}`);
      }
    }
    // Close the socket BEFORE exiting: a half-open session leaves the page
    // target occupied and the next run hangs on connect.
    await d.close();
    process.exit(code);
  };
  process.on("SIGINT", () => void finish());
  // `finally`: a take is MEANT to throw (click refuses when a modal is up,
  // waitFor times out, cmd rejects an unregistered id), and without this the
  // one that throws at second 40 of 44 loses `take.json` entirely - frames on
  // disk, timeline gone, and with it every caption and mark. Report the failure,
  // but only after the take has been closed out.
  let failure = null;
  try {
    if (body) await body();
    if (opts.seconds) await sleep(Number(opts.seconds) * 1000);
    else if (!body) await new Promise(() => {}); // wait for Ctrl+C
  } catch (err) {
    failure = err;
  } finally {
    if (failure) console.error(`take failed: ${failure.message}`);
    await finish(failure ? 1 : 0);
  }
}

// `finally`, not a trailing call: a verb that throws must still hand the page
// target back, or the next run hangs on connect.
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
  case "sh": {
    // Read back the pane that was typed into, not "the last one": the focused
    // leaf is the one that took the keystrokes, and after a split the newest
    // pane and the focused pane stop being the same thing.
    const leafId = await d.focusedLeaf();
    await d.command(args.join(" "), { delay: Number(opts.delay ?? 45), leafId });
    // Print what it produced. A driver that runs a command and cannot read the
    // output is doing half of what a human does.
    const after = await d.terminals(Number(opts.lines ?? 40));
    console.log((after.find((t) => t.leafId === leafId) ?? after.at(-1))?.text ?? "");
    break;
  }
  case "term": {
    const list = await d.terminals(Number(opts.lines ?? 200));
    const want = args[0] ? Number(args[0]) : await d.focusedLeaf();
    const one = list.find((t) => t.leafId === want) ?? list.at(-1);
    if (!one) throw new Error(`no terminals. Targets seen: ${list.map((t) => t.leafId).join(", ") || "none"}`);
    console.log(one.text);
    break;
  }
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
  case "rec":
    await recordUntilDone(args[0] ?? "take", null);
    break;
  case "run": {
    const takePath = path.resolve(args[0]);
    const mod = await import(pathToFileURL(takePath).href);
    const take = mod.default ?? mod.run;
    if (typeof take !== "function") throw new Error(`${takePath} must default-export a function`);
    // Optional `setup` runs BEFORE recording starts: staging the scene (opening
    // the right folder, clearing a pane) should not be in the shot. `teardown`
    // runs after it stops, for the same reason in reverse.
    if (typeof mod.setup === "function") await mod.setup(d);
    const teardown = typeof mod.teardown === "function" ? () => mod.teardown(d) : null;
    if (opts.rec) await recordUntilDone(opts.rec, () => take(d), teardown);
    else {
      await take(d);
      if (teardown) await teardown();
    }
    break;
  }
  default:
    process.stderr.write(`Unknown verb "${verb}"\n\n${USAGE}`);
    process.exitCode = 1;
  }
} finally {
  await d.close();
}
