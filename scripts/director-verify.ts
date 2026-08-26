/**
 * Self-check for `scripts/director/`, covering the things nothing else can see.
 * Run: `npx tsx scripts/director-verify.ts` (or `pnpm verify`, which globs it).
 *
 * 1. **The JS the director injects lives inside template literals**, so a typo
 *    in it is invisible to `node --check`, to `tsc`, and to the linter. It only
 *    surfaces at runtime as a CDP exception, mid-task, against the user's real
 *    window. Parsing each expression here is the only check that happens before
 *    the app is even running.
 * 2. **Chord parsing decides which physical key the app is told about.** The
 *    sweep's `Ctrl+/` check cannot guard it, because CodeMirror reads
 *    `event.key` and never looks at the virtual key, so a wrong vk passes there
 *    while breaking anything that does look.
 * 3. **The MCP tool table is what Claude Code reads instead of the README.** A
 *    tool whose schema is malformed, or whose handler calls a `Director` method
 *    that no longer exists, is a dead tool an agent will still choose - and the
 *    failure lands in someone's session, not in CI.
 * 4. **`sh` and `waitTerminal` decide when to STOP**, against a terminal that
 *    was ALREADY at a prompt when the command was written to it. The live sweep
 *    cannot stage that race, so both loops are driven here against a scripted
 *    pane instead. Without it, "returns the previous prompt and calls it the
 *    answer" passes every other check in the repo.
 * 5. **A private pane must stay invisible to a driving agent.** The accessors
 *    live in a closure with nothing importable to call, and the regression that
 *    actually happens is a NEW accessor added without the filter, so that rule
 *    is checked structurally.
 * 6. **What the transport does once TEDI has gone away.** A `WebSocket.send()`
 *    on a closed socket is a silent no-op, so the request parked forever and
 *    took every later one with it. Nothing about that is visible until someone
 *    quits the app mid-session.
 *
 * The rest of the director needs a live TEDI and lives in
 * `scripts/director/sweep.mjs` (`pnpm director sweep`).
 */
import { readFile } from "node:fs/promises";

import { Cdp, Director, parseChord } from "./director/director.mjs";
import { TOOLS } from "./director/mcp.mjs";

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};

// ---------------------------------------------------------------------------
// 1. Every injected expression must parse.
// ---------------------------------------------------------------------------

const expressions: string[] = [];

/**
 * Stands in for the CDP socket: records what would be evaluated, and answers
 * with a shape the caller can keep working from.
 *
 * An array for anything reading `window.__tedi`, an object for the rest. That
 * distinction is not cosmetic: `state()` fans out to `terminals()` AND
 * `editors()`, and the first one to get a non-mappable answer throws into
 * `state`'s degrade path, which would silently skip the rest.
 */
const fakeCdp = {
  send(method: string, params: { expression?: string }) {
    if (method === "Runtime.evaluate" && params.expression) {
      const e = params.expression;
      expressions.push(e);
      // `true` for the write verbs, because each of their handlers checks for
      // exactly that and throws the answer otherwise - an object would send them
      // all down the failure path and the check would prove nothing.
      const value =
        /__tedi\?\.(setSetting|extControl|runExtensionCommand|focusLeaf|termWrite|openFile|editorSave)/.test(
          e,
        )
          ? true
          : /__tedi\?\.(terminals|editors|panes|extensions|listCommands)/.test(e)
            ? []
            : {};
      return Promise.resolve({ result: { value } });
    }
    return Promise.resolve({});
  },
  // Console capture lives on the transport, not behind an injected expression,
  // so the fake has to carry it or `inspect logs` reads as a missing method.
  logs: () => [],
};

const d = new Director(fakeCdp, { url: "index.html" });

console.log("[injected JS] every expression the director evaluates must parse");
// Each of these embeds JS in a template literal. `state()` fans out to
// `paneHandleIndex()`, `terminals()` and `editors()` as well.
await d.state();
await d.box("[data-testid=sidebar]");
await d.text(".cm-content", { nth: 2 });
await d.focusedLeaf();
await d.commands();
await d.metrics();
await d.cmd("pane.splitRight").catch(() => {});
// The `window.__tedi` half: the surface `usePaneHandles` and `useFileActions`
// register. Each is one interpolated call, and each can be broken by a rename on
// either side of the boundary.
await d.terminals();
await d.editors();
await d.panes();
await d.extensions();
await d.extCommand("tedi.sql-explorer", "sql.open");
await d.extControl("disable", "tedi.sql-explorer");
await d.settings();
await d.setSetting("editorFontSize", 15);
await d.focusPane(3);
await d.termWrite(3, "echo hi\r");
await d.openFile("C:/tmp/a.ts");
await d.editorSave(3);
// No terminals in the fake, so this takes the "nothing to wait on" exit rather
// than looping for a minute.
await d.waitTerminal({ timeout: 1 });
// No terminals in the fake, so this exits down the "nothing to write to" path
// rather than looping - which is the branch worth proving anyway.
await d.sh("echo hi").catch(() => {});

