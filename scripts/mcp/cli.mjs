#!/usr/bin/env node
/**
 * `tedi <verb>`: one MCP tool against the running window, then exit.
 *
 * WHY THIS EXISTS BESIDE THE MCP SERVER. A connected AI CLI pays for the whole
 * tool list on every request of the session, whether it drives TEDI or not. A
 * command costs nothing until it runs, and `tedi help <verb>` shows the schema
 * only when someone asks.
 *
 * There is no second implementation here. Every verb goes through `callTool` in
 * `server.mjs`, so the pack switches, the validation and the answers are the ones
 * the MCP server gives, and a new row in `tools.mjs` is a new verb with nothing
 * else to do. `tedi.exe` (or the app binary elsewhere) routes the verbs named in
 * `BRIDGE_VERBS` in `cli.rs` here; `cli-verify` keeps the two tables equal.
 *
 * From the repo, `pnpm mcp <verb>` is the same thing, but it aims at the RELEASE
 * profile unless `TEDI_BUNDLE_ID` says otherwise. `targets` and `sweep` are dev
 * verbs that drive a window over the DevTools port (`pnpm mcp sweep --port 9333`).
 *
 * TWO READERS. On a terminal an answer is for a person: a table or plain text
 * (`render.mjs`). Piped, or with `--json`, it is one compact JSON value, for a program or an AI
 * agent. Stdout holds the answer and stderr says why there is none.
 *
 * Exit status: 0 answered, 1 the tool or TEDI refused, 2 the command line was wrong.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize, pretty, table } from "./render.mjs";
import { callTool, closeTransport, currentSurface, listTools, serveStdio } from "./server.mjs";
import { connectBridge } from "./socket.mjs";
import { readsAsInstalled, TARGETS, withEntry, withoutEntry } from "./targets.mjs";
import {
  ALIASES,
  CLI_EXAMPLES,
  cliGuide,
  cliVerbs,
  resolveVerb,
  TOOL_DEFS,
  TOOL_NAMES,
} from "./tools.mjs";

/**
 * What bare words fill, by the first word, because one slot list per tool put them
 * in the wrong place and the handler then ignored them: `tedi workspace create Foo`
 * filled `id` and made a workspace with no name.
 */
const POSITIONAL = {
  pane: (w) => (w === "open" ? ["action", "cwd"] : ["action", "leafId"]),
  workspace: (w) => (w === "create" ? ["action", "name"] : ["action", "id", "name"]),
  extension: () => ["action", "id"],
  ssh: () => ["action", "id"],
  sftp: (w) =>
    w === "rename" ? ["action", "leafId", "remote", "to"] : ["action", "leafId", "remote"],
  session: () => ["action", "id"],
  ai: (w) => (w === "send" ? ["action", "text"] : ["action", "sessionId"]),
  worktree: () => ["action", "branch"],
  read: (w) => (w === "dom" ? ["source", "selector"] : ["source", "leafId"]),
  notes: (w) => (/^add_/.test(w) ? ["action", "text"] : ["action", "id", "text"]),
  schedule: (w) => (w === "cancel" ? ["action", "id"] : ["action", "command"]),
  inspect: (w) => (w === "logs" ? ["what", "level"] : ["what", "filter"]),
  focus_pane: () => ["leafId"],
};

/** A shortcut says for itself; one with fixed arguments and no list takes no words. */
export function positionalFor(found, argv) {
  if (found.positional) return found.positional;
  if (found.args || found.select) return [];
  return POSITIONAL[found.tool]?.(argv.find((a) => !a.startsWith("--")));
}

/** Arguments that are a whole line of someone else's syntax. */
const FREE_TEXT = new Set(["command", "text", "expression"]);

/** Of those, the ones a shell or an interpreter will parse again. */
const PARSED_AGAIN = new Set(["command", "expression"]);

