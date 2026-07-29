import type { Language, StreamParser } from "@codemirror/language";
import { StringStream } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { LANGUAGES, detectLanguageId } from "@/modules/editor/lib/languages";

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
  // Odin / Zig / Nim / Solidity / Gleam / Hare and the rest of the hand-rolled
  // grammars are reached through the registry fallback below - listing them
  // twice is what let the two tables drift apart in the first place.
  // ── More legacy modes ──
  haxe: () =>
    import("@codemirror/legacy-modes/mode/haxe").then(
      (m) => m.haxe as unknown as StreamParser<unknown>,
    ),
  latex: () =>
    import("@codemirror/legacy-modes/mode/stex").then(
      (m) => m.stex as unknown as StreamParser<unknown>,
    ),
  wast: () =>
    import("@codemirror/legacy-modes/mode/wast").then(
      (m) => m.wast as unknown as StreamParser<unknown>,
    ),
  nsis: () =>
    import("@codemirror/legacy-modes/mode/nsis").then(
      (m) => m.nsis as unknown as StreamParser<unknown>,
    ),
  smalltalk: () =>
    import("@codemirror/legacy-modes/mode/smalltalk").then(
      (m) => m.smalltalk as unknown as StreamParser<unknown>,
    ),
  cypher: () =>
    import("@codemirror/legacy-modes/mode/cypher").then(
      (m) => m.cypher as unknown as StreamParser<unknown>,
    ),
  turtle: () =>
    import("@codemirror/legacy-modes/mode/turtle").then(
      (m) => m.turtle as unknown as StreamParser<unknown>,
    ),
  sparql: () =>
    import("@codemirror/legacy-modes/mode/sparql").then(
      (m) => m.sparql as unknown as StreamParser<unknown>,
    ),
  xquery: () =>
    import("@codemirror/legacy-modes/mode/xquery").then(
      (m) => m.xQuery as unknown as StreamParser<unknown>,
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
  // HTML / Web. The template dialects are HTML with an embedded tag syntax;
  // routing them here (rather than letting the registry fallback find them)
  // matters because their registry loader returns an Extension, and only the
  // Lezer `loaders` table can turn that into a highlightable Language.
  htm: "html",
  xhtml: "html",
  svg: "xml",
  vue: "html",
  svelte: "html",
  astro: "html",
  blade: "html",
  ejs: "html",
  erb: "html",
  rhtml: "html",
  hbs: "html",
  handlebars: "html",
  mustache: "html",
  twig: "html",
  liquid: "html",
  razor: "html",
  cshtml: "html",
  tpl: "html",
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
  gemspec: "ruby",
  pl: "perl",
  pm: "perl",
  hs: "haskell",
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
  // Hardware. `v` is spelled out because the registry has a language whose id
  // is literally "v" (vlang) and ids outrank extensions there - without this
  // the chat would read ```v as V while the editor reads `.v` as Verilog.
  // V is still reachable as ```vlang / ```vsh.
  v: "verilog",
  sv: "verilog",
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
  // Modern langs
  odinlang: "odin",
  ziglang: "zig",
  nimrod: "nim",
  nimble: "nim",
  nims: "nim",
  sol: "solidity",
  ha: "hare",
  hx: "haxe",
  hxml: "haxe",
  // TeX / LaTeX
  tex: "latex",
  stex: "latex",
  // WebAssembly text
  wat: "wast",
  wasm: "wast",
  // Query / RDF
  cql: "cypher",
  cyp: "cypher",
  ttl: "turtle",
  rq: "sparql",
  xq: "xquery",
  xqy: "xquery",
  xqm: "xquery",
};

// Fallback for every fence tag the two tables above do not name: the editor's
// language registry already maps ~180 languages to a loader, so a ```nix or
// ```makefile block highlights without this file mirroring that list - and,
// more to the point, without the two lists drifting apart (a hand-mirrored
// `jl` used to resolve to Octave here while the editor read it as Julia).
// Only the stream-parser half is usable: the registry's `lang-*` entries hand
// back an Extension, and the Lezer path needs a `Language`, which the explicit
// `loaders` table above already covers for those.
// Ids win over aliases, so a fuzzy-search alias on an earlier entry can never
// outrank another language's canonical name (```sass is Sass, even though the
// SCSS entry lists "sass" as a search term).
const registryByKey = new Map<string, (typeof LANGUAGES)[number]>();
for (const def of LANGUAGES) registryByKey.set(def.id, def);
for (const def of LANGUAGES) {
  for (const alias of def.aliases ?? []) {
    if (!registryByKey.has(alias)) registryByKey.set(alias, def);
  }
}

function registryLookup(tag: string): string | null {
  const hit = registryByKey.get(tag);
  if (hit) return hit.id;
  // Extension spelling (```mjs, ```bzl): reuse the registry's own precedence.
  return detectLanguageId(`f.${tag}`);
}

type ResolvedKey =
  | { kind: "lezer"; key: keyof typeof loaders }
  | { kind: "stream"; key: keyof typeof streamLoaders }
  | { kind: "registry"; key: string };

function resolve(lang: string | null | undefined): ResolvedKey | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  const direct = lower in aliases ? aliases[lower]! : lower;
  if (direct in loaders) return { kind: "lezer", key: direct as keyof typeof loaders };
  if (direct in streamLoaders) return { kind: "stream", key: direct as keyof typeof streamLoaders };
  const id = registryLookup(direct);
  return id ? { kind: "registry", key: id } : null;
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

/**
 * Load a registry language's parser. Returns `null` when that entry is backed
 * by a `lang-*` package (its loader hands back an Extension, not a parser we
 * can drive token by token) - the caller then falls back to a plain block.
 */
async function getRegistryStream(id: string): Promise<StreamParser<unknown> | null> {
  const cacheKey = `registry:${id}`;
  const hit = streamCache.get(cacheKey);
  if (hit) return hit;
  const def = registryByKey.get(id);
  if (!def) return null;
  const loaded = await def.load();
  if (!isStreamParser(loaded)) return null;
  streamCache.set(cacheKey, loaded);
  return loaded;
}

function isStreamParser(v: unknown): v is StreamParser<unknown> {
  return (
    typeof v === "object" && v !== null && typeof (v as { token?: unknown }).token === "function"
  );
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
      // The real CodeMirror tokenizer driver resets `start` before every
      // token so `stream.current()` (used by legacy parsers for keyword
      // lookups) returns just the current token, not the whole line so far.
      // Without this, only the first token on each line classifies correctly.
      stream.start = stream.pos;
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

  if (r.kind === "registry") {
    const parser = await getRegistryStream(r.key);
    return parser ? highlightStream(code, parser) : null;
  }

  const parser = await getStream(r.key);
  return highlightStream(code, parser);
}
