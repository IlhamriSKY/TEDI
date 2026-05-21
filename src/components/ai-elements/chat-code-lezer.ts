import type { Language, StreamParser } from "@codemirror/language";
import { StringStream } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";

export type HighlightedNode = { kind: "text"; value: string; cls: string } | { kind: "break" };

type ParserLoader = () => Promise<Language>;
type StreamLoader = () => Promise<StreamParser<unknown>>;

// Only langs that ship a real Lezer parser. Legacy stream-modes (bash,
// yaml, toml, c/cpp, java, csharp) fall back to plain <pre> - they don't
// produce a Tree, and dragging in a token-stream driver isn't worth the
// bytes for chat-side highlight.
const loaders: Record<string, ParserLoader> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascriptLanguage),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.jsxLanguage),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.typescriptLanguage),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.tsxLanguage),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rustLanguage),
  go: () => import("@codemirror/lang-go").then((m) => m.goLanguage),
  python: () => import("@codemirror/lang-python").then((m) => m.pythonLanguage),
  json: () => import("@codemirror/lang-json").then((m) => m.jsonLanguage),
  html: () => import("@codemirror/lang-html").then((m) => m.htmlLanguage),
  css: () => import("@codemirror/lang-css").then((m) => m.cssLanguage),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdownLanguage),
  // `phpLanguage` parses files wrapped in `<?php …`. Chat snippets are bare
  // PHP, so use the `plain: true` variant's Language.
  php: () => import("@codemirror/lang-php").then((m) => m.php({ plain: true }).language),
};

// StreamParser fallback for langs without a Lezer parser. Token names emitted
// by legacy-modes (e.g. `keyword`, `string`, `comment`, `number`) line up with
// our `tok-*` CSS by prefix, so the same stylesheet works for both paths.
const streamLoaders: Record<string, StreamLoader> = {
  // ── C-like ──
  c: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.c as unknown as StreamParser<unknown>,
    ),
  cpp: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.cpp as unknown as StreamParser<unknown>,
    ),
  java: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.java as unknown as StreamParser<unknown>,
    ),
  csharp: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.csharp as unknown as StreamParser<unknown>,
    ),
  kotlin: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.kotlin as unknown as StreamParser<unknown>,
    ),
  scala: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.scala as unknown as StreamParser<unknown>,
    ),
  objectivec: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.objectiveC as unknown as StreamParser<unknown>,
    ),
  dart: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.dart as unknown as StreamParser<unknown>,
    ),
  // ── Config / Data ──
  yaml: () =>
    import("@codemirror/legacy-modes/mode/yaml").then(
      (m) => m.yaml as unknown as StreamParser<unknown>,
    ),
  toml: () =>
    import("@codemirror/legacy-modes/mode/toml").then(
      (m) => m.toml as unknown as StreamParser<unknown>,
    ),
  properties: () =>
    import("@codemirror/legacy-modes/mode/properties").then(
      (m) => m.properties as unknown as StreamParser<unknown>,
    ),
  // ── Scripting ──
  ruby: () =>
    import("@codemirror/legacy-modes/mode/ruby").then(
      (m) => m.ruby as unknown as StreamParser<unknown>,
    ),
  swift: () =>
    import("@codemirror/legacy-modes/mode/swift").then(
      (m) => m.swift as unknown as StreamParser<unknown>,
    ),
  lua: () =>
    import("@codemirror/legacy-modes/mode/lua").then(
      (m) => m.lua as unknown as StreamParser<unknown>,
    ),
  haskell: () =>
    import("@codemirror/legacy-modes/mode/haskell").then(
      (m) => m.haskell as unknown as StreamParser<unknown>,
    ),
  perl: () =>
    import("@codemirror/legacy-modes/mode/perl").then(
      (m) => m.perl as unknown as StreamParser<unknown>,
    ),
  r: () =>
    import("@codemirror/legacy-modes/mode/r").then((m) => m.r as unknown as StreamParser<unknown>),
  // ── Shell ──
  shell: () =>
    import("@codemirror/legacy-modes/mode/shell").then(
      (m) => m.shell as unknown as StreamParser<unknown>,
    ),
  powershell: () =>
    import("@codemirror/legacy-modes/mode/powershell").then(
      (m) => m.powerShell as unknown as StreamParser<unknown>,
    ),
  // ── Markup ──
  xml: () =>
    import("@codemirror/legacy-modes/mode/xml").then(
      (m) => m.xml as unknown as StreamParser<unknown>,
    ),
  // ── DevOps / Infra ──
  dockerfile: () =>
    import("@codemirror/legacy-modes/mode/dockerfile").then(
      (m) => m.dockerFile as unknown as StreamParser<unknown>,
    ),
  nginx: () =>
    import("@codemirror/legacy-modes/mode/nginx").then(
      (m) => m.nginx as unknown as StreamParser<unknown>,
    ),
  groovy: () =>
    import("@codemirror/legacy-modes/mode/groovy").then(
      (m) => m.groovy as unknown as StreamParser<unknown>,
    ),
  tcl: () =>
    import("@codemirror/legacy-modes/mode/tcl").then(
      (m) => m.tcl as unknown as StreamParser<unknown>,
    ),
  // ── Diff / SQL ──
  diff: () =>
    import("@codemirror/legacy-modes/mode/diff").then(
      (m) => m.diff as unknown as StreamParser<unknown>,
    ),
  sql: () =>
    import("@codemirror/legacy-modes/mode/sql").then(
      (m) => m.standardSQL as unknown as StreamParser<unknown>,
    ),
  pgsql: () =>
    import("@codemirror/legacy-modes/mode/sql").then(
      (m) => m.pgSQL as unknown as StreamParser<unknown>,
    ),
  mysql: () =>
    import("@codemirror/legacy-modes/mode/sql").then(
      (m) => m.mySQL as unknown as StreamParser<unknown>,
    ),
  sqlite: () =>
    import("@codemirror/legacy-modes/mode/sql").then(
      (m) => m.sqlite as unknown as StreamParser<unknown>,
    ),
  // ── Typed / Academic ──
  vb: () =>
    import("@codemirror/legacy-modes/mode/vb").then(
      (m) => m.vb as unknown as StreamParser<unknown>,
    ),
  octave: () =>
    import("@codemirror/legacy-modes/mode/octave").then(
      (m) => m.octave as unknown as StreamParser<unknown>,
    ),
  scheme: () =>
    import("@codemirror/legacy-modes/mode/scheme").then(
      (m) => m.scheme as unknown as StreamParser<unknown>,
    ),
  erlang: () =>
    import("@codemirror/legacy-modes/mode/erlang").then(
      (m) => m.erlang as unknown as StreamParser<unknown>,
    ),
  pascal: () =>
    import("@codemirror/legacy-modes/mode/pascal").then(
      (m) => m.pascal as unknown as StreamParser<unknown>,
    ),
  protobuf: () =>
    import("@codemirror/legacy-modes/mode/protobuf").then(
      (m) => m.protobuf as unknown as StreamParser<unknown>,
    ),
  verilog: () =>
    import("@codemirror/legacy-modes/mode/verilog").then(
      (m) => m.verilog as unknown as StreamParser<unknown>,
    ),
  oCaml: () =>
    import("@codemirror/legacy-modes/mode/mllike").then(
      (m) => m.oCaml as unknown as StreamParser<unknown>,
    ),
  fSharp: () =>
    import("@codemirror/legacy-modes/mode/mllike").then(
      (m) => m.fSharp as unknown as StreamParser<unknown>,
    ),
  http: () =>
    import("@codemirror/legacy-modes/mode/http").then(
      (m) => m.http as unknown as StreamParser<unknown>,
    ),
  gherkin: () =>
    import("@codemirror/legacy-modes/mode/gherkin").then(
      (m) => m.gherkin as unknown as StreamParser<unknown>,
    ),
};