/** `leaf-id` -> `leafId`. */
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** A word from the shell, as the type the schema asks for. */
function coerce(key, raw, spec) {
  const type = spec?.type;
  if (type === "number" || type === "integer") {
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n))
      throw new UsageError(`--${key} wants a number, got "${raw}".`);
    return n;
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new UsageError(`--${key} wants true or false.`);
    return raw === "true";
  }
  if (type === "array") {
    // Commas only split numbers: `Ctrl+,` is one chord, not two.
    return spec.items?.type === "number" ? raw.split(",").map(Number) : [raw];
  }
  if (type === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`--${key} wants JSON, got: ${raw}`);
    }
  }
  return raw;
}

class UsageError extends Error {}

/**
 * Argv after the verb -> tool arguments. Pure, so `cli-verify` can drive it with
 * no app and no shell. Unknown flags and surplus words are errors: dropping one
 * silently would run the wrong thing and report success.
 */
export function parseArgs(
  argv,
  schema,
  { positional, fixed = {}, cwd = process.cwd(), localPaths = true, onOutput } = {},
) {
  const props = schema?.properties ?? {};
  // A tool with no declared properties takes anything: an extension's schema may
  // legitimately be an open object.
  const open = Object.keys(props).length === 0;
  const args = { ...fixed };
  const slots = (positional ?? schema?.required ?? []).filter((k) => !(k in fixed));
  const words = [];
  // `tedi sh tail --lines 5 f`: a required free-text argument takes the rest of the
  // line, like `env` or `ssh`. Reading `--lines` as this tool's own flag would run
  // `tail f` and cut its answer to 5 lines, which looks exactly like success. Flags
  // for the tool go first: `tedi sh --leaf-id 3 tail --lines 5 f`.
  const last = slots.at(-1);
  const takesRest = FREE_TEXT.has(last) && schema?.required?.includes(last);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || (takesRest && words.length >= slots.length)) {
      words.push(...argv.slice(a === "--" ? i + 1 : i));
      break;
    }
    // After the check above, so `tedi sh ls --json` still runs `ls --json`.
    if (a === "--json" || a === "--human") {
      onOutput?.(a.slice(2));
      continue;
    }
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    let flag = camel(eq === -1 ? a.slice(2) : a.slice(2, eq));
    let inline = eq === -1 ? undefined : a.slice(eq + 1);
    if (
      flag.startsWith("no") &&
      flag.length > 2 &&
      props[flag[2].toLowerCase() + flag.slice(3)]?.type === "boolean"
    ) {
      flag = flag[2].toLowerCase() + flag.slice(3);
      inline = "false";
    }
    const spec = props[flag];
    if (!spec && !open) {
      throw new UsageError(
        `Unknown flag --${flag}. Have: ${Object.keys(props).join(", ") || "(none)"}`,
      );
    }
    if (spec?.type === "boolean" && inline === undefined) {
      // `--split` alone means true, unless the next word really is the value.
      inline = argv[i + 1] === "true" || argv[i + 1] === "false" ? argv[++i] : "true";
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) throw new UsageError(`--${flag} needs a value.`);
    const value = coerce(flag, raw, spec);
    args[flag] = Array.isArray(args[flag]) ? [...args[flag], ...value] : value;
  }

  // The outer shell already removed the quotes, and a space cannot put them back:
  // `tedi sh rm "my file"` would run `rm my file` and delete two other things.
  if (
    PARSED_AGAIN.has(last) &&
    words.length > slots.length &&
    words.slice(slots.length - 1).some((w) => w === "" || /\s/.test(w))
  ) {
    throw new UsageError(
      `Your shell removed the quotes, so this cannot run as you wrote it. Quote the whole thing: tedi sh 'rm "my file"'`,
    );
  }

  words.forEach((word, i) => {
    const slot = slots[i];
    if (slot === undefined) {
      // `tedi sh git status`: extra words belong to a trailing string or list.
      if (props[last]?.type === "string") {
        args[last] = `${args[last]} ${word}`;
        return;
      }
      if (props[last]?.type === "array") {
        args[last] = [...args[last], ...coerce(last, word, props[last])];
        return;
      }
      throw new UsageError(`Did not expect "${word}".`);
    }
    args[slot] = coerce(slot, word, props[slot]);
  });

  // The window has no idea where this shell is standing. Core tools only: to an
  // extension, `path` may be a URL path or a remote one, and rewriting that would
  // send a request somewhere nobody asked for.
  for (const key of localPaths ? ["cwd", "path", "local"] : []) {
    if (typeof args[key] === "string" && props[key]) {
      args[key] = path.resolve(cwd, args[key]).replaceAll("\\", "/");
    }
  }
  return args;
}