if (expressions.length < 22) fail(`only ${expressions.length} expressions captured, expected 22+`);

for (const expr of expressions) {
  const label = expr.replace(/\s+/g, " ").slice(0, 58);
  try {
    // Parses without executing: `document` and `window` are never touched.
    new Function(expr);
    console.log(`  ok: ${label}…`);
  } catch (err) {
    fail(`does not parse: ${label}… (${(err as Error).message})`);
  }
}

// Arguments are interpolated with JSON.stringify, so neither a selector holding
// a quote nor a Windows path full of backslashes may end the string early.
console.log("\n[injection] quotes and backslashes stay inside one string literal");
for (const [what, run] of [
  ["a selector containing double quotes", () => d.box(`button[aria-label="Close pane"]`)],
  ["a Windows path", () => d.openFile("D:\\Ilham\\Project\\a\\b.ts")],
] as [string, () => Promise<unknown>][]) {
  const before = expressions.length;
  await run().catch(() => {});
  try {
    new Function(expressions[before]);
    console.log(`  ok: ${what} still parses`);
  } catch (err) {
    fail(`${what} broke the expression: ${(err as Error).message}`);
  }
}
// The path must also still BE the path. An escape that parses but arrives
// mangled opens the wrong file, which is worse than a syntax error.
const openExpr = expressions.findLast((e) => e.includes("openFile")) ?? "";
if (!openExpr.includes(String.raw`D:\\Ilham\\Project\\a\\b.ts`)) {
  fail(`openFile mangled the path: ${openExpr}`);
} else {
  console.log("  ok: backslashes survive as backslashes");
}

// ---------------------------------------------------------------------------
// 2. Chords carry the virtual key a real keyboard would send.
// ---------------------------------------------------------------------------

console.log("\n[chords] US-layout virtual keys, not the character's own code point");
const chords: [string, number, string | undefined][] = [
  // The regression this exists for: deriving the vk from the character gave 47.
  ["Ctrl+/", 191, "Slash"],
  ["Ctrl+Shift+P", 80, "KeyP"],
  ["Ctrl+S", 83, "KeyS"],
  ["Alt+1", 49, "Digit1"],
  ["Shift+;", 186, "Semicolon"],
  ["Ctrl+-", 189, "Minus"],
  ["Enter", 13, "Enter"],
  ["Escape", 27, "Escape"],
];
for (const [chord, vk, code] of chords) {
  const k = parseChord(chord);
  if (k.vk !== vk || k.code !== code) {
    fail(`${chord} -> vk ${k.vk} / ${k.code}, want ${vk} / ${code}`);
  } else {
    console.log(`  ok: ${chord.padEnd(14)} vk ${String(vk).padStart(3)} ${code}`);
  }
}

console.log("\n[chords] a char event only rides along without Ctrl or Meta held");
// Sending `text` alongside Ctrl makes the page see a literal character on top of
// the shortcut, which is how a "Ctrl+S" once typed an "s" into the document.
if (parseChord("Ctrl+S").text !== undefined) fail("Ctrl+S carries text");
else console.log("  ok: Ctrl+S sends no text");
if (parseChord("Shift+A").text !== "A") fail(`Shift+A text is ${parseChord("Shift+A").text}`);
else console.log('  ok: Shift+A sends text "A"');

// ---------------------------------------------------------------------------
// 3. The MCP tool table is what an agent reads instead of the README.
// ---------------------------------------------------------------------------

console.log("\n[mcp] every tool is well-formed and reaches a real Director method");
// Removing or renaming one of these silently drops a capability from every
// Claude Code session in this repo, and nothing else would notice.
const REQUIRED_TOOLS = [
  "state",
  "inspect",
  "read",
  "run_command",
  "set_setting",
  "extension",
  "wait_for_terminal",
  "sh",
  "open_file",
  "save_editor",
  "keys",
  "type_text",
  "click",
  "focus_pane",
  "drag",
  "screenshot",
  "eval_js",
];
/**
 * The capabilities behind the consolidated verbs. `inspect` and `read` each
 * replaced several tools, and a dropped enum value would remove a whole
 * capability while leaving the tool - and this list - looking intact.
 */
