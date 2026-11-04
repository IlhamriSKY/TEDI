/**
 * Which AI agents can be pointed at TEDI, and how to edit each one's config file.
 *
 * Text in, text out, ZERO IMPORTS: the Install MCP dialog (`mcpInstall/install.ts`) and
 * `tedi mcp install` read and write the files their own way and share every rule about what
 * goes in them. Nothing here touches the disk, so `install-verify` drives the edits against
 * real config text without going near anyone's home directory.
 *
 * Only agents whose config location is documented and stable. A guessed path is worse than
 * an absent one: it writes a file the tool never reads, and the indicator then claims an
 * integration that does not work.
 */

/** Key the entry is written under, in every format. */
export const SERVER_NAME = "tedi";

/**
 * Each project file is the tool's own documented per-project location: Claude Code
 * `.mcp.json`, Cursor `.cursor/mcp.json`, Gemini `.gemini/settings.json`; Codex
 * `.codex/config.toml` (the project must be trusted for Codex to read it); opencode
 * `opencode.json`; Copilot CLI `.copilot/mcp-config.json`. Hermes reads one global file.
 */
export const TARGETS = [
  {
    id: "claude",
    name: "Claude Code",
    file: ".claude.json",
    projectFile: ".mcp.json",
    probes: [".claude.json", ".claude"],
    format: "mcpServers",
  },
  {
    id: "codex",
    name: "Codex CLI",
    file: ".codex/config.toml",
    projectFile: ".codex/config.toml",
    probes: [".codex"],
    format: "codexToml",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    file: ".gemini/settings.json",
    projectFile: ".gemini/settings.json",
    probes: [".gemini"],
    format: "mcpServers",
  },
  {
    id: "opencode",
    name: "opencode",
    file: ".config/opencode/opencode.json",
    projectFile: "opencode.json",
    probes: [".config/opencode"],
    format: "opencode",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    file: ".copilot/mcp-config.json",
    projectFile: ".copilot/mcp-config.json",
    probes: [".copilot"],
    format: "mcpServers",
  },
  {
    id: "cursor",
    name: "Cursor",
    file: ".cursor/mcp.json",
    projectFile: ".cursor/mcp.json",
    probes: [".cursor"],
    format: "mcpServers",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    file: ".hermes/config.yaml",
    projectFile: null,
    probes: [".hermes"],
    format: "hermesYaml",
  },
];

/** The entry, in the shape each host expects. */
export function entryFor(format, server, bundle) {
  const env = { TEDI_BUNDLE_ID: bundle };
  if (format === "opencode") {
    return { type: "local", command: ["node", server], enabled: true, environment: env };
  }
  // `type: "stdio"` because that is exactly what Claude Code writes for itself - checked
  // against a real `~/.claude.json`, not inferred. Newer schemas use the field to tell stdio
  // from http/sse, and matching the host's own output is cheaper than finding out which of
  // them treat it as required.
  return { type: "stdio", command: "node", args: [server], env };
}

/** Where the entry lives inside each JSON host's config object. */
const ROOT_KEY = { mcpServers: "mcpServers", opencode: "mcp" };

// --- TOML ------------------------------------------------------------------
// Codex is the only TOML host here, and a parser for one table is not worth a dependency. A
// table runs to the next `[header]` or end of file, so replacing or removing exactly our own
// block is a bounded edit that leaves every other setting, comments included, byte-identical.

const CODEX_TABLE = `[mcp_servers.${SERVER_NAME}]`;

/**
 * Everything belonging to our server: the header, its body, AND its nested sub-tables. `$1`
 * preserves the newline that preceded it, so removing the block does not weld the line above
 * onto the line below.
 *
 * Two boundaries, both learned from a real `~/.codex/config.toml`:
 *
 *  1. A table ends at the next `[` that STARTS A LINE. Our own body contains
 *     `args = ["...path..."]`, so "up to the next bracket" orphaned the args and env lines
 *     onto whatever table preceded them.
 *  2. A server owns nested tables too: a real config had
 *     `[mcp_servers.chrome-devtools.tools.take_snapshot]` and eight siblings. A header that
 *     is ours-plus-a-dot continues the block; any other header ends it.
 */
function codexBlockRe() {
  const own = `\\[mcp_servers\\.${SERVER_NAME}`;
  return new RegExp(
    `(^|\\n)[ \\t]*${own}\\][^\\n]*\\n?` +
      `(?:(?:[ \\t]*${own}\\.[^\\n]*|(?![ \\t]*\\[)[^\\n]*)\\n?)*`,
    "g",
  );
}