function verbHelp(found, def) {
  const props = def.inputSchema?.properties ?? {};
  const slots = (positionalFor(found, []) ?? def.inputSchema?.required ?? []).filter(
    (k) => !(k in (found.args ?? {})),
  );
  // A description opens with the actions it applies to ("close / rotate: the pane."),
  // so a shortcut fixed to one action lists only the flags that action reads.
  const action = found.args?.action;
  const applies = (spec) => {
    const scope = /^([a-z_+ /]+):/.exec(spec.description ?? "")?.[1];
    return !action || !scope || scope.split(/[ /+]+/).includes(action);
  };
  const lines = Object.entries(props)
    .filter(([k, spec]) => !(k in (found.args ?? {})) && applies(spec))
    .map(([k, spec]) => {
      const type = spec.enum ? spec.enum.join(" | ") : (spec.type ?? "any");
      const flag = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return `  --${flag} <${type}>${spec.description ? `  ${spec.description}` : ""}`;
    });
  const usage = ["[flags]", ...slots.map((s) => `<${s}>`)].join(" ");
  const examples = CLI_EXAMPLES[found.verb] ?? CLI_EXAMPLES[found.tool];
  const shown = examples ? `\n\nExamples:\n${examples.map((e) => `  ${e}`).join("\n")}` : "";
  return `tedi ${found.verb.replaceAll("_", "-")} ${usage}\n\n${found.about ?? def.description}\n\n${lines.join("\n")}${shown}\n\nAdd --json for one JSON value (the default when piped), --human for a table.\n`;
}

/** Who is reading. An explicit flag, then `TEDI_OUTPUT`, then whether stdout is a terminal. */
export function outputMode(flag, env, isTty) {
  if (flag) return flag;
  if (env === "json" || env === "human") return env;
  return isTty ? "human" : "json";
}

/** An image block goes to a temp PNG, since a shell cannot show one. */
function withImagesSaved(out) {
  if (!Array.isArray(out?.content)) return out;
  const text = out.content.filter((b) => b.type !== "image").map((b) => b.text ?? "");
  const images = out.content
    .filter((b) => b.type === "image")
    .map((b) => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "tedi-")), "image.png");
      writeFileSync(file, Buffer.from(b.data, "base64"));
      return file;
    });
  return { text: text.join("\n"), images };
}

/** One JSON value on stdout, whatever the tool answered. */
export const asJson = (value) =>
  JSON.stringify(typeof value === "string" ? { message: value } : (value ?? null));

const humanOptions = () => ({
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  width: process.stdout.isTTY ? process.stdout.columns : 0,
  home: homedir().replaceAll("\\", "/"),
});

/** Which verb was probably meant: the one a model or a tired hand can act on. */
export function unknownVerb(verb) {
  const v = verb.replaceAll("-", "_").toLowerCase();
  const names = [...Object.keys(ALIASES), ...TOOL_NAMES];
  const near = names.filter(
    (n) =>
      n.includes(v) ||
      v.includes(n) ||
      (v.length > 2 && n[0] === v[0] && [...v].filter((c) => n.includes(c)).length >= v.length - 1),
  );
  const hint = near.length
    ? ` Did you mean: ${[...new Set(near)].slice(0, 4).join(", ").replaceAll("_", "-")}?`
    : "";
  return `Unknown verb "${verb}".${hint} \`tedi tools\` lists them all. To open a path, write it with a slash: tedi ./${verb}`;
}

