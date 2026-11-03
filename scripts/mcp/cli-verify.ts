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
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { parseArgs, positionalFor, unfinished, unknownVerb } from "./cli.mjs";
import { TOOLS } from "./server.mjs";
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
} from "./tools.mjs";
import { BRIDGED } from "./transport.mjs";

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
const wanted = [...new Set([...TOOL_NAMES, ...Object.keys(ALIASES), "tools", "help"])].sort();
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
    same(slotsOf("inspect", ["logs", "error"]), ["what", "level"]),
);
check(
  "a shortcut with nothing to fill refuses a word",
  throws(
    () =>
      parseArgs(["foo"], defs.inspect.schema, {
        positional: slotsOf("commands", ["foo"]),
        fixed: { what: "commands" },
      }),
    /Did not expect/,
  ),
);
check(
  "an unfinished wait or command is not success",
  unfinished("leaf 3: NOT done (timeout)\ntail") &&
    unfinished("output\n\n[leaf 3: still running after the timeout]") &&
    !unfinished("leaf 3: done (prompt)\ntail"),
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
const inProcess = await readFile("src/modules/ai/lib/tediMcpServer.ts", "utf8");
check(
  "the in-process server asks the same switch for a call and a panel",
  (inProcess.match(/await extensionOff\(extensionId\)/g) ?? []).length === 2,
);
// `misc` is enforced per DevTools method in `mcp_devtools.rs`; `tedi` has no switch.
const switchable = TOOL_NAMES.filter((n) => !["tedi", "misc"].includes(defs[n].pack));
const bridged = BRIDGED as Record<string, string>;
const tools = TOOLS as unknown as Record<string, { run: () => unknown }>;
for (const name of switchable) {
  const methods = [...String(tools[name].run).matchAll(/\bd\.(\w+)\(/g)].map((m) => m[1]);
  check(`${name} reaches at least one capability`, methods.length > 0);
  for (const method of methods) {
    const capability = bridged[method];
    check(
      `${name}: ${method} -> ${capability} is gated as ${name}`,
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

// Source text, because the failure needs a real React render to show. An id set
// inside the updater reads null whenever another update is still in flight, so
// `tedi new-tab` then `tedi split` reported failure for a split that happened.
console.log("\n[wording] the handlers still say what `unfinished` looks for");
const serverSrc = await readFile("scripts/mcp/server.mjs", "utf8");
check("wait", serverSrc.includes('"NOT done"'));
check("sh", serverSrc.includes("still running after the timeout]"));

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
const useTabs = await readFile("src/modules/tabs/lib/useTabs.ts", "utf8");
const splitBody = useTabs.slice(useTabs.indexOf("const splitActivePane = useCallback"));
check(
  "nextIdRef is read before setTabs, like newTab",
  splitBody.indexOf("nextIdRef.current++") < splitBody.indexOf("setTabs("),
);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS");
if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
