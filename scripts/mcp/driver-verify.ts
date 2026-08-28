/**
 * Self-check for `scripts/mcp/`, covering the things nothing else can see.
 * Run: `npx tsx scripts/mcp/driver-verify.ts` (or `pnpm verify`, which globs it).
 *
 * 1. **The JS the driver injects lives inside template literals**, so a typo
 *    in it is invisible to `node --check`, to `tsc`, and to the linter. It only
 *    surfaces at runtime as a CDP exception, mid-task, against the user's real
 *    window. Parsing each expression here is the only check that happens before
 *    the app is even running.
 * 2. **Chord parsing decides which physical key the app is told about.** The
 *    sweep's `Ctrl+/` check cannot guard it, because CodeMirror reads
 *    `event.key` and never looks at the virtual key, so a wrong vk passes there
 *    while breaking anything that does look.
 * 3. **The MCP tool table is what Claude Code reads instead of the README.** A
 *    tool whose schema is malformed, or whose handler calls a `Driver` method
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
 * The rest of the driver needs a live TEDI and lives in
 * `scripts/mcp/sweep.mjs` (`pnpm mcp sweep`).
 */
import { readFile } from "node:fs/promises";

import { Cdp, Driver, parseChord } from "./driver.mjs";
import { TOOLS } from "./server.mjs";

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

const d = new Driver(fakeCdp, { url: "index.html" });

console.log("[injected JS] every expression the driver evaluates must parse");
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
await d.ai();
await d.aiMessages(null, 500);
await d.aiSend("hello");
await d.sshConnections();
await d.sshConnect("c-abc");
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

console.log("\n[mcp] every tool is well-formed and reaches a real Driver method");
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