/** Dev verbs: they want a real DevTools connection, not the tool surface. */
async function devVerb(verb, argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, "")] = argv[i + 1];
  const port = Number(opts.port) || Number(process.env.TEDI_DEBUG_PORT) || 9222;
  const { connect, listTargets } = await import("./driver.mjs");
  if (verb === "targets") {
    for (const t of await listTargets(port)) {
      console.log(`${t.type.padEnd(8)} ${t.title || "(untitled)"}\n         ${t.url}`);
    }
    return 0;
  }
  const d = await connect({ port, target: opts.target });
  try {
    const { default: sweep } = await import("./sweep.mjs");
    const { pass, total } = await sweep(d);
    return pass < total ? 1 : 0;
  } finally {
    await d.close();
  }
}

/** The answer came back, but what was waited for had not finished. Status 1, so
 *  `tedi wait 5 && deploy` stops. */
export const unfinished = (tool, out) =>
  (tool === "sh" && out?.timedOut === true) ||
  (tool === "wait_for_terminal" && out?.done === false);

// --- `tedi mcp`: connect an agent. Needs no running TEDI, because it only edits config files. ---

const MCP_USAGE = `tedi mcp                       run the MCP server on stdio, for an agent to start
tedi mcp status                which agents are connected, and whether TEDI answers
tedi mcp install [agent...]    connect them, every one found here unless named (--project: this folder)
tedi mcp uninstall [agent...]  disconnect them
tedi mcp config [agent]        print the config instead of writing it

Agents: ${TARGETS.map((t) => t.id).join(", ")}`;

const BUNDLE = () => process.env.TEDI_BUNDLE_ID || "id.ilhamrisky.tedi";
const SERVER_FILE = () =>
  fileURLToPath(new URL("./server.mjs", import.meta.url)).replaceAll("\\", "/");
const agentIsHere = (t) => t.probes.some((p) => existsSync(path.join(homedir(), p)));
const configFile = (t, project) =>
  project ? t.projectFile && path.join(process.cwd(), t.projectFile) : path.join(homedir(), t.file);

/** "" only when the file is not there: anything else must not read as an empty config, or
 *  the writer replaces `.claude.json` and its whole project history with one entry. */
function readConfig(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw new Error(`${file} cannot be read (${e.code}); leaving it alone.`);
  }
}

/** Through a rename, so a crash mid-write cannot leave half of someone's config. Onto the real
 *  file with its own mode: a dotfile manager's symlink stays a link, a 0600 config stays 0600. */