const aliases: Record<string, string> = {
  // JavaScript / TypeScript
  javascript: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  // Rust / Go
  rs: "rust",
  golang: "go",
  // Python
  py: "python",
  // Markdown
  md: "markdown",
  mdx: "markdown",
  // HTML / Web
  htm: "html",
  xhtml: "html",
  svg: "xml",
  // CSS
  scss: "css",
  sass: "css",
  less: "css",
  // C-like
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  h: "c",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  "objective-c": "objectivec",
  objc: "objectivec",
  m: "objectivec",
  // Config
  yml: "yaml",
  ini: "properties",
  env: "properties",
  cfg: "properties",
  // Scripting
  rb: "ruby",
  erb: "ruby",
  gemspec: "ruby",
  pl: "perl",
  pm: "perl",
  hs: "haskell",
  jl: "octave",
  matlab: "octave",
  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  shellscript: "shell",
  console: "shell",
  // PowerShell
  pwsh: "powershell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  // DevOps
  docker: "dockerfile",
  conf: "nginx",
  nginxconf: "nginx",
  gradle: "groovy",
  // Diff
  patch: "diff",
  // SQL
  postgres: "pgsql",
  postgresql: "pgsql",
  plpgsql: "pgsql",
  psql: "pgsql",
  mariadb: "mysql",
  sqlite3: "sqlite",
  // Markup
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  plist: "xml",
  csproj: "xml",
  // Schema
  proto: "protobuf",
  graphql: "protobuf",
  gql: "protobuf",
  // Hardware
  v: "verilog",
  sv: "verilog",
  vhdl: "verilog",
  vhd: "verilog",
  // VB
  vbnet: "vb",
  vbs: "vb",
  // Erlang
  erl: "erlang",
  hrl: "erlang",
  // Pascal
  pas: "pascal",
  pp: "pascal",
  lpr: "pascal",
  // Scheme / Lisp
  scm: "scheme",
  rkt: "scheme",
  lisp: "scheme",
  cl: "scheme",
  el: "scheme",
  // OCaml / ML
  ml: "oCaml",
  mli: "oCaml",
  fs: "fSharp",
  fsx: "fSharp",
  fsi: "fSharp",
  // HTTP
  https: "http",
  curl: "shell",
  wget: "shell",
  // BDD
  feature: "gherkin",
};