const REQUIRED_MODES: [string, string, string[]][] = [
  ["inspect", "what", ["commands", "extensions", "settings", "logs"]],
  ["read", "source", ["terminal", "editors", "dom"]],
  ["extension", "action", ["enable", "disable", "reload", "update", "uninstall"]],
];
type ToolDef = {
  description?: string;
  schema?: {
    type?: string;
    properties?: Record<string, { type?: unknown; enum?: string[] }>;
    required?: string[];
  };
  run?: unknown;
};
const tools = TOOLS as unknown as Record<string, ToolDef>;

for (const name of REQUIRED_TOOLS) {
  if (!tools[name]) fail(`tool "${name}" is gone`);
}
for (const [tool, prop, modes] of REQUIRED_MODES) {
  const declared = tools[tool]?.schema?.properties?.[prop]?.enum ?? [];
  for (const mode of modes) {
    if (!declared.includes(mode)) fail(`${tool}.${prop} lost "${mode}"`);
  }
}

for (const [name, t] of Object.entries(tools)) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) fail(`tool name "${name}" is not snake_case`);
  if (typeof t.run !== "function") fail(`${name} has no handler`);
  // The description IS the documentation - an agent picks from this list and
  // never reads the source, so a placeholder is a broken tool.
  if (!t.description || t.description.length < 40) fail(`${name} has no usable description`);
  if (t.schema?.type !== "object") fail(`${name} schema is not an object schema`);
  for (const req of t.schema?.required ?? []) {
    if (!t.schema?.properties?.[req]) fail(`${name} requires "${req}" but does not declare it`);
  }
  for (const [prop, spec] of Object.entries(t.schema?.properties ?? {})) {
    if (!(spec as { type?: string }).type) fail(`${name}.${prop} has no type`);
  }
}
console.log(`  ok: ${Object.keys(TOOLS).length} tools, all with a handler and a typed schema`);

// Each handler is called against the fake Director. Nothing reaches a real app,
// but a handler calling a method that no longer exists throws a TypeError here
// instead of in someone's session.
const args: Record<string, Record<string, unknown>[]> = {
  run_command: [{ id: "pane.splitRight" }, { id: "sql.open", extensionId: "tedi.sql-explorer" }],
  // A 1ms timeout: the handler must reach `waitTerminal`, not sit in it.
  wait_for_terminal: [{ timeout: 1 }],
  sh: [{ command: "echo hi" }],
  open_file: [{ path: "C:/tmp/a.ts" }],
  keys: [{ chords: ["Escape"] }],
  type_text: [{ text: "hi" }],
  click: [{ selector: "button" }],
  focus_pane: [{ leafId: 1 }],
  drag: [{ selector: "button", dx: 10, dy: 0 }],
  eval_js: [{ expression: "1" }],
  set_setting: [{ key: "theme", value: "dark" }],
  extension: [{ action: "disable", id: "tedi.sql-explorer" }],
  // Every branch, not just one. A consolidated verb hides a dead mode: the tool
  // still exists, its schema still lists the enum value, and only the arm behind
  // it is broken.
  inspect: [{ what: "commands" }, { what: "extensions" }, { what: "settings" }, { what: "logs" }],
  read: [{ source: "terminal" }, { source: "editors" }, { source: "dom", selector: "button" }],
};
for (const [name, t] of Object.entries(tools)) {
  // `screenshot` writes a file and needs real image bytes back; the others are
  // pure calls into `Director`.
  if (name === "screenshot") continue;
  for (const a of args[name] ?? [{}]) {
    try {
      await (t.run as (d: unknown, a: unknown) => unknown)(d, a);
    } catch (err) {
      const msg = (err as Error).message;
      // A handler is allowed to reject on the fake's empty world ("no terminal
      // pane is open"). It is NOT allowed to reject because the method is gone,
      // nor because it never recognised the mode it was handed.
      if (/is not a function|undefined/i.test(msg)) fail(`${name} handler: ${msg}`);
      if (/^Unknown /.test(msg)) fail(`${name} rejected its own declared mode: ${msg}`);
    }
  }
}
console.log("  ok: every handler, and every mode of one, reaches its Director method");

// ---------------------------------------------------------------------------
// 4. The two polling loops, driven against a scripted terminal.
// ---------------------------------------------------------------------------