function writeConfig(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const real = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(real) ? statSync(real).mode & 0o777 : 0o600;
  const tmp = `${real}.tedi-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, real);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function pickAgents(names, fallback) {
  if (!names.length) return fallback;
  return names.map((name) => {
    const t = TARGETS.find((x) => x.id === name);
    if (!t)
      throw new UsageError(`No agent "${name}". Have: ${TARGETS.map((x) => x.id).join(", ")}`);
    return t;
  });
}

async function mcpStatus(project) {
  const agents = TARGETS.map((t) => {
    const file = configFile(t, project);
    const present = agentIsHere(t) && Boolean(file);
    let installed = false;
    try {
      installed = present && readsAsInstalled(t, readConfig(file), SERVER_FILE(), BUNDLE());
    } catch {
      // One unreadable config degrades its own row, not the whole report.
    }
    return { id: t.id, name: t.name, present, installed, config: present ? file : null };
  });
  let running = true;
  try {
    (await connectBridge({ timeoutMs: 2000 })).close();
  } catch {
    running = false;
  }
  const surface = currentSurface();
  return {
    running,
    profile: BUNDLE(),
    node: process.version,
    server: SERVER_FILE(),
    switchedOff: [...surface.disabled, ...surface.disabledExtensions],
    agents,
  };
}

function mcpStatusText(st, o) {
  const shortened = (file) => (file ?? "").replaceAll("\\", "/").replace(o.home, "~");
  return [
    pretty(
      {
        TEDI: `${st.running ? "running" : "not running"} (${st.profile})`,
        Node: st.node,
        Server: shortened(st.server),
        Off: st.switchedOff.length ? st.switchedOff.join(", ") : "nothing",
      },
      o,
    ),
    "",
    table(
      st.agents,
      [
        ["AGENT", (a) => a.id],
        ["STATE", (a) => (a.installed ? "connected" : a.present ? "not connected" : "not found")],
        ["CONFIG", (a) => shortened(a.config)],
      ],
      o,
    ),
  ].join("\n");
}

async function mcpCommand(argv, flag) {
  const project = argv.includes("--project");
  for (const f of ["json", "human"]) if (argv.includes(`--${f}`)) flag = f;
  const [sub = "serve", ...names] = argv.filter((a) => !a.startsWith("--"));
  const mode = outputMode(flag, process.env.TEDI_OUTPUT, process.stdout.isTTY);

  if (argv.includes("--help") || sub === "help") return finish(0, MCP_USAGE);
  if (sub === "serve") return serveStdio();

  if (sub === "status") {
    const st = await mcpStatus(project);
    return finish(0, mode === "json" ? asJson(st) : mcpStatusText(st, humanOptions()));
  }

  if (sub === "config") {
    if (!names.length) {
      return finish(
        0,
        `Any MCP client: a stdio server with command "tedi" and args ["mcp"].\n\n${MCP_USAGE}`,
      );
    }
    const [target] = pickAgents(names, []);
    process.stderr.write(
      `# in ${configFile(target, project) ?? path.join(homedir(), target.file)}\n`,
    );
    return finish(0, withEntry(target, "", SERVER_FILE(), BUNDLE()));
  }

  if (sub === "install" || sub === "uninstall") {
    const rows = [];
    for (const t of pickAgents(names, TARGETS.filter(agentIsHere))) {
      const file = configFile(t, project);
      if (!file) {
        rows.push({ id: t.id, done: false, why: `${t.name} has no per-project config` });
      } else if (!agentIsHere(t)) {
        rows.push({ id: t.id, done: false, why: `${t.name} is not installed here` });
      } else {
        // One config that will not parse must not cost the others, or hide what was written.
        try {
          const text = readConfig(file);
          if (sub === "install") writeConfig(file, withEntry(t, text, SERVER_FILE(), BUNDLE()));
          else if (text.trim()) writeConfig(file, withoutEntry(t, text));
          rows.push({ id: t.id, done: true, config: file });
        } catch (e) {
          rows.push({ id: t.id, done: false, failed: true, why: `${file}: ${e.message}` });
        }
      }
    }
    const status = rows.some((r) => r.failed) ? 1 : 0;
    if (mode === "json") return finish(status, asJson(rows), process.stdout);
    const lines = rows.map((r) =>
      r.done ? `${r.id}: ${sub}ed, ${r.config}` : `${r.id}: ${r.why}`,
    );
    if (!lines.length) return finish(0, "No supported AI agent was found on this machine.");
    if (sub === "install") lines.push("", "Restart the agent to pick it up (Hermes: /reload-mcp).");
    return finish(status, lines.join("\n"), process.stdout);
  }

  throw new UsageError(`No "tedi mcp ${sub}".\n\n${MCP_USAGE}`);
}

/** Print and leave. Through the write callback because a piped stdout on Windows
 *  is asynchronous, and exiting first cuts the tail of a long answer. */