type ResolvedKey =
  | { kind: "lezer"; key: keyof typeof loaders }
  | { kind: "stream"; key: keyof typeof streamLoaders };

function resolve(lang: string | null | undefined): ResolvedKey | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  const direct = lower in aliases ? aliases[lower]! : lower;
  if (direct in loaders) return { kind: "lezer", key: direct as keyof typeof loaders };
  if (direct in streamLoaders) return { kind: "stream", key: direct as keyof typeof streamLoaders };
  return null;
}

export function isHighlightable(lang: string | null | undefined): boolean {
  return resolve(lang) !== null;
}

const lezerCache = new Map<string, Language>();
const streamCache = new Map<string, StreamParser<unknown>>();

async function getLezer(key: keyof typeof loaders): Promise<Language> {
  const hit = lezerCache.get(key);
  if (hit) return hit;
  const lang = await loaders[key]!();
  lezerCache.set(key, lang);
  return lang;
}

async function getStream(key: keyof typeof streamLoaders): Promise<StreamParser<unknown>> {
  const hit = streamCache.get(key);
  if (hit) return hit;
  const parser = await streamLoaders[key]!();
  streamCache.set(key, parser);
  return parser;
}

function highlightStream(code: string, parser: StreamParser<unknown>): HighlightedNode[] {
  const state = parser.startState ? parser.startState(2) : ({} as unknown);
  const out: HighlightedNode[] = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) out.push({ kind: "break" });
    const line = lines[i] ?? "";
    if (parser.blankLine && line.length === 0) {
      parser.blankLine(state as never, 2);
      continue;
    }
    if (line.length === 0) continue;

    const stream = new StringStream(line, 2, 2, 0);
    while (!stream.eol()) {
      const start = stream.pos;
      let tag: string | null = null;
      try {
        tag = parser.token(stream, state as never) ?? null;
      } catch {
        tag = null;
      }
      // Guard: token() must advance; force one char if it didn't.
      if (stream.pos === start) {
        stream.pos = start + 1;
      }
      const text = line.slice(start, stream.pos);
      if (!text) continue;
      out.push({
        kind: "text",
        value: text,
        cls: tag ? mapStreamTag(tag) : "",
      });
    }
  }
  return out;
}

// Legacy-mode `token()` returns space-separated tag names like
// "keyword", "variable-2", "string-2", or "atom number". Map to our `tok-*`
// classes that the stylesheet already paints.
function mapStreamTag(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      // strip CodeMirror 5's "-2" / "-3" qualifiers
      const base = t.replace(/-\d+$/, "");
      switch (base) {
        case "variable":
          return "tok-variableName";
        case "variable-2":
          return "tok-variableName";
        case "def":
          return "tok-definition tok-variableName";
        case "property":
          return "tok-propertyName";
        case "type":
          return "tok-typeName";
        case "builtin":
          return "tok-name";
        case "atom":
          return "tok-atom";
        case "tag":
          return "tok-tagName";
        case "attribute":
          return "tok-attributeName";
        case "meta":
          return "tok-meta";
        case "qualifier":
          return "tok-modifier";
        case "operator":
          return "tok-operator";
        case "bracket":
          return "tok-bracket";
        case "punctuation":
          return "tok-punctuation";
        case "header":
          return "tok-heading";
        case "link":
          return "tok-link";
        case "string":
          return "tok-string";
        case "string-2":
          return "tok-string";
        case "comment":
          return "tok-comment";
        case "number":
          return "tok-number";
        case "keyword":
          return "tok-keyword";
        default:
          return `tok-${base}`;
      }
    })
    .join(" ");
}

export async function highlight(code: string, rawLang: string): Promise<HighlightedNode[] | null> {
  const r = resolve(rawLang);
  if (!r) return null;

  if (r.kind === "lezer") {
    const language = await getLezer(r.key);
    const tree = language.parser.parse(code);
    const out: HighlightedNode[] = [];
    highlightCode(
      code,
      tree,
      classHighlighter,
      (text: string, cls: string) => {
        out.push({ kind: "text", value: text, cls });
      },
      () => {
        out.push({ kind: "break" });
      },
    );
    return out;
  }

  const parser = await getStream(r.key);
  return highlightStream(code, parser);
}