/**
 * `sh()` and `waitTerminal()` are the only real state machines in the driver,
 * and both decide when to STOP - which is precisely the kind of logic that
 * looks right and is wrong. Neither can be exercised by the live sweep in the
 * one state that matters (a prompt that was already there before the command
 * ran), so they get a scripted terminal instead.
 *
 * Each entry is what `window.__tedi.terminals()` answers on the next call, so a
 * script is the pane's timeline. The Director's own polling walks it.
 */
type TermState = { atPrompt: boolean; running: boolean; text: string };

/**
 * RUN the expression the director injected, against a stub `window`, and return
 * what the page would have returned.
 *
 * The harness used to answer `__tedi.terminals` reads by handing back the raw
 * rows, which quietly assumed the injected code was the identity function. It is
 * not: every terminal read now REDUCES in the page - a tail, a substring test, a
 * buffer hash - so the polling loops are driven by JS that lived inside a
 * template literal and that nothing executed until it reached a user's window.
 *
 * Executing it here is what makes the `\\n` in that JS checkable at all. Written
 * with one backslash it splits on a literal two-character sequence, the "tail"
 * is the WHOLE buffer, and every `includes()` assertion in this file still
 * passes. Only a line count catches it - see the check below.
 */
function runInjected(expr: string, rows: unknown[]): unknown {
  // `window` as a parameter shadows any global of that name, so the expression
  // reaches the stub and nothing else.
  return new Function("window", `return (${expr});`)({ __tedi: { terminals: () => rows } });
}

function scriptedTerminal(
  script: TermState[],
  { leafId = 3, empty = false, viewportRows = 30 } = {},
) {
  const calls = { terminals: 0, writes: [] as string[], smallReads: 0, asked: [] as number[] };
  const cdp = {
    send(method: string, params: { expression?: string }) {
      if (method !== "Runtime.evaluate") return Promise.resolve({});
      const e = params.expression ?? "";
      if (e.includes("__tedi?.termWrite")) {
        calls.writes.push(e);
        return Promise.resolve({ result: { value: true } });
      }
      if (e.includes("__tedi?.terminals")) {
        const at = Math.min(calls.terminals, script.length - 1);
        calls.terminals++;
        // MODELS THE REAL `getBuffer(n)`, which is the whole point of this
        // harness. It returns the last n ROWS and then strips the trailing blank
        // ones, and `buffer.active.length` counts the empty rows below the
        // cursor. So on a pane that has not scrolled, a read narrower than the
        // viewport lands entirely in blanks and comes back as "" - not an error,
        // an empty string that a change-detector reads as "nothing happened".
        // The flags do not go through the buffer, so they stay truthful.
        const asked = Number(/terminals\?\.\((\d+)\)/.exec(e)?.[1] ?? 200);
        calls.asked.push(asked);
        const blanked = asked < viewportRows;
        if (blanked) calls.smallReads++;
        const row = { leafId, ...script[at], text: blanked ? "" : script[at].text };
        // Through the REAL injected reducer, not around it.
        return Promise.resolve({ result: { value: runInjected(e, empty ? [] : [row]) } });
      }
      // `focusedLeaf()` - the pane the driver would be typing into.
      if (e.includes("activeElement")) return Promise.resolve({ result: { value: leafId } });
      return Promise.resolve({ result: { value: {} } });
    },
  };
  return { calls, d: new Director(cdp, { url: "index.html" }) };
}

// A timeline for one pane. The command's OUTPUT carries a token that appears
// nowhere else - not in the prompt, not in the echoed command line. That is the
// whole point: a `sh` that returns as soon as the prompt looks idle hands back
// the buffer as it was BEFORE the output existed, and a laxer assertion (the
// first version of this check used `includes("hi")`, which "echo hi" satisfies
// on its own) cannot tell that apart from success.
const PROMPT = { atPrompt: true, running: false, text: "PS D:\\repo> " };
const ECHOED = { atPrompt: false, running: true, text: "PS D:\\repo> build" };
const OUTPUT_TOKEN = "artifact-written-9f3a";
const FINISHED = {
  atPrompt: true,
  running: false,
  text: `PS D:\\repo> build\n${OUTPUT_TOKEN}\nPS D:\\repo> `,
};