// Each handler is called against the fake Driver. Nothing reaches a real app,
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
  ai: [{ action: "status" }, { action: "read" }, { action: "send", text: "hi" }],
  ssh: [{ action: "list" }, { action: "connect", id: "c-abc" }],
  browser: [{ action: "reload" }, { action: "url" }],
  // Every branch, not just one. A consolidated verb hides a dead mode: the tool
  // still exists, its schema still lists the enum value, and only the arm behind
  // it is broken.
  inspect: [{ what: "commands" }, { what: "extensions" }, { what: "settings" }, { what: "logs" }],
  read: [{ source: "terminal" }, { source: "editors" }, { source: "dom", selector: "button" }],
};
for (const [name, t] of Object.entries(tools)) {
  // `screenshot` writes a file and needs real image bytes back; the others are
  // pure calls into `Driver`.
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
console.log("  ok: every handler, and every mode of one, reaches its Driver method");

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
 * script is the pane's timeline. The Driver's own polling walks it.
 */
type TermState = { atPrompt: boolean; running: boolean; text: string };

/**
 * RUN the expression the driver injected, against a stub `window`, and return
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
  return { calls, d: new Driver(cdp, { url: "index.html" }) };
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
  await new Driver(multi, { url: "index.html" })
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
  // The accessors used to be spread onto `window.__tedi` here; they are now
  // registered into the capability bridge (`modules/automation/bridge.ts`), which
  // is what lets a second transport call them without a DevTools port. The rule
  // being checked is unchanged: every pane accessor filters private leaves.
  const open = src.indexOf("registerBridge({");
  const close = src.indexOf("\n    });", open);
  if (open < 0 || close < 0) {
    fail(
      "cannot find the `registerBridge({...})` block in usePaneHandles.ts - was it moved or renamed?",
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
          `the "${k.name}" capability does not go through publicLeaves()/isPublic(): a private ` +
            `pane would be visible or writable through it`,
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
 * closed hung forever, with no error, and because `server.mjs` caches the
 * connection for the whole session, so did every call after it.
 *
 * Measured before the guard existed: `eval()` on a closed socket never settled
 * (killed at 4s). After: it rejects in 0ms.
 *
 * The message text is a CONTRACT with `server.mjs`, whose `dropIfDisconnected`
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

  const mcpSrc = await readFile("scripts/mcp/server.mjs", "utf8");
  // Tolerant of where prettier puts the line breaks: once the pattern grew, the
  // condition wrapped onto its own line and an anchor that assumed `if (/…/i.test`
  // on ONE line failed for a purely cosmetic reason.
  const literal = /dropIfDisconnected[\s\S]*?if \(\s*(\/[^\n]+?\/i)[\s\S]{0,40}?\.test/.exec(
    mcpSrc,
  )?.[1];
  if (!literal) fail("cannot find dropIfDisconnected's regex in server.mjs");
  else {
    // eslint-disable-next-line no-eval -- a regex literal read from our own source
    const re = eval(literal) as RegExp;
    if (!re.test(message)) {
      fail(
        `server.mjs would NOT drop the dead connection: ${literal} does not match ${JSON.stringify(message)}`,
      );
    } else console.log(`  ok: ${literal} matches it, so the next call reconnects`);
  }
}

// ---------------------------------------------------------------------------
// 6b. An extension AI tool's RESULT has to come back.
// ---------------------------------------------------------------------------

/**
 * `run_command` reaches two registries through one id. A command is a button
 * press with no answer; an AI tool takes arguments and returns data, and that
 * return IS the reason to call it - "send this request and tell me what came
 * back" versus "open the API Client".
 *
 * The regression to guard is quiet: return the command string for an AI tool
 * and the agent gets `ran tedi.api-client:api_client_send` while the actual
 * HTTP response is dropped on the floor. Nothing errors.
 */
console.log("\n[extension tools] an AI tool's result is returned, a command's is not");
{
  const reply = (value: unknown) => ({
    send: (method: string, params: { expression?: string }) =>
      method === "Runtime.evaluate" && params.expression?.includes("runExtensionCommand")
        ? Promise.resolve({ result: { value } })
        : Promise.resolve({ result: { value: {} } }),
  });
  const call = (value: unknown) =>
    (
      TOOLS as unknown as Record<string, { run: (d: unknown, a: unknown) => Promise<string> }>
    ).run_command.run(new Driver(reply(value), { url: "index.html" }), {
      id: "api_client_send",
      extensionId: "tedi.api-client",
      args: { method: "GET" },
    });

  const body = { status: 200, body: '{"ok":true}' };
  const got = await call({ kind: "aiTool", result: body });
  if (!got.includes('"status": 200')) fail(`AI tool result was dropped: ${got}`);
  else console.log("  ok: the tool's own answer comes back, not a 'ran ...' string");

  const ran = await call({ kind: "command" });
  if (!ran.startsWith("ran ")) fail(`a command should report that it ran, got: ${ran}`);
  else console.log("  ok: a command still reports that it ran");

  // `false` is the "nothing answers" contract shared with a disabled extension.
  await call(false).then(
    () => fail("an unanswered id resolved instead of refusing"),
    (err: Error) => {
      if (!/Nothing answers/.test(err.message)) fail(`wrong refusal: ${err.message}`);
      else console.log("  ok: an id nothing answers to refuses, and says where to look");
    },
  );
}

// ---------------------------------------------------------------------------
// 6c. The pack table and the tool table must cover each other exactly.
// ---------------------------------------------------------------------------

/**
 * The MCP surface is switchable per pack, and the pack table lives in the UI
 * (`mcpInstall/packs.ts`) because the server ships as a bundle resource that
 * cannot import from `src/`. That split is the right one, and it has exactly one
 * failure mode: the two lists drifting.
 *
 * Both directions are silent. A tool missing from every pack can never be
 * switched off - the dialog looks complete and one capability quietly ignores
 * it. A pack naming a tool that no longer exists puts a dead switch in the
 * dialog that turns nothing off, which is worse, because the user believes they
 * closed something.
 */
console.log("\n[mcp packs] every tool is in exactly one pack, and every pack entry is a real tool");
const { MCP_PACKS, disabledToolsFor } = await import("../../src/modules/mcpInstall/packs");
const packed = MCP_PACKS.flatMap((p) => p.tools);
const toolNames = Object.keys(tools);

const orphanTools = toolNames.filter((n) => !packed.includes(n));
if (orphanTools.length) fail(`tools in no pack, so they can never be switched off: ${orphanTools}`);
else console.log(`  ok: all ${toolNames.length} tools are covered by a pack`);

const deadEntries = packed.filter((n) => !toolNames.includes(n));
if (deadEntries.length) fail(`packs name tools that do not exist (dead switches): ${deadEntries}`);
else console.log(`  ok: all ${packed.length} pack entries name a real tool`);

const dupes = packed.filter((n, i) => packed.indexOf(n) !== i);
if (dupes.length) fail(`a tool is in two packs, so one switch cannot turn it off: ${dupes}`);
else console.log("  ok: no tool is in two packs");

// The in-process server (ai/lib/tediMcpServer.ts) serves the SAME surface to
// TEDI's own agent, gated by the SAME resolved `mcpDisabledTools` names. So its
// tools must be a SUBSET of the stdio ones: a name that is not in a pack matches
// no switch, which would leave that tool permanently on for the built-in agent
// while the dialog claims it is off - a bypass of the very switch, from inside.
const tediMcpSrc = await readFile("src/modules/ai/lib/tediMcpServer.ts", "utf8");
// The handler table's top-level keys. Both servers now take every description
// and schema from `scripts/mcp/tools.mjs`, so this is the only thing left
// that can be wrong on this side: a handler for a name the table does not have.
// (`tediMcpServer.ts` also throws at load for that; this catches it in CI.)
const handlersBlock = tediMcpSrc.slice(
  tediMcpSrc.indexOf("const HANDLERS: Record<string, Handler> = {"),
);
const TEDI_MCP_TOOL_NAMES = [...handlersBlock.matchAll(/^ {2}([a-z_]+): async \(/gm)].map(
  (m) => m[1],
);
if (!TEDI_MCP_TOOL_NAMES.length) fail("no handlers found in tediMcpServer.ts");

// THE ARCHITECTURE RULE, checked directly: descriptions and schemas are declared
// in ONE place. This replaces a check that compared two hand-kept name lists -
// which only ever caught a rename, and never caught the thing that actually went
// wrong (the two `ssh` schemas drifting apart under the same name).
// Matches a DECLARED value, not a forwarded one: `description: "..."` or
// `inputSchema: {` / `inputSchema: z.` is a second definition, while
// `description: TOOL_DEFS[name].description` is the shared table being served.
let declaredOwn = 0;
for (const [re, what] of [
  [/description:\s*["'`]/, "a literal tool description"],
  [/inputSchema:\s*[{z]/, "an input schema of its own"],
] as const) {
  if (re.test(tediMcpSrc)) {
    declaredOwn++;
    fail(
      `tediMcpServer.ts declares ${what} - descriptions and schemas must come from scripts/mcp/tools.mjs, or the two transports drift apart again`,
    );
  }
}
if (!declaredOwn) {
  console.log("  ok: the in-process server declares no descriptions or schemas of its own");
}
const ungated = TEDI_MCP_TOOL_NAMES.filter((n) => !packed.includes(n));
if (ungated.length) {
  fail(`the built-in agent's MCP tools are in no pack, so a switch cannot reach them: ${ungated}`);
} else {
  console.log(
    `  ok: all ${TEDI_MCP_TOOL_NAMES.length} built-in-agent tools are gated by the same packs`,
  );
}
const notReal = TEDI_MCP_TOOL_NAMES.filter((n) => !toolNames.includes(n));
if (notReal.length) {
  fail(`the built-in agent offers tools the stdio server does not - two surfaces: ${notReal}`);
} else console.log("  ok: the built-in agent's tool names match the stdio server's");

// `state`/`inspect` must stay reachable: they are how an agent finds anything,
// including the fact that the rest was switched off.
const always = MCP_PACKS.filter((p) => p.always).flatMap((p) => p.tools);
for (const must of ["state", "inspect"]) {
  if (!always.includes(must)) fail(`${must} must be in an "always" pack - it is the way in`);
}
if (disabledToolsFor(MCP_PACKS.map((p) => p.id)).some((t) => always.includes(t))) {
  fail("turning every pack off would disable the always-on ones");
} else console.log("  ok: state and inspect survive switching everything off");

// Structural, because the real thing needs a live app: `tools/list` and
// `tools/call` are dispatched CONCURRENTLY (replies carry their id, so a client
// need not wait), and the first version built the extension index inside
// `tools/list` alone. A call that arrived first found it empty and refused with
// "Unknown tool" for a tool the same session had just advertised. Both paths
// must go through the one cached promise.
const mcpSource = await readFile("scripts/mcp/server.mjs", "utf8");
// The whole function body, not a fixed-size window: a 600-char slice meant that
// adding a comment inside `callTool` failed this check without anything having
// changed about the behaviour it guards.
const callBody = mcpSource.slice(
  mcpSource.indexOf("async function callTool"),
  mcpSource.indexOf("// --- JSON-RPC over stdio"),
);
if (!/ensureExtIndex\(\)/.test(callBody)) {
  fail("callTool does not await ensureExtIndex - an extension tool call can race tools/list");
} else
  console.log("  ok: a tool call builds the extension index itself, without waiting for a list");

// ---------------------------------------------------------------------------
// 6c. The bridged-method map must stay true.
// ---------------------------------------------------------------------------
//
// `transport.mjs` routes a call to the local socket when `BRIDGED` names it, and
// to CDP otherwise. Two ways that can rot, both silent:
//
//   * a name that is no longer a `Driver` method - the CDP fallback would throw
//     "no such method" only on a machine where the bridge is down, i.e. rarely
//     and confusingly;
//   * a method listed here that is NOT a pure `this.#tedi(...)` call - it would
//     read the DOM or dispatch input, which the socket cannot do, so the bridge
//     would answer with something quietly wrong instead of nothing.
//
// The second is the one worth catching: it is the difference between a tool that
// fails and a tool that lies.
console.log("\n[bridge] every bridged method is a real, in-realm-only Driver method");
{
  const { BRIDGED } = await import("./transport.mjs");
  const driverSrc = await readFile("scripts/mcp/driver.mjs", "utf8");
  const proto = Object.getOwnPropertyNames(Driver.prototype);
  for (const [method, capability] of Object.entries(BRIDGED as Record<string, string>)) {
    if (!proto.includes(method)) {
      fail(`BRIDGED names "${method}", which is not a Driver method`);
      continue;
    }
    // The body between this method and the next: a bridged one is a single
    // `return this.#tedi("<capability>", ...)`.
    const at = driverSrc.indexOf(`\n  ${method}(`);
    if (at < 0) continue; // defined with a different signature style; skip
    const body = driverSrc.slice(at, driverSrc.indexOf("\n  }", at));
    if (!body.includes("#tedi(")) {
      fail(
        `BRIDGED routes "${method}" to the socket, but it does not go through #tedi() - it reads the DOM or dispatches input, which the socket cannot do`,
      );
    } else if (!body.includes(`#tedi("${capability}"`)) {
      fail(
        `BRIDGED maps "${method}" to capability "${capability}", but the Driver calls a different one`,
      );
    }
  }
  if (!failed) {
    console.log(
      `  ok: all ${Object.keys(BRIDGED as object).length} bridged methods are pure in-realm calls`,
    );
  }
}

// ---------------------------------------------------------------------------
//
// ONE PROFILE HAS TO DECIDE BOTH HALVES OF "which TEDI am I driving".
// `TEDI_BUNDLE_ID` picks the settings file (pack switches) and the bridge
// socket; the CDP port was a bare `env.TEDI_DEBUG_PORT || 9222` beside it. With
// the id set and the port not - which is every hand-written config, and every
// dev run - this server read ONE app's switches and dispatched REAL KEYSTROKES
// into ANOTHER app's window. An end-to-end run did exactly that: aimed at a dev
// profile, it sent `keys` and `screenshot` into the installed release.
console.log("\n[cdp port] the port comes from the profile the bundle id names");
{
  const { resolveCdpPort } = (await import("./server.mjs")) as unknown as {
    resolveCdpPort: (env: unknown, stored: number | null) => number | null;
  };
  const cases: [string, unknown, number | null, number | null][] = [
    ["an explicit env var always wins", "9500", 9223, 9500],
    ["...even when the profile says off", "9500", 0, 9500],
    ["no env var: the profile's own port", undefined, 9223, 9223],
    ["a profile with the channel off resolves to nothing", undefined, 0, null],
    ["a profile that never stored one falls back to the default", undefined, null, 9222],
    ["an empty env var is not a port", "", 9223, 9223],
    ["a non-numeric env var is not a port", "yes", 9223, 9223],
  ];
  for (const [label, env, stored, want] of cases) {
    const got = resolveCdpPort(env, stored);
    if (got === want) console.log(`  ok: ${label} (${String(got)})`);
    else fail(`${label}: got ${String(got)}, want ${String(want)}`);
  }
  // The one that was the bug: a named profile with its own port must NEVER
  // resolve to the default, because the default is whatever OTHER TEDI is up.
  if (resolveCdpPort(undefined, 9223) === 9222) {
    fail("a dev profile still resolves to 9222 - it would drive the installed release");
  }
}

// ---------------------------------------------------------------------------
//
// The transport is a Proxy with a catch-all `get`, and `server.mjs` reaches it
// through `await tedi()`. `await` decides whether something is a promise by
// reading `.then` and checking it is callable - so a proxy that answers every
// property WITH A FUNCTION is adopted as a thenable, and the language calls
// `then(resolve, reject)` and waits. Nothing ever resolved it: every tool call
// hung, and the throw inside that orphaned call killed the server process, which
// the client reported as "Connection closed".
//
// It shipped, because nothing here reaches `tedi()` without an app and the live
// sweep drives `Driver` directly. This does it with no TEDI running at all: the
// checks are about what the LANGUAGE asks the proxy, not about what it answers.
console.log("\n[transport] the proxy must not pass for a promise");
{
  const { makeTransport } = await import("./transport.mjs");
  const t = makeTransport({ port: 1 }) as Record<string, unknown>;

  if (t.then === undefined) console.log("  ok: `then` is undefined, so it is not thenable");
  else fail("the transport proxy answers `then`, so `await` will treat it as a promise and hang");

  if (t[Symbol.iterator as unknown as string] === undefined) {
    console.log("  ok: well-known symbols are undefined too");
  } else {
    fail("the proxy answers well-known symbols - inspect/stringify/iteration would throw");
  }

  // The actual failure, end to end, with no app: this used to never settle.
  const settled = await Promise.race([
    Promise.resolve(t).then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((r) => setTimeout(() => r("HUNG"), 1500)),
  ]);
  if (settled === "resolved") console.log("  ok: `await tedi()` settles with no TEDI running");
  else fail(`\`await\` on the transport ${settled === "HUNG" ? "never settled" : "rejected"}`);

  // And it is still a working driver afterwards.
  if (typeof t.state === "function") console.log("  ok: real methods still resolve to functions");
  else fail("guarding `then` broke ordinary method lookup");
}

// ---------------------------------------------------------------------------
// 7. One definition, two transports.
// ---------------------------------------------------------------------------

/**
 * Settings and extension control are reachable two ways: an outside AI CLI comes
 * in through `window.__tedi` over the DevTools socket, and TEDI's own agent calls
 * the same functions over an in-process MCP server, `ai/lib/tediMcpServer.ts`.
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
const agentTools = await readFile("src/modules/ai/lib/tediMcpServer.ts", "utf8");
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
      fail(`ai/lib/tediMcpServer.ts does not use ${fn} - the built-in agent has forked from MCP`);
    } else console.log(`  ok: ${what}.${fn} has one implementation, used by both`);
  }
}
// And the built-in agent must not reach TEDI through the STDIO server: that
// would be a subprocess and a socket round trip into its own realm, gated on a
// port that is off by default. Test the CODE, not the file text - the header
// comment explains that decision and names the very things this forbids.
const agentCode = agentTools.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
if (/mcp\/server|TEDI_DEBUG_PORT|__tedi\b/.test(agentCode)) {
  fail("tediMcpServer.ts reaches for the stdio/automation channel instead of calling in-realm");
} else console.log("  ok: the built-in agent calls in-realm, never through the DevTools socket");

// ---------------------------------------------------------------------------
// 8. A preference with a fixed set of values must REJECT anything outside it.
// ---------------------------------------------------------------------------
//
// `set_setting` is the one place an agent sets a preference by name. A typeof
// check alone accepted `theme: "default"`, reported ok, and left a value no code
// path renders - so the model was told it succeeded, saw nothing change, and
// guessed again. Every entry must be DERIVED from the runtime list its type
// comes from, or the table silently stops matching the real options.
console.log("\n[preferences] a fixed-set value cannot be written outside its set");
const storeSrc = await readFile("src/modules/settings/store.ts", "utf8");
const allowBlock = /const ALLOWED_VALUES[\s\S]*?\n\};/.exec(storeSrc)?.[0] ?? "";
if (!allowBlock) {
  fail("ALLOWED_VALUES is gone - set_setting would accept any string again");
} else {
  const literalArrays = /:\s*\[/.test(allowBlock.replace(/^[^{]*\{/, ""));
  if (literalArrays) {
    fail("ALLOWED_VALUES has an inline literal - derive it from the runtime list instead");
  } else console.log("  ok: every allowed set is derived from its runtime list");

  for (const key of ["theme", "approvalMode", "editorTheme", "defaultProviderId"]) {
    if (!new RegExp(`\\b${key}:`).test(allowBlock)) fail(`${key} lost its allowed-value check`);
    else console.log(`  ok: ${key} is validated`);
  }
}

// A preference whose DEFAULT is `null` has no type to infer, and that was read
// as "nothing to check at all": the branch returned before the allow-list ran.
// `defaultProviderId` defaults to null, so listing it above achieves nothing
// unless that branch consults the set - and `getProvider` throws on an id
// outside it, so the write succeeded and the NEXT agent turn was what broke.
{
  const fn = /export async function _writePreference[\s\S]*?\n\}/.exec(storeSrc)?.[0] ?? "";
  const nullBranch = /if \(expected === null\) \{([\s\S]*?)\n  \}/.exec(fn)?.[1] ?? "";
  if (!nullBranch) fail("the null-default branch of _writePreference is gone - recheck this");
  else if (!/outsideSet|allowed/.test(nullBranch)) {
    fail(
      "a null-default preference skips ALLOWED_VALUES again - defaultProviderId would accept any string",
    );
  } else console.log("  ok: a null default still has to satisfy its allowed set");
}
if (!/must be one of/.test(storeSrc)) {
  fail("the rejection no longer names the allowed set, so a model cannot recover from it");
} else console.log("  ok: a rejection names the allowed set");

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