function codexBlock(server, bundle) {
  // TOML basic strings take the same escapes as JSON, so a Windows path is safe through
  // JSON.stringify rather than a hand-rolled quoter.
  return `${CODEX_TABLE}\ncommand = "node"\nargs = [${JSON.stringify(server)}]\nenv = { TEDI_BUNDLE_ID = "${bundle}" }\n`;
}

// --- YAML ------------------------------------------------------------------
// Hermes keeps everything in one hand-edited `config.yaml`, comments included, so a YAML
// round trip would be the same offence as re-sorting someone's JSON. Same answer as TOML: a
// bounded edit of our own block under `mcp_servers:`, line by line.

/** Our entry on more than its own line (`tedi: {`) is flow style, which this cannot cut cleanly. */
function refuseFlowEntry(lines, at) {
  if (at.own !== -1 && !/:\s*(#.*)?$/.test(lines[at.own])) {
    throw new Error(`${SERVER_NAME} in this file is written in flow style; edit it by hand.`);
  }
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;
const isContent = (line) => line.trim() !== "" && !line.trim().startsWith("#");

/**
 * Where `mcp_servers:` and our entry under it sit. `bodyEnd` stops before any blank lines
 * and comments that lead into the next top-level key, because those belong to that key.
 */
function hermesLayout(lines) {
  const key = lines.findIndex((l) => HERMES_KEY.test(l));
  if (key === -1) return null;
  let bodyEnd = key + 1;
  for (let i = key + 1; i < lines.length; i++) {
    if (!isContent(lines[i])) continue;
    if (indentOf(lines[i]) === 0) break;
    bodyEnd = i + 1;
  }
  const first = lines.slice(key + 1, bodyEnd).find(isContent);
  const indent = first ? indentOf(first) : 2;
  const own = lines.findIndex(
    (l, i) =>
      i > key &&
      i < bodyEnd &&
      indentOf(l) === indent &&
      new RegExp(`^\\s*["']?${SERVER_NAME}["']?:(\\s|$)`).test(l),
  );
  let ownEnd = own + 1;
  if (own !== -1) {
    for (let i = own + 1; i < bodyEnd; i++) {
      if (isContent(lines[i]) && indentOf(lines[i]) <= indent) break;
      if (isContent(lines[i])) ownEnd = i + 1;
    }
  }
  return { key, bodyEnd, indent, own, ownEnd };
}

function hermesBlock(server, bundle, indent = 2) {
  const at = (n) => " ".repeat(indent * n);
  return [
    `${at(1)}${SERVER_NAME}:`,
    `${at(2)}command: "node"`,
    `${at(2)}args: [${JSON.stringify(server)}]`,
    `${at(2)}env:`,
    `${at(3)}TEDI_BUNDLE_ID: ${JSON.stringify(bundle)}`,
  ];
}

/** `mcp_servers:`, quoted or spaced, with a BOM on the file's first line. Missing one would append
 *  a second top-level key, and YAML keeps only one of them: the user's servers would vanish. */
const HERMES_KEY = /^\uFEFF?["']?mcp_servers["']?[ \t]*:(?=\s|$)/;

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

function hermesWith(text, server, bundle) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  if (!text.trim()) return `mcp_servers:\n${hermesBlock(server, bundle).join("\n")}\n`;
  const at = hermesLayout(lines);
  if (!at) {
    const body = text.replace(/\s*$/, "");
    return `${body}${eol}${eol}mcp_servers:${eol}${hermesBlock(server, bundle).join(eol)}${eol}`;
  }
  refuseFlowEntry(lines, at);
  const head = HERMES_KEY.exec(lines[at.key])[0];
  const inline = lines[at.key]
    .slice(head.length)
    .replace(/\s#.*$/, "")
    .trim();
  if (inline && !["{}", "null", "~"].includes(inline)) {
    // A flow mapping with servers in it. Rewriting that would mean parsing YAML.
    throw new Error(`mcp_servers in this file is written on one line; add ${SERVER_NAME} by hand.`);
  }
  if (inline) lines[at.key] = head;
  const block = hermesBlock(server, bundle, at.indent);
  if (at.own !== -1) {
    lines.splice(at.own, at.ownEnd - at.own, ...block);
  } else {
    lines.splice(at.bodyEnd, 0, ...block);
  }
  return lines.join(eol);
}

function hermesWithout(text) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const at = hermesLayout(lines);
  if (!at || at.own === -1) return text;
  refuseFlowEntry(lines, at);
  lines.splice(at.own, at.ownEnd - at.own);
  // A bare `mcp_servers:` is null in YAML, which is not the empty map this key should hold.
  const left = lines.slice(at.key + 1, at.bodyEnd - (at.ownEnd - at.own));
  if (!left.some(isContent)) lines[at.key] = `${HERMES_KEY.exec(lines[at.key])[0]} {}`;
  return lines.join(eol);
}

// --- read / write ----------------------------------------------------------

/**
 * EVERY BAG IN THIS FILE THAT CAN HOLD OUR ENTRY, in the order they are written.
 *
 * `~/.claude.json` carries the user-wide `mcpServers` at the top level AND a
 * `projects["<dir>"].mcpServers` per folder, which is where `claude mcp add` puts a server by
 * default. Reading only the top level meant the switch could sit at OFF while Claude Code
 * loaded TEDI from the project bag, and turning it off then removed nothing.
 */
function bags(json, key) {
  const out = [];
  const top = json[key];
  if (top && typeof top === "object") out.push(top);
  if (key !== "mcpServers") return out;
  const projects = json.projects;
  if (projects && typeof projects === "object") {
    for (const p of Object.values(projects)) {
      const b = p?.[key];
      if (b && typeof b === "object") out.push(b);
    }
  }
  return out;
}

/** Is our entry already in this file, and does it point at THIS install? */
export function readsAsInstalled(target, text, server, bundle) {
  if (!text.trim()) return false;
  if (target.format === "codexToml") {
    const block = codexBlockRe().exec(text)?.[0];
    return Boolean(block?.includes(server) && block.includes(bundle));
  }
  if (target.format === "hermesYaml") {
    const lines = text.split(/\r?\n/);
    const at = hermesLayout(lines);
    if (!at || at.own === -1) return false;
    const block = lines.slice(at.own, at.ownEnd).join("\n");
    return block.includes(JSON.stringify(server).slice(1, -1)) && block.includes(bundle);
  }
  try {
    const json = JSON.parse(text);
    // Stale entries (an older install path) count as NOT installed, so the button offers to
    // fix them instead of showing a green light on a config pointing at a directory the
    // updater replaced. An entry written by the OTHER build reads the same way: it would
    // drive this TEDI while reading another's switches.
    return bags(json, ROOT_KEY[target.format]).some((bag) => {
      const entry = bag[SERVER_NAME];
      const text2 = entry ? JSON.stringify(entry) : "";
      return Boolean(entry && text2.includes(server) && text2.includes(bundle));
    });
  } catch {
    return false;
  }
}

export function withEntry(target, text, server, bundle) {
  if (target.format === "hermesYaml") return hermesWith(text, server, bundle);
  if (target.format === "codexToml") {
    const stripped = text.replace(codexBlockRe(), "$1").replace(/\n{3,}/g, "\n\n");
    const sep = stripped.trim() ? `${stripped.trimEnd()}\n\n` : "";
    return `${sep}${codexBlock(server, bundle)}`;
  }
  // Preserves every other key, which is the whole risk here: these files hold the user's other
  // MCP servers and, for Claude Code, its entire project history. Parse-modify-serialize, never
  // overwrite. JSON.parse throwing on a broken file is the point: it leaves that file alone.
  const json = text.trim() ? JSON.parse(text) : {};
  const key = ROOT_KEY[target.format];
  // Clear the per-folder copies first, so installing leaves EXACTLY ONE tedi entry: a leftover
  // project-scoped one outranks the top level in Claude Code and would quietly win.
  for (const bag of bags(json, key)) delete bag[SERVER_NAME];
  const top = json[key] ?? {};
  top[SERVER_NAME] = entryFor(target.format, server, bundle);
  json[key] = top;
  return `${JSON.stringify(json, null, 2)}\n`;
}

export function withoutEntry(target, text) {
  if (!text.trim()) return text;
  if (target.format === "hermesYaml") return hermesWithout(text);
  if (target.format === "codexToml") {
    return text.replace(codexBlockRe(), "$1").replace(/\n{3,}/g, "\n\n");
  }
  const json = JSON.parse(text);
  // Out of every scope in the file: "off" has to mean the CLI cannot load us from it at all.
  for (const bag of bags(json, ROOT_KEY[target.format])) delete bag[SERVER_NAME];
  return `${JSON.stringify(json, null, 2)}\n`;
}