console.log("\n[sh] does not mistake the PREVIOUS prompt for the command finishing");
{
  // The pane is ALREADY at a prompt when the write lands, and stays that way for
  // one more poll before the shell echoes anything. A "prompt is back" check
  // alone returns right there, with the buffer exactly as it was - which reads
  // like a command that simply printed nothing.
  // `viewportRows: 30` is the second half of this check: the pane has not
  // scrolled, so any read narrower than 30 rows comes back "" (see the harness).
  // A driver that polls with a small read never sees the buffer change, blocks
  // the whole timeout, and then reports "still running" for a command that
  // finished in milliseconds - which invites the caller to run it AGAIN.
  const { calls, d } = scriptedTerminal([PROMPT, PROMPT, ECHOED, ECHOED, FINISHED], {
    viewportRows: 30,
  });
  const out = await d.sh("build", { settle: 20, timeout: 4000 });
  if (out.timedOut) fail("sh timed out on a command that finished");
  else if (!out.text.includes(OUTPUT_TOKEN)) {
    fail(`sh returned before the output existed: ${JSON.stringify(out.text)}`);
  } else if (out.leafId !== 3) fail(`sh reported leaf ${out.leafId}, want 3`);
  else console.log(`  ok: polled ${calls.terminals}x, returned the buffer WITH the output in it`);
  if (calls.smallReads) {
    fail(`sh made ${calls.smallReads} read(s) narrower than the viewport - those return ""`);
  } else console.log("  ok: every text read was wide enough to survive the blank rows");
  if (!calls.writes.length) fail("sh never wrote to the PTY");
  else if (!calls.writes[0].includes("\\r")) fail("sh wrote without a carriage return");
  else console.log("  ok: one PTY write, carriage return included");
}

console.log("\n[reads] a small `lines` trims the ANSWER, and never narrows what xterm is asked");
{
  // The rows-vs-lines trap, made structurally impossible rather than merely
  // avoided. `getBuffer(n)` returns the last n ROWS and strips the trailing
  // blank ones, and on a pane that has not scrolled those last rows ARE the
  // blanks - so a narrow read returns "", which a change-detector reads as
  // "nothing happened". Every read now asks for BUFFER_ROWS and trims in the
  // page, so `lines: 2` is finally an honest thing to pass.
  const { calls, d } = scriptedTerminal([FINISHED], { viewportRows: 30 });
  const rows = (await d.terminals(2)) as { text: string }[];
  if (calls.asked.some((n) => n < 30)) {
    fail(`a read asked xterm for ${Math.min(...calls.asked)} rows - those come back ""`);
  } else console.log(`  ok: asked xterm for ${calls.asked.join("/")} rows while returning 2 lines`);
  // And the trim itself has to have happened, IN THE PAGE. This is the check
  // that catches the `\\n` written with one backslash: the split then happens on
  // a literal two-character sequence, the "tail" is the whole buffer, and every
  // includes()-style assertion in this file still passes.
  const lines = rows[0].text.split("\n");
  if (lines.length !== 2) {
    fail(`injected tail returned ${lines.length} lines, want 2 - is the \\n in it a REAL newline?`);
  } else console.log("  ok: the injected tail split on a real newline");
}

console.log("\n[sh] reports a command that never returns instead of hanging or lying");
{
  // A TUI: output appears, the prompt never comes back.
  const { d } = scriptedTerminal([PROMPT, ECHOED]);
  const out = await d.sh("vim", { settle: 20, timeout: 300 });
  if (!out.timedOut) fail("sh claimed a still-running command had finished");
  else if (!out.text.includes("build")) fail("sh dropped the buffer on timeout");
  else console.log("  ok: timedOut true, buffer still returned");
}

console.log("\n[sh] refuses a leaf that is not a terminal");
{
  // Also the privacy path: a private pane is absent from `terminals()`, so an
  // explicit leafId for one lands here and says nothing about its existence.
  const { d } = scriptedTerminal([PROMPT]);
  await d
    .sh("echo hi", { leafId: 99, settle: 20 })
    .then(() => fail("sh wrote into a leaf that is not a terminal"))
    .catch((err: Error) => {
      if (!/not a terminal/i.test(err.message)) fail(`wrong error: ${err.message}`);
      else console.log("  ok: refused, and named the terminals it does have");
    });
}

