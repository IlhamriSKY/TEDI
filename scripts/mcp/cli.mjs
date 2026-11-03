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
 * Exit status: 0 answered, 1 the tool or TEDI refused, 2 the command line was wrong.
 */

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, closeDriver, listTools, pick } from "./server.mjs";
import { ALIASES, CLI_EXAMPLES, cliGuide, resolveVerb, TOOL_DEFS, TOOL_NAMES } from "./tools.mjs";

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
  inspect: (w) =>
    w === "sessions" ? ["what", "filter"] : w === "logs" ? ["what", "level"] : ["what"],
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
  { positional, fixed = {}, cwd = process.cwd(), localPaths = true } = {},
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
  return `tedi ${found.verb.replaceAll("_", "-")} ${usage}\n\n${found.about ?? def.description}\n\n${lines.join("\n")}${shown}\n`;
}

/** Text as it is; an image block goes to a temp PNG, since a shell cannot show one. */
function render(out, select) {
  if (typeof out === "object" && Array.isArray(out?.content)) {
    return out.content
      .map((block) => {
        if (block.type !== "image") return block.text ?? "";
        const file = path.join(mkdtempSync(path.join(tmpdir(), "tedi-")), "image.png");
        writeFileSync(file, Buffer.from(block.data, "base64"));
        return file;
      })
      .join("\n");
  }
  return select ? pick(out, select) : String(out);
}

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
 *  `tedi wait 5 && deploy` stops; the words are `wait_for_terminal`'s and `sh`'s. */
export const unfinished = (out) =>
  typeof out === "string" &&
  (/^leaf \d+: NOT done /.test(out) || /still running after the timeout\]$/.test(out));

/** Print and leave. Through the write callback because a piped stdout on Windows
 *  is asynchronous, and exiting first cuts the tail of a long answer. */
function finish(code, text, stream = code === 0 ? process.stdout : process.stderr) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`, () => process.exit(code));
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "targets" || verb === "sweep") return finish(await devVerb(verb, rest), "");

  // A terminal inherits this from whatever launched TEDI, and to the transport it
  // reads as a deliberate override. So a command aimed at a profile that was not
  // running fell through to that port and drove ANOTHER TEDI: real keystrokes into
  // a live session, reported as success. Which window a verb reaches is decided by
  // the profile alone.
  delete process.env.TEDI_DEBUG_PORT;

  if (!verb || verb === "help" || verb === "tools") {
    const tools = await listTools();
    const wanted = verb === "help" ? rest[0] : undefined;
    if (!wanted) return finish(0, cliGuide(tools));
    const found = resolveVerb(wanted);
    const def = found && tools.find((t) => t.name === found.tool);
    if (!def) return finish(2, unknownVerb(wanted));
    return finish(0, verbHelp(found, def));
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
    const at = rest.indexOf("--for");
    wait = (at === -1 ? 3 : Number(rest[at + 1]) || 3) * 1000;
    argv2 = rest.filter((_, i) => at === -1 || (i !== at && i !== at + 1));
  }

  const args = parseArgs(argv2, schema, {
    positional: positionalFor(found, argv2),
    fixed: found.args,
    localPaths: Boolean(TOOL_DEFS[found.tool]),
  });
  if (wait) {
    await callTool(found.tool, args);
    await new Promise((r) => setTimeout(r, wait));
  }
  const out = await callTool(found.tool, args);
  await closeDriver();
  return finish(unfinished(out) ? 1 : 0, render(out, found.select), process.stdout);
}

// Real paths on both sides: node runs the main module from its real path, so behind
// a symlink a plain compare says "imported", and the command does nothing and exits 0.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    finish(err instanceof UsageError ? 2 : 1, err.message);
  });
}
