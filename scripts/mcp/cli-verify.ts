/**
 * Self-check for `tedi <verb>` and for the gates it shares with the MCP server.
 * Run: `npx tsx scripts/mcp/cli-verify.ts` (or `pnpm verify`, which globs it).
 *
 * 1. **Rust decides what is a verb before node starts.** `BRIDGE_VERBS` in `cli.rs`
 *    has to name every tool and alias. A name missing there opens a folder or
 *    focuses the window and prints nothing, which reads as success.
 * 2. **The command line turns into typed arguments.** A number left as a string
 *    misses `terminalRefs.get(3)`; a flag dropped on the floor runs the wrong thing.
 * 3. **A pack switch has to hold on the app's side too.** `server.mjs` checks them,
 *    but that is the client checking itself. Each switchable tool's capabilities
 *    must be in `GATED_CAPABILITIES`, or a token holder walks straight past it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asJson, outputMode, parseArgs, positionalFor, unfinished, unknownVerb } from "./cli.mjs";
import { HANDLERS } from "./handlers.mjs";
import { humanize, pretty } from "./render.mjs";
import { tediDataFiles } from "./socket.mjs";
import {
  ALIASES,
  CLI_EXAMPLES,
  CLI_GROUPS,
  TOOL_DEFS,
  TOOL_NAMES,
  cliGuide,
  extToolMedia,
  resolveVerb,
  validateArgs,
  verbArgs,
  verbNeedsApproval,
} from "./tools.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const throws = (run: () => unknown, match: RegExp): boolean => {
  try {
    run();
    return false;
  } catch (e) {
    return match.test((e as Error).message);
  }
};
const defs = TOOL_DEFS as unknown as Record<
  string,
  { pack: string; schema: { properties?: Record<string, { type?: string }>; required?: string[] } }
>;
const parse = (tool: string, argv: string[], opts: Record<string, unknown> = {}) =>
  parseArgs(argv, defs[tool].schema, opts);

// ---------------------------------------------------------------------------
console.log("[verbs] cli.rs names every tool and alias, and nothing else");
const cliRs = await readFile("src-tauri/src/modules/cli.rs", "utf8");
const listed = [
  ...(/const BRIDGE_VERBS[^=]*= &\[([^\]]*)\]/.exec(cliRs)?.[1] ?? "").matchAll(/"([^"]+)"/g),
]
  .map((m) => m[1])
  .sort();
const wanted = [
  ...new Set([...TOOL_NAMES, ...Object.keys(ALIASES), "tools", "help", "mcp"]),
].sort();
check("BRIDGE_VERBS matches tools.mjs + ALIASES", same(listed, wanted), {
  missing: wanted.filter((v) => !listed.includes(v)),
  stale: listed.filter((v) => !wanted.includes(v)),
});
// These three are already subcommands of the binary and never reach cli.mjs.
for (const taken of ["ext", "theme", "cmd"]) {
  check(`"${taken}" is left to the binary`, !wanted.includes(taken));
}

console.log("\n[guide] every tool can be found from `tedi tools`");
const grouped = CLI_GROUPS.flatMap(([, names]) => names);
const aliases = ALIASES as Record<string, { tool: string }>;
for (const tool of TOOL_NAMES) {
  const found = grouped.some((v) => v === tool || aliases[v]?.tool === tool);
  check(`${tool} has a row`, found);
}
for (const verb of grouped) {
  check(`${verb} is a real verb`, Boolean(resolveVerb(verb)));
}
check("no verb is listed twice", new Set(grouped).size === grouped.length);
for (const [verb, lines] of Object.entries(CLI_EXAMPLES)) {
  check(`the ${verb} examples name a real verb`, Boolean(resolveVerb(verb)));
  for (const line of lines) check(`"${line}" starts with tedi`, line.startsWith("tedi "));
}
const guide = cliGuide(TOOL_NAMES.map((n) => ({ name: n, description: "Does it. More." })));
check("the guide opens with where to start", /Start here:/.test(guide) && /tedi panes/.test(guide));
check(
  "a verb whose tool is off is not offered",
  !/\bsftp\b/.test(
    cliGuide(TOOL_NAMES.filter((n) => n !== "sftp").map((n) => ({ name: n, description: "x." })))
      .split("Start here")[1]
      .split("Rules:")[1],
  ),
);
check("a typo gets the verb it meant", /Did you mean: .*new-tab/.test(unknownVerb("new-tb")));

console.log("\n[aliases] each one points at something real");
for (const [verb, a] of Object.entries(
  ALIASES as Record<string, { tool: string; args?: object; positional?: string[] }>,
)) {
  const def = defs[a.tool];
  check(`${verb} -> ${a.tool}`, Boolean(def));
  if (!def) continue;
  for (const slot of a.positional ?? []) {
    check(`${verb}: "${slot}" is declared`, Boolean(def.schema.properties?.[slot]));
  }
  // Required keys are filled at run time, so only the fixed values are judged here.
  const bad = validateArgs(a.tool, a.args ?? {});
  check(`${verb}: fixed args are legal`, !bad || /needs "/.test(bad), bad);
}
check("dashes and underscores are one verb", resolveVerb("new-tab")?.tool === "pane");
check(
  "an extension tool passes through by prefix",
  resolveVerb("ext_browser")?.tool === "ext_browser",
);
check("a typo resolves to nothing", resolveVerb("nwe-tab") === null);

console.log("\n[args] the command line arrives as the schema's types");
check("flags become camelCase", same(parse("pane", ["--leaf-id", "3"]), { leafId: 3 }));
check("--flag=value", same(parse("pane", ["--leaf-id=3"]), { leafId: 3 }));
check("a bare boolean is true", same(parse("pane", ["--split"]), { split: true }));
check(
  "--no-x is false",
  same(parse("sh", ["--no-submit", "ls"]), { submit: false, command: "ls" }),
);
check(
  "a list is comma separated and typed",
  same(parse("pane", ["--leaf-ids", "1,2"]), { leafIds: [1, 2] }),
);
check(
  "bare words fill the required keys",
  same(parse("set_setting", ["theme", "dark"]), { key: "theme", value: "dark" }),
);
check(
  "extra words join a trailing string",
  same(parse("sh", ["git", "status"]), { command: "git status" }),
);
check(
  "everything after a free-text command is the command, even a flag this tool also has",
  same(parse("sh", ["tail", "--lines", "5", "f.log"]), { command: "tail --lines 5 f.log" }),
);
check(
  "flags before the command are the tool's",
  same(parse("sh", ["--leaf-id", "4", "ls", "-la"]), { leafId: 4, command: "ls -la" }),
);
check(
  "a command that is not required does not swallow flags after it",
  same(
    parse("schedule", ["create", "ls", "--delay", "60"], { positional: ["action", "command"] }),
    {
      delay: 60,
      action: "create",
      command: "ls",
    },
  ),
);
check(
  "every word fills a list, and a comma stays inside its chord",
  same(parse("keys", ["Ctrl+,", "Escape"]), { chords: ["Ctrl+,", "Escape"] }),
);
check(
  "a repeated flag adds to a list",
  same(parse("pane", ["--leaf-ids", "1,2", "--leaf-ids", "3"]), { leafIds: [1, 2, 3] }),
);
check(
  "an extension's path is left alone",
  same(
    parseArgs(
      ["/v1/users"],
      { properties: { path: { type: "string" } }, required: ["path"] },
      { localPaths: false },
    ),
    { path: "/v1/users" },
  ),
);
check(
  "-- ends flag parsing",
  same(parse("sh", ["echo", "--", "--leaf-id", "4"]), { command: "echo --leaf-id 4" }),
);
check(
  "an alias's fixed args and positional slots",
  same(
    parse("pane", ["3", "build"], { positional: ["leafId", "name"], fixed: { action: "rename" } }),
    {
      action: "rename",
      leafId: 3,
      name: "build",
    },
  ),
);
check(
  "JSON for an object argument",
  same(
    parse("run_command", ["tedi.x", "tool", '{"a":1}'], {
      positional: ["extensionId", "id", "args"],
    }),
    { extensionId: "tedi.x", id: "tool", args: { a: 1 } },
  ),
);
check(
  "a relative cwd resolves against the shell's folder, not the app's",
  /\/here$/.test(String(parse("pane", ["--cwd", "here"]).cwd)),
);
check(
  "words that would lose their quotes are refused, not run",
  throws(() => parse("sh", ["rm", "my file"]), /removed the quotes/) &&
    throws(() => parse("sh", ["git", "commit", "-m", "fix bug"]), /removed the quotes/),
);
check(
  "one quoted command is fine",
  same(parse("sh", ['rm "my file"']), { command: 'rm "my file"' }),
);
const slotsOf = (verb: string, argv: string[]) => positionalFor(resolveVerb(verb), argv);
check(
  "bare words land where the action reads them",
  same(slotsOf("workspace", ["create", "Foo"]), ["action", "name"]) &&
    same(slotsOf("ai", ["read", "s1"]), ["action", "sessionId"]) &&
    same(slotsOf("ai", ["send", "hi"]), ["action", "text"]) &&
    same(slotsOf("pane", ["open", "."]), ["action", "cwd"]) &&
    same(slotsOf("read", ["dom", "x"]), ["source", "selector"]) &&
    same(slotsOf("inspect", ["logs", "error"]), ["what", "level"]) &&
    same(slotsOf("inspect", ["settings", "font"]), ["what", "filter"]) &&
    same(slotsOf("settings", ["font"]), ["filter"]),
);
check(
  "a shortcut with nothing to fill refuses a word",
  throws(
    () =>
      parseArgs(["foo"], defs.read.schema, {
        positional: slotsOf("editors", ["foo"]),
        fixed: { source: "editors" },
      }),
    /Did not expect/,
  ),
);
check(
  "an unfinished wait or command is not success",
  unfinished("wait_for_terminal", { done: false }) &&
    unfinished("sh", { timedOut: true }) &&
    !unfinished("wait_for_terminal", { done: true }) &&
    !unfinished("sh", { timedOut: false }) &&
    !unfinished("run_command", { done: false }),
);
check(
  "sftp's remote path stays remote, its local one resolves",
  (() => {
    const a = parse("sftp", ["upload", "3", "/var/www", "--local", "dist/a.js"], {
      positional: ["action", "leafId", "remote"],
    }) as { remote?: string; local?: string };
    return a.remote === "/var/www" && /\/dist\/a\.js$/.test(String(a.local));
  })(),
);
check(
  "an unknown flag is refused",
  throws(() => parse("pane", ["--nope", "1"]), /Unknown flag/),
);
check(
  "a non-number is refused",
  throws(() => parse("pane", ["--leaf-id", "x"]), /wants a number/),
);
check(
  "a surplus word is refused",
  throws(() => parse("state", ["surplus"]), /Did not expect/),
);
check(
  "a flag with no value is refused",
  throws(() => parse("pane", ["--cwd"]), /needs a value/),
);

// ---------------------------------------------------------------------------
console.log("\n[gates] every switchable tool's capabilities are refused by the app too");
const bridgeRs = await readFile("src-tauri/src/modules/mcp_bridge.rs", "utf8");
const gated = new Map(
  [
    ...(/const GATED_CAPABILITIES[^=]*= &\[([\s\S]*?)\];/.exec(bridgeRs)?.[1] ?? "").matchAll(
      /\("(\w+)",\s*"(\w+)"\)/g,
    ),
  ].map((m) => [m[1], m[2]]),
);
check("the table was found", gated.size > 0);
// Starting it publishes live terminals, so an agent may stop it and never start it.
const extStore = await readFile("src/modules/extensions/store.ts", "utf8");
check(
  "an agent cannot start Remote Access",
  /id === "tedi\.remote-access" && \(action === "enable" \|\| action === "reload"\)/.test(extStore),
);
for (const capability of ["runExtensionCommand", "panelOpen"]) {
  check(
    `${capability} obeys the extension switch`,
    new RegExp(`EXTENSION_CAPABILITIES[^;]*"${capability}"`).test(bridgeRs),
  );
}
const inProcess = await readFile("src/modules/ai/tools/tedi.ts", "utf8");
check(
  "TEDI's own agent asks the same switch, whichever verb names the extension",
  /a\.extensionId && surface\.disabledExtensions\.includes/.test(inProcess),
);
// `misc` is enforced per DevTools method in `mcp_devtools.rs`; `tedi` has no switch.
const switchable = TOOL_NAMES.filter((n) => !["tedi", "misc"].includes(defs[n].pack));
const handlers = HANDLERS as unknown as Record<string, () => unknown>;
for (const name of switchable) {
  const capabilities = [...String(handlers[name]).matchAll(/call\(\s*"(\w+)"/g)].map((m) => m[1]);
  check(`${name} reaches at least one capability`, capabilities.length > 0);
  for (const capability of capabilities) {
    check(
      `${name}: ${capability} is gated as ${name}`,
      gated.get(capability) === name,
      gated.get(capability),
    );
  }
}
for (const [capability, tool] of gated) {
  check(`${capability} belongs to a switchable tool`, switchable.includes(tool), tool);
}

// ---------------------------------------------------------------------------
// A real process, because the bug lived in what it inherits. A read-only verb and
// a port nothing listens on, so a regression here cannot touch a running window:
// the first version of this test used `sh`, and it typed into a live session.
console.log("\n[profile] a profile that is not running says so, whatever the env holds");
const ghost = spawnSync(process.execPath, ["scripts/mcp/cli.mjs", "panes"], {
  encoding: "utf8",
  env: { ...process.env, TEDI_BUNDLE_ID: "id.tedi.verify.nobody", TEDI_DEBUG_PORT: "1" },
});
check("it exits non-zero", ghost.status === 1, ghost.status);
check("it names the real reason", /not running/i.test(ghost.stderr), ghost.stderr);
check("it answers nothing on stdout", ghost.stdout === "", ghost.stdout);

console.log("\n[approval] TEDI's own agent is carded for all but a read");
{
  const free = (verb: string, args?: unknown) => !verbNeedsApproval(verb, args);
  check("a read runs unattended", free("panes") && free("term", { leafId: 3 }) && free("state"));
  check("so does the reference", free("help", { verb: "sh" }) && free("tools"));
  check("sh asks", !free("sh", { command: "ls" }));
  check("an action the table frees is free", free("notes", { action: "read" }));
  check("the same tool's other action asks", !free("notes", { action: "delete_note", id: "x" }));
  check("a call that will be refused has nothing to approve", free("pane") && free("sh", {}));
  check(
    "a shortcut is judged by its own action",
    !free("close", { leafId: 3 }) && !free("new-tab"),
  );
  check("an extension's tool always asks", !free("ext_browser", { action: "read" }));
  // Its fixed action wins, so an argument cannot turn `close` into something the table frees.
  check("args cannot rewrite a shortcut's action", !free("close", { action: "rotate" }));
  check("a stringified args is read the same", !free("notes", '{"action":"add_todo","text":"x"}'));
  // What a real model sent, through a tool whose `args` is an untyped object.
  const shortcut = resolveVerb("sh");
  check(
    "strings become the schema's types",
    same(verbArgs(shortcut, { command: "ls", leafId: "2", capture: "true" }), {
      command: "ls",
      leafId: 2,
      capture: true,
    }),
  );
  check(
    "a lone value becomes a list",
    same(verbArgs(resolveVerb("keys"), { chords: "Enter" }), { chords: ["Enter"] }),
  );
  check(
    "junk stays junk, for the validator to name",
    verbArgs(shortcut, { command: "ls", leafId: "two" }).leafId === "two",
  );
  check(
    "ssh list is a read",
    free("ssh", { action: "list" }) && !free("ssh", { action: "connect", id: "x" }),
  );
  check("nor can a proto key pass as a verb", resolveVerb("__proto__") === null);
}

console.log("\n[stripped env] the handshake is found with no APPDATA and no HOME");
// Hermes passes PATH, HOME, USER and a few others to a stdio server. On Windows that leaves
// neither of the variables this used to look in, so every call said "TEDI is not running".
{
  const saved = { APPDATA: process.env.APPDATA, HOME: process.env.HOME };
  delete process.env.APPDATA;
  delete process.env.HOME;
  const files = tediDataFiles("mcp-bridge.json").map((f: string) => f.replaceAll("\\", "/"));
  Object.assign(process.env, saved);
  const want = process.platform === "win32" ? "AppData/Roaming/" : ".config/";
  check(
    "it still looks where the app writes",
    files.some((f: string) => f.includes(want)),
    files,
  );
}

console.log("\n[output] who is reading decides the shape");
check("a terminal gets a table", outputMode(null, undefined, true) === "human");
check("a pipe gets JSON", outputMode(null, undefined, false) === "json");
check("--json beats the terminal", outputMode("json", undefined, true) === "json");
check("--human beats the pipe", outputMode("human", undefined, false) === "human");
check("the env var beats the guess", outputMode(null, "json", true) === "json");
check("the flag beats the env var", outputMode("human", "json", false) === "human");
check("a junk env var is ignored", outputMode(null, "yaml", false) === "json");
check("JSON is compact", asJson({ a: [1] }) === '{"a":[1]}');
check("a sentence is still JSON", JSON.parse(asJson("closed leaf 3")).message === "closed leaf 3");
check("nothing is still JSON", asJson(undefined) === "null");
{
  let seen = "";
  const a = parseArgs(["--json", "ls"], defs.sh.schema, { onOutput: (f: string) => (seen = f) });
  check("a flag before the command is ours", seen === "json" && a.command === "ls", a);
  seen = "";
  const b = parseArgs(["ls", "--json"], defs.sh.schema, { onOutput: (f: string) => (seen = f) });
  check("after the command it is the command's", seen === "" && b.command === "ls --json", b);
  const c = parseArgs(["--human"], defs.state.schema, { onOutput: (f: string) => (seen = f) });
  check("and it never reaches the tool", seen === "human" && same(c, {}), c);
}

console.log("\n[human] a person never gets raw JSON");
{
  const panesVerb = resolveVerb("panes");
  const out = humanize(
    panesVerb,
    {},
    [
      {
        active: true,
        leafId: 3,
        kind: "terminal",
        running: true,
        tabTitle: "api",
        cwd: "/home/me/x",
        agent: "claude",
      },
      {
        active: false,
        leafId: 12,
        kind: "editor",
        dirty: true,
        tabTitle: "api",
        path: "/srv/a.ts",
      },
      {
        active: false,
        leafId: 7,
        kind: "extension-panel",
        tabTitle: "Db",
        title: "prod",
        state: "connected",
      },
    ],
    { home: "/home/me" },
  );
  const lines = out.split("\n");
  check("a header and one row per pane", lines.length === 4 && /LEAF/.test(lines[0]), lines);
  check("the running agent names the kind", /claude/.test(lines[1]) && /running/.test(lines[1]));
  check("the active pane is marked", lines[1].startsWith("*") && !lines[2].startsWith("*"));
  check("home folds to ~", lines[1].includes("~/x"));
  check("an unsaved editor says so", /unsaved/.test(lines[2]));
  check("a panel shows its title", /panel/.test(lines[3]) && /prod/.test(lines[3]));
  check("no JSON leaks", !/[{}"]/.test(out), out);
  check(
    "a sibling of home is not home",
    humanize(panesVerb, {}, [{ leafId: 1, kind: "terminal", cwd: "/home/me2/x" }], {
      home: "/home/me",
    }).includes("/home/me2/x"),
  );
  check(
    "a tail someone asked for is shown",
    humanize(panesVerb, {}, [{ leafId: 1, kind: "terminal", tail: "last line" }]).includes(
      "last line",
    ),
  );

  const wide = humanize(panesVerb, {}, [{ leafId: 1, kind: "terminal", cwd: "/a".repeat(90) }], {
    width: 60,
  });
  check(
    "the last column is cut to the terminal",
    wide.split("\n").every((l: string) => l.length <= 60) && wide.includes("…"),
    wide,
  );
  const painted = humanize(panesVerb, {}, [{ leafId: 1, kind: "terminal" }], { color: true });
  const plain = humanize(panesVerb, {}, [{ leafId: 1, kind: "terminal" }], {});
  check("colour only when asked", painted.includes("\x1b[1m") && !plain.includes("\x1b"));

  const sh = resolveVerb("sh");
  check(
    "sh is what it printed",
    humanize(sh, {}, { leafId: 3, command: "ls", timedOut: false, text: "a.txt" }) === "a.txt",
  );
  check(
    "and says when it is still going",
    /still running/.test(humanize(sh, {}, { leafId: 3, timedOut: true, text: "x" })),
  );
  check(
    "a sentence passes through",
    humanize(resolveVerb("close"), {}, "closed leaf 3") === "closed leaf 3",
  );

  // Every tool, against every shape it can plausibly answer: a view must not throw, and
  // anything without one still must not print raw JSON at someone.
  const shapes: unknown[] = [
    [],
    {},
    null,
    "text",
    [{ id: "a", n: 1, nested: { x: 1 } }],
    { a: 1, b: { c: 2 } },
  ];
  const threw: string[] = [];
  for (const verb of [...TOOL_NAMES, ...Object.keys(ALIASES)]) {
    const found = resolveVerb(verb);
    for (const what of [
      "commands",
      "extensions",
      "settings",
      "workspaces",
      "status",
      "sessions",
      "logs",
    ]) {
      for (const shape of shapes) {
        try {
          humanize(found, { what, action: "list", source: "terminal" }, shape);
          humanize(found, { what, action: "status" }, shape);
        } catch (e) {
          threw.push(`${verb}/${what}: ${(e as Error).message}`);
        }
      }
    }
  }
  check("no view throws on an odd answer", threw.length === 0, threw.slice(0, 5));
  check(
    "rows read as a table",
    /^ID +N\n/.test(pretty([{ id: "a", n: 1 }])),
    pretty([{ id: "a", n: 1 }]),
  );
  check("an object reads as key and value", /^a +1$/m.test(pretty({ a: 1, ok: true })));
  check("ok is noise there", !/ok/.test(pretty({ a: 1, ok: true })));
}

// The real process, against a stand-in for the Rust listener: argv to stdout, end to end.
console.log("\n[end to end] one process, a stub bridge, both readers");
{
  const dir = mkdtempSync(join(tmpdir(), "tedi-cli-"));
  const bundle = "id.tedi.cli-verify";
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tedi-cli-verify-${process.pid}`
      : join(dir, "b.sock");
  mkdirSync(join(dir, bundle), { recursive: true });
  writeFileSync(
    join(dir, bundle, "mcp-bridge.json"),
    JSON.stringify({ socket: address, token: "t" }),
  );
  const server = net.createServer((sock) => {
    let buf = "";
    let authed = false;
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!authed) {
          authed = true;
          sock.write('{"ok":true}\n');
          continue;
        }
        const reply = (body: object) => sock.write(`${JSON.stringify({ id: msg.id, ...body })}\n`);
        if (msg.name === "state") {
          reply({
            ok: true,
            result: {
              panes: [
                {
                  active: true,
                  leafId: 3,
                  kind: "terminal",
                  cwd: "/x",
                  tabTitle: "t",
                  atPrompt: true,
                },
              ],
              // Proves what the human path asks for: no tail means no buffer walk.
              asked: msg.args[0],
            },
          });
        } else if (msg.name === "settings") {
          reply({ ok: true, result: { theme: "dark", customTheme: { p: "x".repeat(400) } } });
        } else {
          reply({ ok: false, error: `refused ${msg.name}` });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(address, () => r()));

  const run = (argv: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["scripts/mcp/cli.mjs", ...argv], {
        env: {
          ...process.env,
          APPDATA: dir,
          XDG_CONFIG_HOME: dir,
          TEDI_BUNDLE_ID: bundle,
          TEDI_OUTPUT: "",
          ...env,
        },
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });

  const piped = await run(["panes"]);
  check("piped, the answer is JSON", JSON.parse(piped.out)[0]?.leafId === 3, piped);
  check("on one line", piped.out.trim().split("\n").length === 1);
  const human = await run(["panes", "--human"]);
  check("--human is a table", /LEAF/.test(human.out) && !human.out.includes("{"), human);
  const leading = await run(["--human", "panes"]);
  check("before the verb too", /LEAF/.test(leading.out), leading);
  const envMode = await run(["panes"], { TEDI_OUTPUT: "human" });
  check("TEDI_OUTPUT picks it", /LEAF/.test(envMode.out), envMode);

  const refused = await run(["sh", "--leaf-id", "3", "ls"]);
  check("a refusal exits 1", refused.code === 1, refused);
  check("says why on stderr", /refused/.test(refused.err), refused.err);
  check("and leaves stdout empty", refused.out === "", refused.out);
  const usage = await run(["pane", "--nope", "1"]);
  check("a bad command line exits 2", usage.code === 2, usage);

  const settings = await run(["settings"]);
  const folded = JSON.parse(settings.out);
  check(
    "a long setting folds until it is named",
    folded.theme === "dark" && /filter "customTheme"/.test(folded.customTheme),
    folded,
  );
  const named = JSON.parse((await run(["settings", "customTheme"])).out);
  check("and comes back whole when it is", named.customTheme?.p?.length === 400, named);

  const guide = await run(["tools"]);
  check("the guide stays text when piped", /Start here:/.test(guide.out), guide.out.slice(0, 80));
  const verbs = JSON.parse((await run(["tools", "--json"])).out);
  check(
    "and is data when asked",
    verbs.some((v: { verb: string }) => v.verb === "new-tab"),
  );
  const schema = JSON.parse((await run(["help", "sh", "--json"])).out);
  check("help too", schema.inputSchema?.required?.includes("command"), schema);

  const status = JSON.parse((await run(["mcp", "status", "--json"])).out);
  check("mcp status finds this TEDI", status.running === true && status.profile === bundle, status);
  check(
    "and lists every agent",
    status.agents.length === 7 && status.agents.some((a: { id: string }) => a.id === "hermes"),
  );
  const cfg = await run(["mcp", "config", "hermes"]);
  check("mcp config prints it", /^mcp_servers:/.test(cfg.out) && cfg.out.includes(bundle), cfg);
  const logs = await run(["logs", "--for=x"]);
  check("--for= is read, and junk refused", logs.code === 2 && /--for wants/.test(logs.err), logs);
  const nope = await run(["mcp", "install", "nobody"]);
  check("an unknown agent is a usage error", nope.code === 2 && /No agent/.test(nope.err), nope);
  server.close();
}

console.log("\n[media] a tool's image never reaches the session file");
const sessionsSrc = await readFile("src/modules/ai/lib/sessions.ts", "utf8");
check("saved through withoutMedia", sessionsSrc.includes("withoutMedia(messages))"));
check(
  "an empty data reads as no media",
  extToolMedia({ mimeType: "image/png", data: "" }) === null,
);

console.log("\n[sftp] replacing and deleting need confirm");
const sftpSrc = await readFile("src/modules/ssh/sftpAutomation.ts", "utf8");
for (const action of ["write", "rename", "upload", "download"]) {
  const body = sftpSrc.slice(sftpSrc.indexOf(`case "${action}"`));
  check(
    `${action} checks before it replaces`,
    body.indexOf("refuseOverwrite(") < body.indexOf("return") && body.includes("refuseOverwrite("),
  );
}

console.log("\n[macos] clients look where Rust writes the handshake");
const socketSrc = await readFile("scripts/mcp/socket.mjs", "utf8");
check("Library/Application Support", socketSrc.includes('"Library", "Application Support"'));

console.log("\n[split] a split's leaf id is allocated before the state update");
// Source text, because the failure needs a real React render to show. An id set inside the
// updater reads null whenever another update is still in flight, so `tedi new-tab` then
// `tedi split` reported failure for a split that happened.
const useTabs = await readFile("src/modules/tabs/lib/useTabs.ts", "utf8");
const splitBody = useTabs.slice(useTabs.indexOf("const splitActivePane = useCallback"));
check(
  "nextIdRef is read before setTabs, like newTab",
  splitBody.indexOf("nextIdRef.current++") < splitBody.indexOf("setTabs("),
);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS");
if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