console.log("\n[sh] does not guess a pane when focus is elsewhere and several are open");
{
  // `data-pane-leaf` is on EVERY leaf, so `focusedLeaf()` answers with editors
  // and browser panes too. Falling back to "the last terminal" then runs the
  // command in a background pane in another tab - possibly an SSH session on
  // another host - and reports success. One open terminal is unambiguous and
  // still works; more than one is a question only the caller can answer.
  const multi = {
    send(method: string, params: { expression?: string }) {
      if (method !== "Runtime.evaluate") return Promise.resolve({});
      const e = params.expression ?? "";
      if (e.includes("__tedi?.termWrite")) return Promise.resolve({ result: { value: true } });
      if (e.includes("__tedi?.terminals")) {
        const rows = [
          { leafId: 4, ...PROMPT },
          { leafId: 9, ...PROMPT },
        ];
        return Promise.resolve({ result: { value: runInjected(e, rows) } });
      }
      // Focus is in an EDITOR leaf, which is a real leaf id and not a terminal.
      if (e.includes("activeElement")) return Promise.resolve({ result: { value: 7 } });
      return Promise.resolve({ result: { value: {} } });
    },
  };
  await new Director(multi, { url: "index.html" })
    .sh("rm -rf build", { settle: 20, timeout: 500 })
    .then((r) => fail(`sh silently picked leaf ${r.leafId} with focus in an editor`))
    .catch((err: Error) => {
      if (!/name one/i.test(err.message)) fail(`wrong error: ${err.message}`);
      else console.log("  ok: refused and listed the candidates instead of guessing");
    });

  // ...but a single terminal is not a guess, so it still just works.
  const one = scriptedTerminal([PROMPT, PROMPT, ECHOED, FINISHED], { leafId: 4 });
  const r = await one.d.sh("build", { settle: 20, timeout: 3000 });
  if (r.leafId !== 4) fail(`single-terminal fallback picked ${r.leafId}`);
  else console.log("  ok: with one terminal open it runs there without being told");
}

console.log("\n[waitTerminal] both conditions, and the empty case");
{
  // The middle state is the trap: a custom prompt (starship, oh-my-posh) can
  // paint something the PS1 heuristic reads as a prompt WHILE the command is
  // still running. `atPrompt` alone would call that done mid-command.
  const BUSY_BUT_PROMPTY = { atPrompt: true, running: true, text: "PS D:\\repo> build" };
  const { calls, d } = scriptedTerminal([ECHOED, BUSY_BUT_PROMPTY, BUSY_BUT_PROMPTY, FINISHED]);
  const r = await d.waitTerminal({ settle: 20, timeout: 4000 });
  if (!r.done || r.reason !== "prompt returned") fail(`prompt wait: ${JSON.stringify(r)}`);
  else if (!r.tail.includes(OUTPUT_TOKEN)) {
    fail(`returned while the command was still running: ${JSON.stringify(r.tail)}`);
  } else
    console.log(`  ok: prompt case -> ${r.reason}, and it waited out a prompt-shaped busy state`);

  // The two halves of the read-width rule, pinned in both directions, because
  // "optimising" either one is the mistake that keeps getting made.
  //
  // The POLL must be cheap: it reads two booleans, never `t.text`, so there is
  // no buffer to build in the page and nothing for a narrow read to blank out.
  // Widening it back to 200 rows means rebuilding every pane's scrollback three
  // times a second to answer a question about two flags.
  const poll = calls.asked.slice(0, -1);
  if (poll.some((n) => n > 1)) fail(`prompt poll asked for ${Math.max(...poll)} rows, want 1`);
  else console.log(`  ok: ${poll.length} prompt polls, 1 row each (flags only)`);
  // The FINAL read carries text, so it must be wide - a narrow one returns "".
  const last = calls.asked.at(-1) ?? 0;
  if (last < 30) fail(`the tail read asked for ${last} rows - that comes back ""`);
  else console.log(`  ok: the one read that carries text asked for ${last} rows`);
}
{
  // Five lines of output, a two-line tail asked for. The COUNT is the assertion:
  // reads are deliberately wide (see BUFFER_ROWS), so the trim happens in the
  // driver, and a trim that silently does nothing hands the caller the whole
  // 200-row buffer of every pane on every snapshot. `includes()` alone cannot
  // see that, because the untrimmed buffer contains the match too.
  const noisy = {
    atPrompt: false,
    running: true,
    text: "vite v8\nplugins loaded\nwatching\nListening on 5173\nready in 300ms",
  };
  const { d } = scriptedTerminal([ECHOED, ECHOED, noisy]);
  const r = await d.waitTerminal({ text: "Listening on", settle: 20, timeout: 4000, lines: 2 });
  if (!r.done || r.reason !== "text appeared") fail(`text wait: ${JSON.stringify(r)}`);
  else if (!r.tail.includes("ready in 300ms")) fail(`tail lost the end: ${JSON.stringify(r.tail)}`);
  else if (r.tail.split("\n").length !== 2) {
    fail(`tail was not trimmed to 2 lines: ${JSON.stringify(r.tail)}`);
  } else console.log(`  ok: text case -> ${r.reason}, tail trimmed to 2 lines`);
}
{
  // A pane that will never answer must not burn the whole timeout: waiting on an
  // editor, or on a pane that has closed, is a mistake worth surfacing fast.
  const started = Date.now();
  const { d } = scriptedTerminal([PROMPT], { empty: true });
  const r = await d.waitTerminal({ settle: 20, timeout: 30000 });
  if (r.done) fail("waitTerminal claimed done with no terminals");
  else if (Date.now() - started > 5000) fail("waitTerminal sat on the full timeout with no panes");
  else console.log(`  ok: no panes -> "${r.reason}", returned immediately`);
}

