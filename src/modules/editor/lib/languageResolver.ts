import type { Extension } from "@codemirror/state";

type LoaderResult = Extension | { token: unknown };
type LanguageLoader = () => Promise<LoaderResult>;

/**
 * Extension to loader map. Each loader dynamic-imports so language packs
 * only enter the bundle when a matching file is opened.
 * Loaders return either an Extension (lang-* packages) or a raw StreamParser
 * (legacy-modes); `resolveLanguage` wraps the latter in StreamLanguage.
 */
const loaders: Record<string, LanguageLoader> = {
  // JavaScript / TypeScript family
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),
  cts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  mts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),

  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  pyw: () => import("@codemirror/lang-python").then((m) => m.python()),
  pyi: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  jsonc: () => import("@codemirror/lang-json").then((m) => m.json()),

  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  mdx: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),

  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  xhtml: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),

  php: () => import("@codemirror/lang-php").then((m) => m.php({ plain: true })),
  phtml: () => import("@codemirror/lang-php").then((m) => m.php({ plain: true })),

  // Go
  go: () => import("@codemirror/legacy-modes/mode/go").then((m) => m.go),

  // C / C++ family
  c: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  h: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  cpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cc: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  ino: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),

  // Java / JVM
  java: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java),
  kt: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  kts: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  scala: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
  groovy: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy),
  gradle: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy),
  clj: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  cljs: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  cljc: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  edn: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),

  // C# / Objective-C / Dart
  cs: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),
  m: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC),
  mm: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveCpp),
  dart: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart),

  // Swift
  swift: () => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),

  // Ruby
  rb: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
  rake: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
  gemspec: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),

  // Perl
  pl: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  pm: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),

  // Lua
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),

  // R
  r: () => import("@codemirror/legacy-modes/mode/r").then((m) => m.r),

  // Julia
  jl: () => import("@codemirror/legacy-modes/mode/julia").then((m) => m.julia),

  // Haskell / ML family
  hs: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell),
  lhs: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell),
  ml: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml),
  mli: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml),
  fs: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp),
  fsx: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp),
  fsi: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp),

  // Elm
  elm: () => import("@codemirror/legacy-modes/mode/elm").then((m) => m.elm),

  // Erlang
  erl: () => import("@codemirror/legacy-modes/mode/erlang").then((m) => m.erlang),
  hrl: () => import("@codemirror/legacy-modes/mode/erlang").then((m) => m.erlang),

  // Crystal
  cr: () => import("@codemirror/legacy-modes/mode/crystal").then((m) => m.crystal),

  // Pascal / VB / Fortran / COBOL
  pas: () => import("@codemirror/legacy-modes/mode/pascal").then((m) => m.pascal),
  pp: () => import("@codemirror/legacy-modes/mode/pascal").then((m) => m.pascal),
  vb: () => import("@codemirror/legacy-modes/mode/vb").then((m) => m.vb),
  vbs: () => import("@codemirror/legacy-modes/mode/vbscript").then((m) => m.vbScript),
  f: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran),
  f90: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran),
  f95: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran),
  cob: () => import("@codemirror/legacy-modes/mode/cobol").then((m) => m.cobol),
  cbl: () => import("@codemirror/legacy-modes/mode/cobol").then((m) => m.cobol),

  // Tcl / Lisp / Scheme
  tcl: () => import("@codemirror/legacy-modes/mode/tcl").then((m) => m.tcl),
  lisp: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
  cl: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
  scm: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme),
  ss: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme),
  rkt: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme),

  // SQL
  sql: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL),
  mysql: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.mySQL),
  pgsql: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.pgSQL),
  psql: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.pgSQL),
  sqlite: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.sqlite),

  // XML family
  xml: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  xsl: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  xsd: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  svg: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  plist: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  rss: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  atom: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),

  // Stylesheet
  scss: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.sCSS),
  less: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.less),
  sass: () => import("@codemirror/legacy-modes/mode/sass").then((m) => m.sass),
  styl: () => import("@codemirror/legacy-modes/mode/stylus").then((m) => m.stylus),

  // CoffeeScript / LiveScript / Pug
  coffee: () => import("@codemirror/legacy-modes/mode/coffeescript").then((m) => m.coffeeScript),
  ls: () => import("@codemirror/legacy-modes/mode/livescript").then((m) => m.liveScript),
  pug: () => import("@codemirror/legacy-modes/mode/pug").then((m) => m.pug),
  jade: () => import("@codemirror/legacy-modes/mode/pug").then((m) => m.pug),

  // PowerShell / Shell / Batch
  ps1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  psm1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  psd1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  sh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  bash: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  zsh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  fish: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),

  // Verilog / VHDL / hardware
  v: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => m.verilog),
  sv: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => m.verilog),
  vhd: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => m.vhdl),
  vhdl: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => m.vhdl),

  // Web build / config / data
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  yaml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  yml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  ini: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  conf: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  cfg: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  properties: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  env: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  dockerfile: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile),
  proto: () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf),
  cmake: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake),
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  patch: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  nginx: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx),

  // Assembly
  s: () => import("@codemirror/legacy-modes/mode/gas").then((m) => m.gas),
  asm: () => import("@codemirror/legacy-modes/mode/gas").then((m) => m.gas),

  // Misc niche
  d: () => import("@codemirror/legacy-modes/mode/d").then((m) => m.d),
  // .zig and .nim have no upstream legacy parser; fall back to plaintext.
};

const filenameOverrides: Record<string, LanguageLoader> = {
  dockerfile: loaders.dockerfile!,
  "dockerfile.dev": loaders.dockerfile!,
  "dockerfile.prod": loaders.dockerfile!,
  containerfile: loaders.dockerfile!,
  // GNU Make has no legacy parser; CMake does.
  cmakelists: loaders.cmake!,
  "cmakelists.txt": loaders.cmake!,
  "go.mod": loaders.go!,
  "go.sum": loaders.go!,
  gemfile: loaders.rb!,
  rakefile: loaders.rb!,
  podfile: loaders.rb!,
  vagrantfile: loaders.rb!,
  ".bashrc": loaders.sh!,
  ".bash_profile": loaders.sh!,
  ".zshrc": loaders.sh!,
  ".profile": loaders.sh!,
  ".env": loaders.env!,
};

function extOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
}

function isStreamParser(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && typeof (v as { token?: unknown }).token === "function"
  );
}

export async function resolveLanguage(filename: string): Promise<Extension | null> {
  const lower = filename.toLowerCase();
  const base = lower.split(/[\\/]/).pop() ?? lower;

  const byName = filenameOverrides[base];
  const loader = byName ?? loaders[extOf(base) ?? ""];
  if (!loader) return null;

  const result = await loader();
  if (isStreamParser(result)) {
    const { StreamLanguage } = await import("@codemirror/language");
    return StreamLanguage.define(result as Parameters<typeof StreamLanguage.define>[0]);
  }
  return result as Extension;
}
