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
import { HANDLERS } from "./handlers.mjs";
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

/** True for the `{ v }`-enveloped shape `Driver#tedi` builds. */
const isTediCall = (e: string): boolean => e.includes("=> ({ v })");

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
          : // The pane mutators answer `{ok}` or a reason, and every handler
            // branches on `ok === true`. A bare `{}` would send them all down
            // the failure path, so the check would prove only that they throw.
            /__tedi\?\.(paneOpen|paneClose|paneGroup|paneRotate|paneConsolidate|paneRename|panePin|panePlace|panelOpen|sshForward|agentSession)/.test(
                e,
              )
            ? { ok: true, tabId: 1, leafId: 2, orientation: "row", changed: true, moved: 2 }
            : // `browserAct` answers a status string; "ok" is the success one.
              /__tedi\?\.browserAct/.test(e)
              ? "ok"
              : // Two terminals, so `consolidate` reaches the mutator instead of
                // stopping at "fewer than two are open".
                /__tedi\?\.termList/.test(e)
                ? [
                    { leafId: 1, tabId: 1 },
                    { leafId: 2, tabId: 1 },
                  ]
                : /__tedi\?\.(terminals|editors|panes|extensions|listCommands|browserConsole)/.test(
                      e,
                    )
                  ? []
                  : {};
      // A `#tedi` call is wrapped as `{ v }` so a legitimate null can be told
      // apart from a missing capability; a bare `eval` (box, metrics) is not.
      return Promise.resolve({ result: { value: isTediCall(e) ? { v: value } : value } });
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
await d.waitTerminal({ timeout: 1 }).catch(() => {});
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
  lsp: [{ op: "hover", path: "a.ts", line: 1, symbol: "a" }],
  skill: [{}, { name: "a" }],
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
  ai: [
    { action: "status" },
    { action: "read" },
    { action: "send", text: "hi" },
    { action: "new" },
    { action: "switch", sessionId: "s-abc" },
    { action: "stop" },
  ],
  ssh: [
    { action: "list" },
    { action: "connect", id: "c-abc" },
    { action: "forward", leafId: 1, remoteHost: "localhost", remotePort: 80 },
  ],
  sftp: [{ action: "list", leafId: 1 }],
  session: [{ action: "rename", id: "s", title: "t" }],
  workspace: [
    { action: "switch", id: "ws-abc" },
    { action: "create", name: "Scratch" },
    { action: "rename", id: "ws-abc", name: "Scratch" },
    { action: "view", id: "ws-abc", view: "canvas" },
  ],
  schedule: [
    { action: "list" },
    { action: "create", command: "echo hi", delay: 60 },
    { action: "create", command: "echo hi", at: "2030-01-01T00:00:00Z", submit: false },
    { action: "cancel", id: "sch-abc" },
  ],
  // `screenshot` is left out for the same reason the `screenshot` TOOL is
  // skipped below: it writes a file and wants real image bytes back.
  browser: [
    { action: "reload" },
    { action: "url" },
    { action: "list" },
    { action: "read", fields: true },
    { action: "console" },
    { action: "navigate", url: "https://example.com" },
    { action: "click", index: 0 },
    { action: "type", index: 0, text: "hi" },
    { action: "hover", index: 0 },
    { action: "key", text: "Escape" },
    { action: "scroll", to: "down" },
    { action: "click_at", x: 10, y: 20 },
  ],
  pane: [
    { action: "open" },
    { action: "open", split: true, dir: "col", count: 2 },
    { action: "close", leafId: 2 },
    { action: "close", all: true },
    { action: "group", leafIds: [1, 2] },
    { action: "rotate", leafId: 1, dir: "col" },
    { action: "consolidate" },
    { action: "rename", leafId: 1, name: "build" },
    { action: "pin", leafId: 1, pinned: false },
    { action: "place", leafId: 1, x: 10 },
    { action: "panel", extensionId: "tedi.sql-explorer" },
  ],
  // Every branch, not just one. A consolidated verb hides a dead mode: the tool
  // still exists, its schema still lists the enum value, and only the arm behind
  // it is broken.
  inspect: [
    { what: "status" },
    { what: "sessions" },
    { what: "commands" },
    { what: "extensions" },
    { what: "settings" },
    { what: "logs" },
  ],
  read: [{ source: "terminal" }, { source: "editors" }, { source: "dom", selector: "button" }],
};
/** Stands in for the socket. Same answers `fakeCdp` gives a driver, for the same reasons. */
const answerOf = (name: string): unknown => {
  if (
    /^(setSetting|extControl|runExtensionCommand|focusPaneVerified|openFile|editorSave)$/.test(name)
  )
    return true;
  if (
    /^(paneOpen|paneClose|paneGroup|paneRotate|paneConsolidate|paneRename|panePin|panePlace|panelOpen|sshForward|agentSession|workspaceCreate|workspaceSwitch|workspaceRename|workspaceRemove|workspaceView)$/.test(
      name,
    )
  ) {
    return {
      ok: true,
      tabId: 1,
      leafId: 2,
      orientation: "row",
      changed: true,
      moved: 2,
      wsId: "w",
    };
  }
  if (name === "termList" || name === "termProbe" || name === "termTails") {
    return [
      {
        leafId: 1,
        tabId: 1,
        atPrompt: true,
        running: false,
        alt: false,
        hash: 1,
        hit: true,
        text: "",
      },
      {
        leafId: 2,
        tabId: 1,
        atPrompt: true,
        running: false,
        alt: false,
        hash: 1,
        hit: true,
        text: "",
      },
    ];
  }
  // What `Runtime.evaluate` answers: enough for the input verbs to find their target.
  if (name === "devtools") return { result: { value: { x: 0, y: 0, width: 10, height: 10 } } };
  if (name === "focusedLeaf") return 1;
  if (name === "termBusy") return false;
  if (name === "termRun" || name === "termInject" || name === "aiSend" || name === "aiSwitch")
    return true;
  if (name === "sshConnect") return 5;
  if (/^(editors|panes|extensions|listCommands|workspaces|statusItems)$/.test(name)) return [];
  return {};
};
const fakeTransport = {
  call: async (name: string) => answerOf(name),
  logs: async () => [],
  devtools: async () => d,
};
for (const [name, t] of Object.entries(tools)) {
  // `screenshot` writes a file and needs real image bytes back; the others are
  // pure calls.
  if (name === "screenshot") continue;
  for (const a of args[name] ?? [{}]) {
    try {
      await (t.run as (d: unknown, a: unknown) => unknown)(fakeTransport, a);
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
console.log("  ok: every handler, and every mode of one, reaches its capability");

// Every name a handler calls has to be one the app registers. A typo here is a tool
// that fails only in someone's session, with "No capability", on the path that matters.
console.log("\n[capabilities] every capability a handler calls is registered in the app");
{
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = `${dir}/${f}`;
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  // Text of every file that registers any, which is enough to catch a misspelt name.
  let registering = "";
  for (const file of walk("src")) {
    const src = await readFile(file, "utf8");
    if (src.includes("registerBridge(")) registering += src;
  }
  const handlersSrc = await readFile("scripts/mcp/handlers.mjs", "utf8");
  const called = new Set([...handlersSrc.matchAll(/call\(\s*"(\w+)"/g)].map((m) => m[1]));
  const missing = [...called].filter(
    (name) => !new RegExp(`\\b${name}\\s*[:,(}]`).test(registering),
  );
  if (called.size < 30)
    fail(`only ${called.size} capabilities found in handlers.mjs; the reader broke`);
  else if (missing.length)
    fail(`handlers call capabilities nothing registers: ${missing.join(", ")}`);
  else console.log(`  ok: all ${called.size} are registered`);
}

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
 * Play the app's terminal capabilities against a scripted timeline.
 *
 * WHAT MOVED, AND WHY THIS HARNESS CHANGED SHAPE. The per-poll reduction used to
 * be JS the driver INJECTED as a template literal, so this file executed that
 * string to check it. Injection is CDP and CDP is Windows-only, which left `sh`,
 * `wait_for_terminal`, `state` and `read` dead on macOS and Linux - so the
 * reductions moved into the app (`usePaneHandles.ts`: `termTails`, `termProbe`)
 * and the driver now calls them by name over whichever transport it has.
 *
 * The stub below therefore plays the CAPABILITY, not the injected string. It
 * still models the trap the old one existed for: `getBuffer(n)` returns the last
 * n ROWS and strips the trailing blanks, so on a pane that has not scrolled a
 * read narrower than the viewport comes back "" - an empty string a
 * change-detector reads as "nothing happened". The app-side rule that prevents
 * it (always ask `TERMINAL_BUFFER_ROWS`, trim after) is what `calls.asked`
 * checks here.
 */
const TERMINAL_BUFFER_ROWS = 200;

function tailLines(text: string, n: number): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function scriptedTerminal(
  script: TermState[],
  { leafId = 3, empty = false, viewportRows = 30, busy = false, alt = false, agent = "" } = {},
) {
  const calls = { terminals: 0, writes: [] as string[], smallReads: 0, asked: [] as number[] };
  let holdUntilWrite = false;

  /** `getBuffer(rows)` as xterm really behaves it. */
  const buffer = (text: string, rows: number): string => {
    calls.asked.push(rows);
    if (rows < viewportRows) {
      calls.smallReads++;
      return "";
    }
    return text;
  };

  const rowsNow = (): Array<TermState & { leafId: number }> => {
    if (empty) return [];
    // `sh` looks at the pane before it writes, and the timeline starts at that write.
    if (holdUntilWrite && !calls.writes.length) return [{ leafId, ...script[0] }];
    const at = Math.min(calls.terminals, script.length - 1);
    calls.terminals++;
    return [{ leafId, ...script[at] }];
  };

  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    switch (name) {
      case "termProbe": {
        const [needle, wantHash = true] = args as [string | null, boolean?];
        return rowsNow().map((r) => {
          // Mirrors the capability: no buffer is built at all unless a hash or a
          // needle actually needs one.
          const text = needle || wantHash ? buffer(r.text, TERMINAL_BUFFER_ROWS) : "";
          return {
            leafId: r.leafId,
            atPrompt: r.atPrompt,
            running: r.running,
            alt,
            hash: wantHash ? fnv1a(text) : 0,
            hit: needle ? text.includes(needle) : false,
          };
        });
      }
      case "termTails":
        return rowsNow().map((r) => ({
          leafId: r.leafId,
          atPrompt: r.atPrompt,
          running: r.running,
          text: tailLines(buffer(r.text, TERMINAL_BUFFER_ROWS), args[0] as number),
        }));
      case "termList":
        return empty ? [] : [{ leafId, tabId: 1 }];
      case "focusedLeaf":
        return leafId;
      case "termBusy":
        return busy;
      case "termAltScreen":
        return alt;
      case "panes":
        return [{ leafId, agent }];
      case "termRun":
      case "termInject":
        calls.writes.push(args[1] as string);
        return true;
      default:
        throw new Error(`the script does not answer ${name}`);
    }
  };
  const run = (tool: string, a: Record<string, unknown>) =>
    (HANDLERS as Record<string, (c: typeof call, a: unknown) => Promise<any>>)[tool](call, a);
  return {
    calls,
    sh: (a: Record<string, unknown>) => {
      holdUntilWrite = true;
      return run("sh", a);
    },
    wait: (a: Record<string, unknown>) => run("wait_for_terminal", a),
    read: (a: Record<string, unknown>) => run("read", { source: "terminal", ...a }),
  };
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
  const { calls, sh } = scriptedTerminal([PROMPT, PROMPT, ECHOED, ECHOED, FINISHED], {
    viewportRows: 30,
  });
  const out = await sh({ command: "build", timeout: 4000 });
  if (out.timedOut) fail("sh timed out on a command that finished");
  else if (!out.text.includes(OUTPUT_TOKEN)) {
    fail(`sh returned before the output existed: ${JSON.stringify(out.text)}`);
  } else if (out.leafId !== 3) fail(`sh reported leaf ${out.leafId}, want 3`);
  else console.log(`  ok: polled ${calls.terminals}x, returned the buffer WITH the output in it`);
  if (calls.smallReads) {
    fail(`sh made ${calls.smallReads} read(s) narrower than the viewport - those return ""`);
  } else console.log("  ok: every text read was wide enough to survive the blank rows");
  if (calls.writes.length !== 1) fail(`sh wrote ${calls.writes.length} times, want 1`);
  else console.log("  ok: one write");
}

console.log("\n[reads] a small `lines` trims the ANSWER, and never narrows what xterm is asked");
{
  // The rows-vs-lines trap, made structurally impossible rather than merely
  // avoided. `getBuffer(n)` returns the last n ROWS and strips the trailing
  // blank ones, and on a pane that has not scrolled those last rows ARE the
  // blanks - so a narrow read returns "", which a change-detector reads as
  // "nothing happened". Every read now asks for BUFFER_ROWS and trims in the
  // page, so `lines: 2` is finally an honest thing to pass.
  const { calls, read } = scriptedTerminal([FINISHED], { viewportRows: 30 });
  const answer = await read({ lines: 2 });
  if (calls.asked.some((n) => n < 30)) {
    fail(`a read asked xterm for ${Math.min(...calls.asked)} rows - those come back ""`);
  } else console.log(`  ok: asked xterm for ${calls.asked.join("/")} rows while returning 2 lines`);
  // And the trim itself has to have happened, IN THE PAGE. This is the check
  // that catches the `\\n` written with one backslash: the split then happens on
  // a literal two-character sequence, the "tail" is the whole buffer, and every
  // includes()-style assertion in this file still passes.
  const lines = (answer.text as string).split("\n");
  if (lines.length !== 2) {
    fail(`injected tail returned ${lines.length} lines, want 2 - is the \\n in it a REAL newline?`);
  } else console.log("  ok: the injected tail split on a real newline");
}

console.log("\n[sh] reports a command that never returns instead of hanging or lying");
{
  // A TUI: output appears, the prompt never comes back.
  const { sh } = scriptedTerminal([PROMPT, ECHOED]);
  const out = await sh({ command: "vim", timeout: 300 });
  if (!out.timedOut) fail("sh claimed a still-running command had finished");
  else if (!out.text.includes("build")) fail("sh dropped the buffer on timeout");
  else console.log("  ok: timedOut true, buffer still returned");
}

console.log("\n[sh] refuses a leaf that is not a terminal");
{
  // Also the privacy path: a private pane is absent from `terminals()`, so an
  // explicit leafId for one lands here and says nothing about its existence.
  const { sh } = scriptedTerminal([PROMPT]);
  await sh({ command: "echo hi", leafId: 99 })
    .then(() => fail("sh wrote into a leaf that is not a terminal"))
    .catch((err: Error) => {
      if (!/not a terminal/i.test(err.message)) fail(`wrong error: ${err.message}`);
      else console.log("  ok: refused, and named the terminals it does have");
    });
}

console.log("\n[sh] does not guess a pane when focus is elsewhere and several are open");
{
  // `data-pane-leaf` is on EVERY leaf, so `focusedLeaf()` answers with editors
  // and extension panes too. Falling back to "the last terminal" then runs the
  // command in a background pane in another tab - possibly an SSH session on
  // another host - and reports success. One open terminal is unambiguous and
  // still works; more than one is a question only the caller can answer.
  const writes: unknown[] = [];
  const multi = async (name: string, ...args: unknown[]): Promise<unknown> => {
    if (name === "termProbe") {
      return [4, 9].map((leafId) => ({
        leafId,
        atPrompt: true,
        running: false,
        hash: 1,
        hit: false,
      }));
    }
    // Focus is in an EDITOR leaf, which is a real leaf id and not a terminal.
    if (name === "focusedLeaf") return 7;
    writes.push(args);
    return true;
  };
  await (HANDLERS as any).sh(multi, { command: "rm -rf build" }).then(
    (r: { leafId: number }) => fail(`sh silently picked leaf ${r.leafId} with focus in an editor`),
    (err: Error) => {
      if (!/pass leafId/i.test(err.message)) fail(`wrong error: ${err.message}`);
      else if (writes.length) fail("sh wrote before it knew which pane");
      else console.log("  ok: refused and listed the candidates instead of guessing");
    },
  );

  // ...but a single terminal is not a guess, so it still just works.
  const one = scriptedTerminal([PROMPT, PROMPT, ECHOED, FINISHED], { leafId: 4 });
  const r = await one.sh({ command: "build", timeout: 3000 });
  if (r.leafId !== 4) fail(`single-terminal fallback picked ${r.leafId}`);
  else console.log("  ok: with one terminal open it runs there without being told");
}

// `sh` from outside used to skip this, while the tool's own description promised it.
console.log("\n[sh] a busy pane is refused, unless it is reading its own input");
{
  const running = { atPrompt: false, running: true, text: "PS D:\\repo> build" };
  const build = scriptedTerminal([running]);
  await build.sh({ command: "echo hi" }).then(
    () => fail("sh typed into a running command"),
    (err: Error) => {
      if (!/is busy/.test(err.message)) fail(`wrong error: ${err.message}`);
      else if (build.calls.writes.length) fail("sh wrote before refusing");
      else console.log("  ok: a build on the normal screen refuses, and nothing is written");
    },
  );
  const tui = scriptedTerminal([running], { alt: true });
  const typed = await tui.sh({ command: "hello" });
  if (!typed.intoTui || tui.calls.writes.length !== 1) fail("sh did not type into a TUI");
  else console.log("  ok: a full-screen program takes the write, and the reply says so");
  // An AI CLI can draw on the normal screen, where it looks exactly like a build.
  const cli = scriptedTerminal([running], { agent: "claude" });
  const told = await cli.sh({ command: "hello" });
  if (!told.intoTui || cli.calls.writes.length !== 1) fail("sh did not type into an AI CLI");
  else console.log("  ok: so does an AI CLI on the normal screen");
  // An idle AI CLI reads as not running, and there is still no prompt coming from it.
  const idleCli = scriptedTerminal([{ atPrompt: false, running: false, text: "> " }], {
    agent: "claude",
  });
  const quick = await idleCli.sh({ command: "hello", timeout: 20000 });
  if (!quick.intoTui || quick.timedOut) fail("sh waited for a prompt from an idle AI CLI");
  else console.log("  ok: an idle AI CLI takes the write without waiting for a prompt");

  // pwsh never sends OSC 133 C for a PTY write, so a running command reads as not running. A
  // live run typed `echo` into a `ping` this way, right after a fix that trusted `running`.
  const pinging = { atPrompt: false, running: false, text: "PS D:\\repo> ping x\nReply from x" };
  const quietBusy = scriptedTerminal([pinging]);
  await quietBusy.sh({ command: "echo hi" }).then(
    () => fail("sh typed into a command pwsh reports as not running"),
    (err: Error) => {
      if (!/is busy/.test(err.message) || quietBusy.calls.writes.length) fail(err.message);
      else console.log("  ok: a command with no running flag still refuses, by its last line");
    },
  );
  const halfTyped = scriptedTerminal([{ atPrompt: false, running: false, text: "PS D:\\repo> x" }]);
  await halfTyped.sh({ command: "echo hi" }).then(
    () => fail("sh merged with a half-typed line"),
    () => console.log("  ok: so does a half-typed line"),
  );

  // Going quiet is not finishing: `Start-Sleep 5` prints nothing, with no running flag either.
  const sleeping = { atPrompt: false, running: false, text: "PS D:\\repo> Start-Sleep 5; build" };
  const silent = scriptedTerminal([PROMPT, ...Array(30).fill(sleeping), FINISHED]);
  const slept = await silent.sh({ command: "Start-Sleep 5; build", timeout: 20000 });
  if (!slept.text.includes(OUTPUT_TOKEN)) fail(`sh returned during the silence: ${slept.text}`);
  else console.log("  ok: a silent command is waited for, not called finished");

  // Git Bash, starship, a bare `$ `: nothing recognises the prompt, and nothing is running.
  const bare = { atPrompt: false, running: false, text: "$ " };
  const done = { atPrompt: false, running: false, text: `$ build\n${"artifact-bare"}\n$ ` };
  const custom = scriptedTerminal([bare, bare, done]);
  const ran = await custom.sh({ command: "build", timeout: 10000 });
  if (custom.calls.writes.length !== 1) fail("sh refused an idle shell with a custom prompt");
  else if (ran.timedOut) fail("sh sat out the timeout on a command that finished");
  else if (!ran.text.includes("artifact-bare")) fail(`sh lost the output: ${ran.text}`);
  else console.log("  ok: an idle custom prompt runs the command and comes back when output stops");
}

console.log("\n[waitTerminal] both conditions, and the empty case");
{
  // The middle state is the trap: a custom prompt (starship, oh-my-posh) can
  // paint something the PS1 heuristic reads as a prompt WHILE the command is
  // still running. `atPrompt` alone would call that done mid-command.
  const BUSY_BUT_PROMPTY = { atPrompt: true, running: true, text: "PS D:\\repo> build" };
  const { calls, wait } = scriptedTerminal([ECHOED, BUSY_BUT_PROMPTY, BUSY_BUT_PROMPTY, FINISHED]);
  const r = await wait({ timeout: 4000 });
  if (!r.done || r.reason !== "back at the prompt") fail(`prompt wait: ${JSON.stringify(r)}`);
  else if (!r.tail.includes(OUTPUT_TOKEN)) {
    fail(`returned while the command was still running: ${JSON.stringify(r.tail)}`);
  } else
    console.log(`  ok: prompt case -> ${r.reason}, and it waited out a prompt-shaped busy state`);

  // The two halves of the read-width rule, pinned in both directions, because
  // "optimising" either one is the mistake that keeps getting made.
  //
  // The POLL must be cheap: it reads two booleans that do not come from the
  // buffer, so it must not build one AT ALL - `termProbe(needle, wantHash)` is
  // called with `wantHash: false` here, and a buffer read would mean rebuilding
  // every pane's scrollback several times a second to answer a question about
  // two flags. Stricter than the old "ask for 1 row" rule, which still built one.
  const poll = calls.asked.slice(0, -1);
  if (poll.length) fail(`prompt poll read the buffer ${poll.length}x, want 0`);
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
  const { wait } = scriptedTerminal([ECHOED, ECHOED, noisy]);
  const r = await wait({ text: "Listening on", timeout: 4000, lines: 2 });
  if (!r.done || !/appeared/.test(r.reason)) fail(`text wait: ${JSON.stringify(r)}`);
  else if (!r.tail.includes("ready in 300ms")) fail(`tail lost the end: ${JSON.stringify(r.tail)}`);
  else if (r.tail.split("\n").length !== 2) {
    fail(`tail was not trimmed to 2 lines: ${JSON.stringify(r.tail)}`);
  } else console.log(`  ok: text case -> ${r.reason}, tail trimmed to 2 lines`);
}
{
  // A pane that will never answer must not burn the whole timeout: waiting on an
  // editor, or on a pane that has closed, is a mistake worth surfacing fast.
  const started = Date.now();
  const { wait } = scriptedTerminal([PROMPT], { empty: true });
  await wait({ timeout: 30000 }).then(
    (r: { done: boolean }) => {
      if (r.done) fail("the wait claimed done with no terminals");
    },
    (err: Error) => {
      if (Date.now() - started > 5000) fail("the wait sat on the full timeout with no panes");
      else console.log(`  ok: no panes -> "${err.message}", returned immediately`);
    },
  );
}

console.log("\n[waitTerminal] a timeout is reported, never thrown");
{
  const { wait } = scriptedTerminal([ECHOED]);
  const r = await wait({ timeout: 250 });
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

/**
 * The same rule, for the leaf-addressed capabilities registered ELSEWHERE.
 *
 * The block above reads one file, and the regression it exists to catch - "a new
 * accessor was written without the filter" - happened in a different one:
 * `sshExec` takes a leafId and runs a command on a REMOTE HOST, and it had no
 * gate at all, because it is registered from `useSshLeafState.ts` (the only hook
 * holding the leaf -> session map) and nothing was looking there.
 *
 * So the rule is checked where the capabilities actually live. Add a file here
 * when a leaf-addressed capability is registered from it.
 */
console.log("\n[privacy] leaf-addressed capabilities outside usePaneHandles carry it too");
{
  const outside: { file: string; capability: string }[] = [
    { file: "src/app/hooks/useSshLeafState.ts", capability: "sshExec" },
    { file: "src/app/hooks/useSshLeafState.ts", capability: "sftp" },
    { file: "src/app/hooks/useSshLeafState.ts", capability: "sshForward" },
  ];
  for (const { file, capability } of outside) {
    const text = await readFile(file, "utf8");
    const at = text.indexOf(`${capability}:`);
    if (at < 0) {
      fail(`${capability} is gone from ${file} - was it moved? the gate has to move with it`);
      continue;
    }
    // To the end of that registered function, which prettier closes at the same
    // indent the key opened on.
    const body = text.slice(at, text.indexOf("\n      },", at));
    if (!/\.private === true|!l\.private|isLeafPrivate/.test(body)) {
      fail(
        `"${capability}" in ${file} does not test the private flag: a pane the user marked ` +
          `private would be reachable through it`,
      );
    } else {
      console.log(`  ok: ${capability} (${file})`);
    }
  }
}

/**
 * A private pane's leafId must not cross the bridge in the one answer that could
 * carry it: the open that CREATED it.
 *
 * Every listing drops a private leaf, so an agent cannot discover the id - but
 * `sshConnect` returns the id of the pane it just made, and returning it for a
 * private open would hand out the one number no listing will ever mention.
 */
console.log("\n[privacy] a private SSH open does not answer with its leafId");
{
  const src = await readFile("src/app/hooks/useHeaderActions.ts", "utf8");
  const at = src.indexOf("sshConnect:");
  const body = at < 0 ? "" : src.slice(at, src.indexOf("\n      },", at));
  if (!body) {
    fail("cannot find `sshConnect` in useHeaderActions.ts - was it moved or renamed?");
  } else if (!/isPrivate \? true : leafId/.test(body)) {
    fail("sshConnect answers with the leafId of a PRIVATE pane; no listing ever names one");
  } else {
    console.log("  ok: a private open answers `true`, a public one its leafId");
  }
}

// ---------------------------------------------------------------------------
// 6. The transport, when TEDI goes away.
// ---------------------------------------------------------------------------

/**
 * `WebSocket.send()` on a CLOSING or CLOSED socket is a SILENT NO-OP - only
 * CONNECTING throws. So a request sent after TEDI quits used to register a
 * pending resolver that nothing ever settled: the first call after the app
 * closed hung forever, with no error. Only `pnpm mcp sweep` holds such a socket now.
 *
 * Measured before the guard existed: `eval()` on a closed socket never settled
 * (killed at 4s). After: it rejects in 0ms.
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
  const call = (value: unknown) =>
    (
      TOOLS as unknown as Record<string, { run: (t: unknown, a: unknown) => Promise<unknown> }>
    ).run_command.run(
      { call: async () => value },
      { id: "api_client_send", extensionId: "tedi.api-client", args: { method: "GET" } },
    );

  const body = { status: 200, body: '{"ok":true}' };
  const got = await call({ kind: "aiTool", result: body });
  if ((got as typeof body).status !== 200) fail(`AI tool result was dropped: ${String(got)}`);
  else console.log("  ok: the tool's own answer comes back, not a 'ran ...' string");

  const ran = (await call({ kind: "command" })) as string;
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

// TEDI's own agent reaches the SAME surface through one tool, gated by the SAME resolved
// `mcpDisabledTools` names. What it may not do is declare a schema of its own: that is how the two
// sides drifted apart under one name before.
const tediToolSrc = await readFile("src/modules/ai/tools/tedi.ts", "utf8");
if (/inputSchema:\s*[{z]/.test(tediToolSrc)) {
  fail("tools/tedi.ts declares a schema of its own - it has to come from scripts/mcp/tools.mjs");
} else {
  console.log("  ok: TEDI's own agent declares no schema of its own");
}

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
//
// ONE PROFILE DECIDES WHICH TEDI. With the bridge down this transport used to fall back to a
// DevTools port, which has no authentication: an end-to-end run aimed at a dev profile sent
// `keys` and `screenshot` into the installed release, because 9222 is what that happened to
// be listening on. A server ships with its app, so nothing needs the fallback.
console.log("\n[transport] a tool never reaches for a DevTools port");
{
  const code = (await readFile("scripts/mcp/transport.mjs", "utf8")).replace(
    /\/\*[\s\S]*?\*\/|\/\/.*/g,
    "",
  );
  if (/\bconnect\(|TEDI_DEBUG_PORT|\bport\b/.test(code)) {
    fail("transport.mjs reaches for a port, so a tool can drive the wrong window");
  } else console.log("  ok: the socket is the only way in");
  const { makeTransport } = await import("./transport.mjs");
  const t = makeTransport() as { call: (n: string) => Promise<unknown>; then?: unknown };
  if (t.then !== undefined) fail("the transport passes for a promise, so await would adopt it");
  else console.log("  ok: it is not thenable");
}

// ---------------------------------------------------------------------------
// 7. One definition, two transports.
// ---------------------------------------------------------------------------

/**
 * The behaviours were written twice and drifted: `sh` refused a busy pane in-process and typed
 * into it from outside. So TEDI's own agent runs the same handlers, and this checks it does
 * not grow its own again.
 */
console.log("\n[one implementation] TEDI's own agent runs the shared handlers");
const agentTools = await readFile("src/modules/ai/tools/tedi.ts", "utf8");
if (!agentTools.includes('from "@mcp/handlers.mjs"')) {
  fail("tools/tedi.ts does not import the shared handlers");
} else console.log("  ok: it imports them");
for (const name of ["termRun", "termProbe", "paneOpen", "workspaceCreate", "sshConnect"]) {
  if (agentTools.includes(`"${name}"`)) {
    fail(`tools/tedi.ts calls "${name}" itself - a second implementation is growing back`);
  }
}
for (const [file, fn] of [
  ["src/modules/settings/preferences.ts", "writeSetting"],
  ["src/modules/extensions/store.ts", "controlExtension"],
] as const) {
  const src = await readFile(file, "utf8");
  if (!new RegExp(`registerBridge\\([\\s\\S]*\\b${fn}\\b`).test(src)) {
    fail(`${file}: the capability does not reference ${fn}`);
  }
}
console.log("  ok: and the capabilities they call point at the app's own functions");
// And the built-in agent must not reach TEDI through the STDIO server: that
// would be a subprocess and a socket round trip into its own realm, gated on a
// port that is off by default. Test the CODE, not the file text - the header
// comment explains that decision and names the very things this forbids.
const agentCode = agentTools.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
if (/mcp\/server\.|TEDI_DEBUG_PORT|__tedi\b/.test(agentCode)) {
  fail("tools/tedi.ts reaches for the stdio/automation channel instead of calling in-realm");
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

  // `autocompleteProvider` too: a stored unknown id crashed Settings > Models.
  for (const key of [
    "theme",
    "approvalMode",
    "editorTheme",
    "defaultProviderId",
    "autocompleteProvider",
  ]) {
    if (!new RegExp(`\\b${key}:`).test(allowBlock)) fail(`${key} lost its allowed-value check`);
    else console.log(`  ok: ${key} is validated`);
  }
}

// …and a value already on disk is repaired on load, not trusted: that is what
// brought a profile holding `autocompleteProvider: "bogus"` back.
if (!/autocompleteProvider:\s*normalizeAutocompleteProvider\(/.test(storeSrc)) {
  fail("autocompleteProvider is read raw on load - an unknown id crashes Settings > Models");
} else console.log("  ok: an unknown autocompleteProvider falls back on load");

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