function finish(code, text, stream = code === 0 ? process.stdout : process.stderr) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`, () => process.exit(code));
}

async function main(argv) {
  // Before the verb too, and Rust lets that through: `tedi --json panes`.
  let flag = null;
  while (argv[0] === "--json" || argv[0] === "--human") flag = argv.shift().slice(2);

  const [verb, ...rest] = argv;
  if (verb === "targets" || verb === "sweep") return finish(await devVerb(verb, rest), "");
  if (verb === "mcp") return mcpCommand(rest, flag);

  // Docs read the same whoever asks: a list of verbs is more use to a model as the guide, and
  // JSON only when it says so.
  if (!verb || verb === "help" || verb === "tools") {
    const asData = flag === "json" || rest.includes("--json");
    const tools = await listTools();
    const wanted = verb === "help" ? rest.find((a) => !a.startsWith("--")) : undefined;
    if (!wanted) return finish(0, asData ? asJson(cliVerbs(tools)) : cliGuide(tools));
    const found = resolveVerb(wanted);
    const def = found && tools.find((t) => t.name === found.tool);
    if (!def) return finish(2, unknownVerb(wanted));
    return finish(
      0,
      asData
        ? asJson({
            ...def,
            verb: found.verb,
            fixedArgs: found.args,
            examples: CLI_EXAMPLES[found.verb],
          })
        : verbHelp(found, def),
    );
  }

  const found = resolveVerb(verb);
  if (!found) {
    return finish(2, unknownVerb(verb));
  }

  const def = TOOL_DEFS[found.tool] && {
    inputSchema: TOOL_DEFS[found.tool].schema,
    description: TOOL_DEFS[found.tool].description,
  };
  const schema =
    def?.inputSchema ?? (await listTools()).find((t) => t.name === found.tool)?.inputSchema;

  // An extension's schema comes from the running app, so none means none of it answers.
  if (!schema) {
    return finish(
      1,
      `"${found.tool}" is not available: its extension is disabled, switched off in Install MCP, or not installed.`,
    );
  }

  // Only straight after the verb: `tedi sh git --help` is a command to run.
  if (rest[0] === "--help" || rest[0] === "-h") {
    return finish(0, verbHelp(found, { inputSchema: schema, description: def?.description ?? "" }));
  }

  // `inspect logs` reports what arrived since this connection started capturing,
  // and a one-shot process has only just connected. Read once to arm the capture,
  // wait, read again; a single read would always say nothing was logged.
  let wait = 0;
  let argv2 = rest;
  if (found.verb === "logs") {
    const at = rest.findIndex((a) => a === "--for" || a.startsWith("--for="));
    const raw = at === -1 ? "3" : rest[at].startsWith("--for=") ? rest[at].slice(6) : rest[at + 1];
    const seconds = Number(raw);
    if (raw === undefined || raw === "" || !(seconds >= 0)) {
      throw new UsageError(`--for wants seconds, got "${raw ?? ""}".`);
    }
    wait = seconds * 1000;
    const width = at !== -1 && rest[at] === "--for" ? 2 : 1;
    argv2 = rest.filter((_, i) => at === -1 || i < at || i >= at + width);
  }

  const args = parseArgs(argv2, schema, {
    positional: positionalFor(found, argv2),
    fixed: found.args,
    localPaths: Boolean(TOOL_DEFS[found.tool]),
    onOutput: (f) => {
      flag = f;
    },
  });
  const mode = outputMode(flag, process.env.TEDI_OUTPUT, process.stdout.isTTY);
  // The table has no room for it, and each tail is a walk over that pane's whole buffer.
  if (mode === "human" && found.verb === "panes" && args.tail === undefined) args.tail = 0;

  if (found.verb === "logs") {
    await callTool(found.tool, args);
    await new Promise((r) => setTimeout(r, wait));
  }
  const out = withImagesSaved(await callTool(found.tool, args));
  closeTransport();
  const value = found.select ? (out?.[found.select] ?? null) : out;
  const text = mode === "json" ? asJson(value) : humanize(found, args, value, humanOptions());
  return finish(unfinished(found.tool, value) ? 1 : 0, text, process.stdout);
}

// Real paths on both sides: node runs the main module from its real path, so behind
// a symlink a plain compare says "imported", and the command does nothing and exits 0.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    finish(err instanceof UsageError ? 2 : 1, err.message);
  });
}