console.log("\n[waitTerminal] a timeout is reported, never thrown");
{
  const { d } = scriptedTerminal([ECHOED]);
  const r = await d.waitTerminal({ settle: 20, timeout: 250 });
  if (r.done) fail("waitTerminal claimed a busy pane was done");
  else if (r.reason !== "timeout") fail(`reason was ${r.reason}`);
  else console.log("  ok: timeout reported with the tail, not thrown");
}

// ---------------------------------------------------------------------------
// 5. The privacy gate on the pane surface.
// ---------------------------------------------------------------------------

/**
 * A pane marked `private` must be INVISIBLE to a driving agent - not merely
 * unreadable. `terminal/lib/panes.ts` defines the flag as "the AI never learns
 * of the leaf's existence, cwd, scrollback, or accepts injects/runs on it", and
 * `app/lib/terminalSnapshot.ts` enforces exactly that for TEDI's own agent.
 *
 * This is structural rather than behavioural on purpose. The accessors live in a
 * closure inside a `useEffect`, so there is nothing importable to call; and the
 * regression that will actually happen is not "the filter stopped working", it
 * is "someone added a seventh accessor next year and forgot the filter". A
 * source-level rule catches that on the commit that introduces it, which is the
 * only moment it is cheap to fix.
 */
console.log("\n[privacy] every pane accessor routes through the private-leaf filter");
{
  const src = await readFile("src/app/hooks/usePaneHandles.ts", "utf8");
  const open = src.indexOf("w.__tedi = {");
  const close = src.indexOf("\n    };", open);
  if (open < 0 || close < 0) {
    fail(
      "cannot find the `w.__tedi = {...}` block in usePaneHandles.ts - was it moved or renamed?",
    );
  } else {
    const block = src.slice(open, close);
    // Prettier pins the top-level keys of this object at six spaces, which is
    // what makes a slice-between-keys good enough here without a parser.
    const keys = [...block.matchAll(/^ {6}(\w+):/gm)].map((m) => ({
      name: m[1],
      at: m.index ?? 0,
    }));
    if (keys.length < 6) fail(`only ${keys.length} accessors found; the block shape changed`);
    for (const [i, k] of keys.entries()) {
      const body = block.slice(k.at, keys[i + 1]?.at ?? block.length);
      if (!/publicLeaves\(|isPublic\(/.test(body)) {
        fail(
          `window.__tedi.${k.name} does not go through publicLeaves()/isPublic(): a private pane ` +
            `would be visible or writable through it`,
        );
      }
    }
    if (!failed) console.log(`  ok: all ${keys.length} of ${keys.map((k) => k.name).join(", ")}`);
  }

  // And the filter itself must actually drop the flagged leaf, not merely
  // mention it. `!l.private` is the whole rule; an inverted or missing test here
  // would sail past the structural check above.
  if (!/\.filter\(\(l\) => !l\.private\)/.test(src)) {
    fail("publicLeaves() no longer filters on `!l.private`");
  } else {
    console.log("  ok: publicLeaves() drops leaves carrying the flag");
  }
}

// ---------------------------------------------------------------------------
// 6. The transport, when TEDI goes away.
// ---------------------------------------------------------------------------

/**
 * `WebSocket.send()` on a CLOSING or CLOSED socket is a SILENT NO-OP - only
 * CONNECTING throws. So a request sent after TEDI quits used to register a
 * pending resolver that nothing ever settled: the first tool call after the app
 * closed hung forever, with no error, and because `mcp.mjs` caches the
 * connection for the whole session, so did every call after it.
 *
 * Measured before the guard existed: `eval()` on a closed socket never settled
 * (killed at 4s). After: it rejects in 0ms.
 *
 * The message text is a CONTRACT with `mcp.mjs`, whose `dropIfDisconnected`
 * regex is the only thing that drops the dead connection so the next call can
 * rebuild it. A reworded error would silently disable the reconnect, so the
 * regex is pulled from that file and run against the real message here.
 */
console.log("\n[transport] a closed socket rejects instead of parking forever");
{
  const stub = {
    readyState: WebSocket.CLOSED,
    addEventListener: () => {},
    send: () => fail("send() wrote to a closed socket"),
    close: () => {},
  };
  const message = await new Cdp(stub).send("Runtime.evaluate", { expression: "1" }).then(
    () => {
      fail("send() resolved on a closed socket - the call would hang in production");
      return "";
    },
    (err: Error) => err.message,
  );
  if (message) console.log(`  ok: rejected with ${JSON.stringify(message)}`);

  const mcpSrc = await readFile("scripts/director/mcp.mjs", "utf8");
  const literal = /dropIfDisconnected[\s\S]*?if \((\/[^\n]+?\/i)\.test/.exec(mcpSrc)?.[1];
  if (!literal) fail("cannot find dropIfDisconnected's regex in mcp.mjs");
  else {
    // eslint-disable-next-line no-eval -- a regex literal read from our own source
    const re = eval(literal) as RegExp;
    if (!re.test(message)) {
      fail(
        `mcp.mjs would NOT drop the dead connection: ${literal} does not match ${JSON.stringify(message)}`,
      );
    } else console.log(`  ok: ${literal} matches it, so the next call reconnects`);
  }
}

// ---------------------------------------------------------------------------
// 7. One definition, two transports.
// ---------------------------------------------------------------------------

/**
 * Settings and extension control are reachable two ways: an outside AI CLI comes
 * in through `window.__tedi` over the DevTools socket, and TEDI's own agent calls
 * the same functions directly from `ai/tools/tedi.ts`.
 *
 * The built-in agent deliberately does NOT go through the MCP server. It would
 * have to spawn node and connect back over CDP to the page it is already running
 * in; it would stop working whenever the automation port is off, which is the
 * default; and a page target accepts exactly ONE DevTools client, so it would be
 * competing for the socket with the user's real Claude Code session.
 *
 * What must not be duplicated, then, is the DEFINITION - and the way that rots
 * is quietly: someone inlines the logic back into one of the two registrations,
 * the behaviours drift, and the only symptom is the built-in agent and an
 * outside CLI disagreeing about what a setting does. So both call sites are
 * checked to REFERENCE the shared function rather than re-implement it.
 */
console.log("\n[one definition] both transports call the same functions, not two copies");
const shared: [string, string, string[]][] = [
  [
    "src/modules/settings/preferences.ts",
    "settings",
    ["export function readSettings", "export async function writeSetting"],
  ],
  [
    "src/modules/extensions/store.ts",
    "extensions",
    ["export function listExtensions", "export async function controlExtension"],
  ],
];
const agentTools = await readFile("src/modules/ai/tools/tedi.ts", "utf8");
for (const [file, what, exports] of shared) {
  const src = await readFile(file, "utf8");
  for (const decl of exports) {
    const fn = decl.split(" ").pop() as string;
    if (!src.includes(decl)) fail(`${file} no longer exports ${fn}`);
    // The `window.__tedi` half must POINT at it. An inline arrow function there
    // is exactly the regression this check exists for.
    else if (!new RegExp(`__tedi[\\s\\S]*\\b${fn}\\b`).test(src)) {
      fail(`${file}: window.__tedi does not reference ${fn} - has it been re-implemented inline?`);
    } else if (!agentTools.includes(fn)) {
      fail(`ai/tools/tedi.ts does not use ${fn} - the built-in agent has forked from MCP`);
    } else console.log(`  ok: ${what}.${fn} has one implementation, used by both`);
  }
}
// And the built-in agent must not reach TEDI through the MCP server: that would
// be a subprocess and a socket round trip into its own realm, gated on a port
// that is off by default.
if (/director\/mcp|TEDI_DEBUG_PORT|__tedi\b/.test(agentTools)) {
  fail("ai/tools/tedi.ts reaches for the MCP/automation channel instead of calling in-realm");
} else console.log("  ok: the built-in agent calls in-realm, never through the DevTools socket");

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
