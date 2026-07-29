/**
 * Central language registry - the single source of truth for editor syntax
 * highlighting.
 *
 * Every language is one {@link lang} row carrying what three surfaces need:
 *  - detection: the extension list plus `files` / `patterns` map a path to a
 *    language id (used by `resolveLanguage` and the diff panes);
 *  - the manual override picker: `label` + `alias` drive fuzzy search, and the
 *    glyph defaults to the one the file tree shows for the first extension;
 *  - lazy loading: `load` dynamic-imports the parser, so a language pack only
 *    enters the bundle when a matching file is opened or picked.
 *
 * Extensions are matched first-definition-wins, so where two languages claim the
 * same suffix the earlier row is the deliberate default (`.m` is Objective-C,
 * not MATLAB; `.v` is Verilog, not V or Coq; `.pp` is Pascal, not Puppet). The
 * losing language stays reachable through the picker. `scripts/languages-verify.ts`
 * asserts every row is reachable, so a new row cannot silently shadow an old one.
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

type LoaderResult = Extension | StreamParser<unknown>;
type LanguageLoader = () => Promise<LoaderResult>;

export type LanguageDef = {
  /** Stable, unique id (also used as the override key). */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** Extra fuzzy-search terms (extensions are searchable automatically). */
  aliases?: string[];
  /** Lowercase, dot-less extensions that select this language. */
  extensions?: string[];
  /** Lowercase exact basenames (e.g. `dockerfile`, `go.mod`). */
  filenames?: string[];
  /** Lowercase basename patterns (e.g. `Dockerfile.prod`). Tested in order. */
  filenamePatterns?: RegExp[];
  /**
   * Representative filename resolved through the explorer's `fileIconUrl`, so
   * the picker icon is byte-identical to the file tree. Falls back to the
   * generic file glyph when the icon pack has no match.
   */
  icon: string;
  load: LanguageLoader;
};

/**
 * One thunk per parser module. `import()` needs a literal path to stay
 * analyzable, so the paths cannot be built from a variable - this map is what
 * keeps every mode in its own lazily fetched chunk while the table below stays
 * one line per language.
 */
const M = {
  apl: () => import("@codemirror/legacy-modes/mode/apl"),
  asciiarmor: () => import("@codemirror/legacy-modes/mode/asciiarmor"),
  brainfuck: () => import("@codemirror/legacy-modes/mode/brainfuck"),
  clike: () => import("@codemirror/legacy-modes/mode/clike"),
  clojure: () => import("@codemirror/legacy-modes/mode/clojure"),
  cmake: () => import("@codemirror/legacy-modes/mode/cmake"),
  cobol: () => import("@codemirror/legacy-modes/mode/cobol"),
  coffeescript: () => import("@codemirror/legacy-modes/mode/coffeescript"),
  commonlisp: () => import("@codemirror/legacy-modes/mode/commonlisp"),
  crystal: () => import("@codemirror/legacy-modes/mode/crystal"),
  css: () => import("@codemirror/legacy-modes/mode/css"),
  cypher: () => import("@codemirror/legacy-modes/mode/cypher"),
  d: () => import("@codemirror/legacy-modes/mode/d"),
  diff: () => import("@codemirror/legacy-modes/mode/diff"),
  dockerfile: () => import("@codemirror/legacy-modes/mode/dockerfile"),
  dtd: () => import("@codemirror/legacy-modes/mode/dtd"),
  dylan: () => import("@codemirror/legacy-modes/mode/dylan"),
  ebnf: () => import("@codemirror/legacy-modes/mode/ebnf"),
  ecl: () => import("@codemirror/legacy-modes/mode/ecl"),
  eiffel: () => import("@codemirror/legacy-modes/mode/eiffel"),
  elm: () => import("@codemirror/legacy-modes/mode/elm"),
  erlang: () => import("@codemirror/legacy-modes/mode/erlang"),
  factor: () => import("@codemirror/legacy-modes/mode/factor"),
  fcl: () => import("@codemirror/legacy-modes/mode/fcl"),
  forth: () => import("@codemirror/legacy-modes/mode/forth"),
  fortran: () => import("@codemirror/legacy-modes/mode/fortran"),
  gas: () => import("@codemirror/legacy-modes/mode/gas"),
  gherkin: () => import("@codemirror/legacy-modes/mode/gherkin"),
  groovy: () => import("@codemirror/legacy-modes/mode/groovy"),
  haskell: () => import("@codemirror/legacy-modes/mode/haskell"),
  haxe: () => import("@codemirror/legacy-modes/mode/haxe"),
  http: () => import("@codemirror/legacy-modes/mode/http"),
  jinja2: () => import("@codemirror/legacy-modes/mode/jinja2"),
  julia: () => import("@codemirror/legacy-modes/mode/julia"),
  livescript: () => import("@codemirror/legacy-modes/mode/livescript"),
  ll: () => import("./lineLanguages"),
  lua: () => import("@codemirror/legacy-modes/mode/lua"),
  mathematica: () => import("@codemirror/legacy-modes/mode/mathematica"),
  mbox: () => import("@codemirror/legacy-modes/mode/mbox"),
  mirc: () => import("@codemirror/legacy-modes/mode/mirc"),
  mllike: () => import("@codemirror/legacy-modes/mode/mllike"),
  modelica: () => import("@codemirror/legacy-modes/mode/modelica"),
  mscgen: () => import("@codemirror/legacy-modes/mode/mscgen"),
  nginx: () => import("@codemirror/legacy-modes/mode/nginx"),
  nsis: () => import("@codemirror/legacy-modes/mode/nsis"),
  ntriples: () => import("@codemirror/legacy-modes/mode/ntriples"),
  octave: () => import("@codemirror/legacy-modes/mode/octave"),
  oz: () => import("@codemirror/legacy-modes/mode/oz"),
  pascal: () => import("@codemirror/legacy-modes/mode/pascal"),
  pegjs: () => import("@codemirror/legacy-modes/mode/pegjs"),
  perl: () => import("@codemirror/legacy-modes/mode/perl"),
  pig: () => import("@codemirror/legacy-modes/mode/pig"),
  powershell: () => import("@codemirror/legacy-modes/mode/powershell"),
  properties: () => import("@codemirror/legacy-modes/mode/properties"),
  protobuf: () => import("@codemirror/legacy-modes/mode/protobuf"),
  pug: () => import("@codemirror/legacy-modes/mode/pug"),
  puppet: () => import("@codemirror/legacy-modes/mode/puppet"),
  python: () => import("@codemirror/legacy-modes/mode/python"),
  q: () => import("@codemirror/legacy-modes/mode/q"),
  r: () => import("@codemirror/legacy-modes/mode/r"),
  rpm: () => import("@codemirror/legacy-modes/mode/rpm"),
  ruby: () => import("@codemirror/legacy-modes/mode/ruby"),
  sas: () => import("@codemirror/legacy-modes/mode/sas"),
  sass: () => import("@codemirror/legacy-modes/mode/sass"),
  scheme: () => import("@codemirror/legacy-modes/mode/scheme"),
  shell: () => import("@codemirror/legacy-modes/mode/shell"),
  sieve: () => import("@codemirror/legacy-modes/mode/sieve"),
  sl: () => import("./streamLanguages"),
  smalltalk: () => import("@codemirror/legacy-modes/mode/smalltalk"),
  sparql: () => import("@codemirror/legacy-modes/mode/sparql"),
  sql: () => import("@codemirror/legacy-modes/mode/sql"),
  stex: () => import("@codemirror/legacy-modes/mode/stex"),
  stylus: () => import("@codemirror/legacy-modes/mode/stylus"),
  swift: () => import("@codemirror/legacy-modes/mode/swift"),
  tcl: () => import("@codemirror/legacy-modes/mode/tcl"),
  textile: () => import("@codemirror/legacy-modes/mode/textile"),
  tiddlywiki: () => import("@codemirror/legacy-modes/mode/tiddlywiki"),
  toml: () => import("@codemirror/legacy-modes/mode/toml"),
  troff: () => import("@codemirror/legacy-modes/mode/troff"),
  ttcn: () => import("@codemirror/legacy-modes/mode/ttcn"),
  turtle: () => import("@codemirror/legacy-modes/mode/turtle"),
  vb: () => import("@codemirror/legacy-modes/mode/vb"),
  vbscript: () => import("@codemirror/legacy-modes/mode/vbscript"),
  velocity: () => import("@codemirror/legacy-modes/mode/velocity"),
  verilog: () => import("@codemirror/legacy-modes/mode/verilog"),
  vhdl: () => import("@codemirror/legacy-modes/mode/vhdl"),
  wast: () => import("@codemirror/legacy-modes/mode/wast"),
  webidl: () => import("@codemirror/legacy-modes/mode/webidl"),
  xml: () => import("@codemirror/legacy-modes/mode/xml"),
  xquery: () => import("@codemirror/legacy-modes/mode/xquery"),
  yacas: () => import("@codemirror/legacy-modes/mode/yacas"),
  yaml: () => import("@codemirror/legacy-modes/mode/yaml"),
  z80: () => import("@codemirror/legacy-modes/mode/z80"),
};

/** Pull one named export out of a module thunk. */
const pick =
  <T, K extends keyof T>(mod: () => Promise<T>, key: K) =>
  () =>
    mod().then((m) => m[key]);

// Parsers that take options, or that several rows share.
const js = () => import("@codemirror/lang-javascript").then((m) => m.javascript());
const ts = () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true }));
const jsx = () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
const tsx = () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true }));
const json = () => import("@codemirror/lang-json").then((m) => m.json());
const markdown = () => import("@codemirror/lang-markdown").then((m) => m.markdown());
const html = () => import("@codemirror/lang-html").then((m) => m.html());
const php = () => import("@codemirror/lang-php").then((m) => m.php({ plain: true }));
const python = () => import("@codemirror/lang-python").then((m) => m.python());
const cMode = pick(M.clike, "c");
const cppMode = pick(M.clike, "cpp");
const javaMode = pick(M.clike, "java");
const shaderMode = pick(M.clike, "shader");
const rubyMode = pick(M.ruby, "ruby");
const perlMode = pick(M.perl, "perl");
const haskellMode = pick(M.haskell, "haskell");
const shellMode = pick(M.shell, "shell");
const xmlMode = pick(M.xml, "xml");
const propsMode = pick(M.properties, "properties");
const dockerMode = pick(M.dockerfile, "dockerFile");
const cmakeMode = pick(M.cmake, "cmake");
const jinjaMode = pick(M.jinja2, "jinja2");
const makefileMode = pick(M.ll, "makefile");

/** Optional per-language fields; everything here is space-separated. */
type Spec = {
  /** Extra picker search terms. */
  alias?: string;
  /** Exact lowercase basenames. */
  files?: string;
  /** Lowercase basename patterns, tested before filenames and extensions. */
  patterns?: RegExp[];
  /** Override the default glyph (`a.` + the first extension). */
  icon?: string;
};

const split = (s?: string) => (s ? s.split(/\s+/).filter(Boolean) : undefined);

/** One registry row. `exts` is a space-separated extension list. */
function lang(
  id: string,
  label: string,
  exts: string,
  load: LanguageLoader,
  spec: Spec = {},
): LanguageDef {
  const extensions = split(exts);
  return {
    id,
    label,
    aliases: split(spec.alias),
    extensions,
    filenames: split(spec.files),
    filenamePatterns: spec.patterns,
    icon: spec.icon ?? `a.${extensions?.[0] ?? ""}`,
    load,
  };
}

/**
 * The registry. Order is the picker's display order before its alphabetical
 * sort, so grouping by family aids maintenance - but it *is* the tie-breaker
 * for any extension claimed by more than one row.
 */
export const LANGUAGES: LanguageDef[] = [
  // JavaScript / TypeScript family
  lang("javascript", "JavaScript", "js mjs cjs es6 pac", js, { alias: "js node" }),
  lang("jsx", "JavaScript JSX", "jsx", jsx, { alias: "react" }),
  lang("typescript", "TypeScript", "ts mts cts", ts, { alias: "ts" }),
  lang("tsx", "TypeScript JSX", "tsx", tsx, { alias: "react tsx" }),
  lang(
    "json",
    "JSON",
    "json jsonc json5 jsonl ndjson geojson topojson jsonld webmanifest avsc har importmap code-workspace tsbuildinfo",
    json,
    {
      alias: "json5",
      files:
        ".babelrc .prettierrc .eslintrc .stylelintrc .jshintrc .swcrc .watchmanconfig tsconfig.json package-lock.json composer.lock deno.lock",
    },
  ),
  lang("markdown", "Markdown", "md markdown mdx mdc mdown mkd mkdn mdwn qmd ronn", markdown, {
    alias: "md mdx",
    files: "readme changelog contributing",
  }),

  // Web
  lang("html", "HTML", "html htm xhtml shtml hta", html, { alias: "htm" }),
  lang("css", "CSS", "css", () => import("@codemirror/lang-css").then((m) => m.css())),
  lang("scss", "SCSS", "scss", pick(M.css, "sCSS"), { alias: "sassy-css" }),
  lang("less", "Less", "less", pick(M.css, "less")),
  lang("sass", "Sass", "sass", pick(M.sass, "sass")),
  lang("stylus", "Stylus", "styl", pick(M.stylus, "stylus")),
  lang("vue", "Vue", "vue", html, { alias: "vuejs" }),
  lang("svelte", "Svelte", "svelte", html),
  lang("astro", "Astro", "astro", html),
  lang("blade", "Blade", "", php, {
    alias: "laravel",
    patterns: [/\.blade\.php$/],
    icon: "a.blade.php",
  }),
  lang("php", "PHP", "php phtml php3 php4 php5 php7 php8 phps ctp", php),

  // Systems
  lang("rust", "Rust", "rs", () => import("@codemirror/lang-rust").then((m) => m.rust()), {
    alias: "rs",
  }),
  lang("go", "Go", "go", () => import("@codemirror/lang-go").then((m) => m.go()), {
    alias: "golang",
    files: "go.mod go.sum go.work go.work.sum",
  }),
  lang("c", "C", "c h", cMode),
  lang("cpp", "C++", "cpp cc cxx c++ hpp hxx hh h++ ipp inl ino", cppMode, {
    alias: "cplusplus cxx",
  }),
  lang("cuda", "CUDA C++", "cu cuh", cppMode, { alias: "nvcc gpu" }),
  lang("csharp", "C#", "cs csx cake", pick(M.clike, "csharp"), { alias: "cs dotnet" }),
  lang("objective-c", "Objective-C", "m", pick(M.clike, "objectiveC"), { alias: "objc" }),
  lang("objective-cpp", "Objective-C++", "mm", pick(M.clike, "objectiveCpp"), { alias: "objcpp" }),
  lang("d", "D", "d", pick(M.d, "d")),
  lang("zig", "Zig", "zig zon", pick(M.sl, "zig")),
  lang("odin", "Odin", "odin", pick(M.sl, "odin")),
  lang("nim", "Nim", "nim nims nimble nimcfg", pick(M.sl, "nim")),
  lang("hare", "Hare", "ha", pick(M.sl, "hare")),
  lang("v", "V", "vsh vv", pick(M.sl, "vlang"), { alias: "vlang", icon: "a.v" }),
  lang("vala", "Vala", "vala vapi", pick(M.sl, "vala"), { alias: "gnome genie" }),
  lang("ada", "Ada", "adb ads ada gpr", pick(M.sl, "ada"), { alias: "gnat spark" }),
  lang("squirrel", "Squirrel", "nut", pick(M.clike, "squirrel")),
  lang("nesc", "nesC", "nc", pick(M.clike, "nesC"), { alias: "tinyos" }),

  // JVM
  lang("java", "Java", "java jsh", javaMode),
  lang("apex", "Apex", "apex trigger", javaMode, { alias: "salesforce", icon: "a.cls" }),
  lang("processing", "Processing", "pde", javaMode, { alias: "pde" }),
  lang("kotlin", "Kotlin", "kt kts ktm", pick(M.clike, "kotlin"), { alias: "kt" }),
  lang("scala", "Scala", "scala sc sbt", pick(M.clike, "scala")),
  lang("groovy", "Groovy", "groovy gradle gvy gy", pick(M.groovy, "groovy"), {
    alias: "gradle jenkins",
    files: "jenkinsfile",
    patterns: [/^jenkinsfile(\.[^.\\/]+)+$/],
  }),
  lang("clojure", "Clojure", "clj cljs cljc cljd cljr edn bb boot", pick(M.clojure, "clojure"), {
    alias: "babashka",
  }),
  lang("ceylon", "Ceylon", "ceylon", pick(M.clike, "ceylon")),

  // Apple / mobile
  lang("swift", "Swift", "swift", pick(M.swift, "swift")),
  lang("dart", "Dart", "dart", pick(M.clike, "dart"), { alias: "flutter" }),

  // Scripting
  lang("python", "Python", "py pyw pyi pyt rpy gyp gypi", python, {
    alias: "py",
    files: "sconstruct sconscript wscript",
  }),
  lang("cython", "Cython", "pyx pxd pxi", pick(M.python, "cython"), { alias: "pyrex" }),
  lang("mojo", "Mojo", "mojo 🔥", pick(M.sl, "mojo"), { alias: "modular max" }),
  lang("starlark", "Starlark / Bazel", "bzl star bazel", pick(M.sl, "starlark"), {
    alias: "bazel buck skylark",
    files: "build build.bazel workspace workspace.bazel module.bazel",
    icon: "BUILD.bazel",
  }),
  lang("ruby", "Ruby", "rb rbw rake gemspec ru builder jbuilder arb", rubyMode, {
    alias: "rb",
    files:
      "gemfile rakefile podfile vagrantfile brewfile guardfile capfile thorfile berksfile fastfile appfile matchfile deliverfile .irbrc .pryrc",
  }),
  lang("elixir", "Elixir", "ex exs eex heex leex sface", pick(M.sl, "elixir"), {
    alias: "ex phoenix beam",
    files: "mix.exs",
  }),
  lang("perl", "Perl", "pl pm t pod psgi ph", perlMode),
  lang("raku", "Raku", "raku rakumod rakutest rakudoc p6 pm6 pl6", perlMode, { alias: "perl6" }),
  lang("lua", "Lua", "lua rockspec wlua nse", pick(M.lua, "lua")),
  lang("r", "R", "r rmd rd rsx", pick(M.r, "r"), { files: ".rprofile renviron" }),
  lang("julia", "Julia", "jl", pick(M.julia, "julia")),
  lang("octave", "MATLAB / Octave", "octave matlab", pick(M.octave, "octave"), {
    alias: "matlab m mathworks",
    icon: "a.m",
  }),
  lang("awk", "AWK", "awk gawk mawk", pick(M.sl, "awk"), { alias: "gawk mawk nawk" }),
  lang("coffeescript", "CoffeeScript", "coffee iced cson", pick(M.coffeescript, "coffeeScript")),
  lang("livescript", "LiveScript", "ls", pick(M.livescript, "liveScript")),
  lang("tcl", "Tcl", "tcl tk itcl exp", pick(M.tcl, "tcl"), { alias: "tk" }),

  // Functional
  lang("haskell", "Haskell", "hs lhs hs-boot", haskellMode),
  lang("purescript", "PureScript", "purs", haskellMode, { alias: "purs" }),
  lang("idris", "Idris", "idr lidr", haskellMode),
  lang("agda", "Agda", "agda lagda", haskellMode),
  lang("lean", "Lean 4", "lean hlean", pick(M.sl, "lean"), { alias: "mathlib theorem proof" }),
  lang("ocaml", "OCaml", "ml mli mll mly eliom", pick(M.mllike, "oCaml")),
  lang("fsharp", "F#", "fs fsx fsi fsscript", pick(M.mllike, "fSharp"), { icon: "a.fsx" }),
  lang("sml", "Standard ML", "sml", pick(M.mllike, "sml"), { alias: "smlnj mlton" }),
  lang("rescript", "ReScript", "res resi", pick(M.sl, "rescript"), {
    alias: "reason bucklescript",
  }),
  lang("elm", "Elm", "elm", pick(M.elm, "elm")),
  lang("erlang", "Erlang", "erl hrl escript", pick(M.erlang, "erlang"), { files: "rebar.config" }),
  lang("crystal", "Crystal", "cr ecr", pick(M.crystal, "crystal")),
  lang("gleam", "Gleam", "gleam", pick(M.sl, "gleam")),
  lang("haxe", "Haxe", "hx hxml", pick(M.haxe, "haxe")),
  lang("smalltalk", "Smalltalk", "st", pick(M.smalltalk, "smalltalk")),
  lang("commonlisp", "Common Lisp", "lisp cl el lsp asd", pick(M.commonlisp, "commonLisp"), {
    alias: "lisp elisp emacs",
  }),
  lang("scheme", "Scheme", "scm ss rkt sld sps sls", pick(M.scheme, "scheme"), {
    alias: "racket guile chez",
  }),
  lang("prolog", "Prolog", "prolog pro plg", pick(M.ll, "prolog"), {
    alias: "swipl datalog",
    icon: "a.pro",
  }),
  lang("oz", "Oz", "oz", pick(M.oz, "oz"), { alias: "mozart" }),
  lang("factor", "Factor", "factor", pick(M.factor, "factor"), { alias: "concatenative" }),
  lang("forth", "Forth", "fth 4th forth frt", pick(M.forth, "forth")),
  lang("apl", "APL", "apl dyalog aplf", pick(M.apl, "apl"), { alias: "dyalog" }),
  lang("q", "Q / kdb+", "q k", pick(M.q, "q"), { alias: "kdb kx" }),
  lang("dylan", "Dylan", "dylan dyl intr", pick(M.dylan, "dylan")),
  lang("eiffel", "Eiffel", "e", pick(M.eiffel, "eiffel")),

  // Legacy / enterprise
  lang("pascal", "Pascal", "pas pp lpr dpr dpk", pick(M.pascal, "pascal"), {
    alias: "delphi freepascal lazarus",
  }),
  lang("vb", "Visual Basic", "vb bas frm", pick(M.vb, "vb"), { alias: "vbnet vba" }),
  lang("vbscript", "VBScript", "vbs", pick(M.vbscript, "vbScript")),
  lang("fortran", "Fortran", "f f77 f90 f95 f03 f08 for ftn fpp", pick(M.fortran, "fortran"), {
    icon: "a.f90",
  }),
  lang("cobol", "COBOL", "cob cbl cpy cobol ccp", pick(M.cobol, "cobol")),
  lang("sas", "SAS", "sas", pick(M.sas, "sas")),
  lang("mathematica", "Mathematica", "wl wls nb cdf", pick(M.mathematica, "mathematica"), {
    alias: "wolfram wls",
    icon: "a.nb",
  }),
  lang("modelica", "Modelica", "mo", pick(M.modelica, "modelica")),
  lang("yacas", "Yacas", "ys", pick(M.yacas, "yacas")),
  lang("pig", "Pig Latin", "pig", pick(M.pig, "pig"), { alias: "hadoop" }),
  lang("ecl", "ECL", "ecl", pick(M.ecl, "ecl"), { alias: "hpcc" }),

  // Smart contracts
  lang("solidity", "Solidity", "sol", pick(M.sl, "solidity"), { alias: "sol ethereum evm" }),
  lang("vyper", "Vyper", "vy", pick(M.sl, "vyper"), { alias: "ethereum evm" }),
  lang("move", "Move", "move", pick(M.sl, "move"), { alias: "sui aptos" }),
  lang("cairo", "Cairo", "cairo", pick(M.sl, "cairo"), { alias: "starknet starkware" }),

  // Shell / config
  lang("shell", "Shell Script", "sh bash zsh fish ksh ash command bats ebuild eclass", shellMode, {
    alias: "bash sh zsh fish",
    files:
      ".bashrc .bash_profile .bash_logout .bash_aliases .zshrc .zshenv .profile .zprofile .envrc .xinitrc .xprofile pkgbuild",
  }),
  lang("powershell", "PowerShell", "ps1 psm1 psd1 ps1xml", pick(M.powershell, "powerShell"), {
    alias: "pwsh ps",
  }),
  lang("batch", "Batch", "bat cmd btm", pick(M.ll, "batch"), { alias: "bat cmd dos windows" }),
  lang("nushell", "Nushell", "nu", pick(M.sl, "nushell"), {
    alias: "nu",
    files: "config.nu env.nu",
  }),
  lang("vim", "Vim Script", "vim vimrc", pick(M.ll, "vim"), {
    alias: "vimscript vim9 neovim",
    files: ".vimrc .gvimrc .exrc init.vim",
  }),
  lang("makefile", "Makefile", "mk mak make", makefileMode, {
    alias: "make gnumake",
    files: "makefile gnumakefile bsdmakefile makefile.am makefile.in",
    icon: "Makefile",
  }),
  lang("just", "Justfile", "just", makefileMode, {
    alias: "just casey",
    files: "justfile .justfile",
    icon: "justfile",
  }),
  lang("dockerfile", "Dockerfile", "dockerfile", dockerMode, {
    alias: "docker container containerfile oci",
    files: "dockerfile containerfile",
    patterns: [/^(dockerfile|containerfile)(\.[^.\\/]+)+$/],
    icon: "Dockerfile",
  }),
  lang("yaml", "YAML", "yaml yml", pick(M.yaml, "yaml"), {
    alias: "yml ansible helm k8s kubernetes",
    files: ".clang-format .clang-tidy .yamllint",
    icon: "a.yml",
  }),
  lang("toml", "TOML", "toml", pick(M.toml, "toml"), {
    files: "cargo.lock gleam.toml pipfile poetry.lock uv.lock",
  }),
  lang(
    "ini",
    "INI / Properties",
    "ini conf cfg properties env editorconfig desktop service timer socket nmconnection prefs",
    propsMode,
    {
      alias: "conf cfg properties env dotenv systemd",
      files:
        ".env .npmrc .editorconfig .gitconfig .gitmodules .hgrc .flake8 .pylintrc .coveragerc .inputrc .wslconfig",
      patterns: [/^\.env(\.[^.\\/]+)+$/],
    },
  ),
  lang("nix", "Nix", "nix", pick(M.sl, "nix"), { alias: "nixos flake nixpkgs" }),
  lang("nginx", "Nginx", "nginx", pick(M.nginx, "nginx"), {
    files: "nginx.conf mime.types",
    icon: "nginx.conf",
  }),
  lang("apacheconf", "Apache Config", "htaccess", pick(M.ll, "apacheconf"), {
    alias: "htaccess httpd apache",
    files: ".htaccess .htpasswd httpd.conf apache2.conf vhost.conf",
    icon: ".htaccess",
  }),
  lang("cmake", "CMake", "cmake", cmakeMode, {
    files: "cmakelists.txt",
    patterns: [/\.cmake\.in$/],
  }),
  lang("terraform", "Terraform / HCL", "tf tfvars hcl nomad", pick(M.sl, "terraform"), {
    alias: "hcl tf opentofu packer nomad",
  }),
  lang("bicep", "Bicep", "bicep bicepparam", pick(M.sl, "bicep"), { alias: "azure arm" }),
  lang("puppet", "Puppet", "puppet epp", pick(M.puppet, "puppet"), {
    alias: "pp manifest",
    icon: "a.pp",
  }),
  lang("jinja2", "Jinja2", "j2 jinja jinja2 njk", jinjaMode, {
    alias: "jinja nunjucks ansible salt",
  }),
  lang("jsonnet", "Jsonnet", "jsonnet libsonnet", pick(M.sl, "jsonnet"), {
    alias: "tanka grafana",
  }),
  lang("cue", "CUE", "cue", pick(M.sl, "cuelang"), { alias: "cuelang" }),
  lang("pkl", "Pkl", "pkl", pick(M.sl, "pkl"), { alias: "apple pickle" }),
  lang("prisma", "Prisma", "prisma", pick(M.sl, "prisma"), { icon: "schema.prisma" }),
  lang("graphql", "GraphQL", "graphql graphqls gql", pick(M.sl, "graphql"), { alias: "gql" }),
  lang("protobuf", "Protocol Buffers", "proto", pick(M.protobuf, "protobuf"), {
    alias: "proto grpc",
  }),
  lang("http", "HTTP", "http rest", pick(M.http, "http"), { alias: "rest curl httpie" }),

  // Data / markup
  lang(
    "xml",
    "XML",
    "xml xsl xslt xsd svg plist rss atom wsdl xaml resx csproj vbproj fsproj props targets nuspec storyboard xib mxml iml opml gpx kml qrc",
    xmlMode,
  ),
  lang("dtd", "DTD", "dtd ent", pick(M.dtd, "dtd")),
  lang("webidl", "Web IDL", "webidl widl", pick(M.webidl, "webIDL"), { alias: "idl interface" }),
  lang("asn1", "ASN.1", "asn asn1", pick(M.sl, "asn1"), { icon: "a.asn1" }),
  lang("ebnf", "EBNF", "ebnf bnf", pick(M.ebnf, "ebnf"), { alias: "grammar bnf" }),
  lang("pegjs", "PEG.js", "pegjs peggy peg", pick(M.pegjs, "pegjs"), {
    alias: "peggy parser grammar",
  }),
  lang("sql", "SQL", "sql ddl dml", pick(M.sql, "standardSQL")),
  lang("mysql", "MySQL", "mysql", pick(M.sql, "mySQL"), { alias: "mariadb", icon: "a.sql" }),
  lang("pgsql", "PostgreSQL", "pgsql psql", pick(M.sql, "pgSQL"), {
    alias: "postgres psql plpgsql",
    icon: "a.sql",
  }),
  lang("sqlite", "SQLite", "sqlite", pick(M.sql, "sqlite"), { icon: "a.sql" }),
  lang("mssql", "T-SQL / SQL Server", "mssql tsql", pick(M.sql, "msSQL"), {
    alias: "tsql sqlserver mssql",
    icon: "a.sql",
  }),
  lang("plsql", "PL/SQL", "pls plsql pks pkb", pick(M.sql, "plSQL"), {
    alias: "oracle",
    icon: "a.sql",
  }),
  lang("hive", "HiveQL", "hql", pick(M.sql, "hive"), { alias: "hadoop hql", icon: "a.sql" }),
  lang("diff", "Diff / Patch", "diff patch rej orig", pick(M.diff, "diff")),
  lang("asciiarmor", "PGP / ASCII Armor", "asc pgp sig gpg", pick(M.asciiarmor, "asciiArmor"), {
    alias: "gpg pgp signature",
  }),
  lang("mbox", "Mbox", "mbox eml", pick(M.mbox, "mbox"), { alias: "email mail" }),
  lang("ntriples", "N-Triples / N-Quads", "nt nq", pick(M.ntriples, "ntriples"), {
    alias: "rdf linkeddata",
  }),

  // Hardware description
  lang("verilog", "Verilog", "v sv svh vh", pick(M.verilog, "verilog"), { alias: "systemverilog" }),
  lang("tlverilog", "TL-Verilog", "tlv", pick(M.verilog, "tlv"), { alias: "tlv redwood" }),
  lang("vhdl", "VHDL", "vhd vhdl", pick(M.vhdl, "vhdl")),
  lang("ttcn", "TTCN-3", "ttcn ttcn3 ttcnpp", pick(M.ttcn, "ttcn"), {
    alias: "testing conformance",
  }),
  lang("fcl", "Fuzzy Control Language", "fcl", pick(M.fcl, "fcl"), { alias: "fuzzy iec" }),

  // GPU / shaders
  lang(
    "glsl",
    "GLSL / HLSL Shader",
    "glsl vert frag geom tesc tese comp hlsl hlsli fx fxh cginc shader metal usf ush",
    shaderMode,
    { alias: "shader hlsl metal opengl directx unity" },
  ),
  lang("wgsl", "WGSL", "wgsl", pick(M.sl, "wgsl"), { alias: "webgpu shader" }),

  // Templating
  lang("pug", "Pug", "pug jade", pick(M.pug, "pug"), { alias: "jade" }),
  lang("erb", "ERB", "erb rhtml", html, { alias: "rhtml rails" }),
  lang("ejs", "EJS", "ejs", html),
  lang("handlebars", "Handlebars", "hbs handlebars mustache", html, {
    alias: "hbs mustache ember",
  }),
  lang("twig", "Twig", "twig", html, { alias: "symfony" }),
  lang("liquid", "Liquid", "liquid", html, { alias: "shopify jekyll" }),
  lang("razor", "Razor", "cshtml razor vbhtml", html, { alias: "cshtml blazor aspnet" }),
  lang("smarty", "Smarty", "tpl", html, { alias: "tpl" }),
  lang("velocity", "Velocity", "vm vtl", pick(M.velocity, "velocity"), { alias: "vtl apache" }),

  // UI markup
  lang("slint", "Slint", "slint", pick(M.sl, "slint"), { alias: "ui toolkit" }),

  // Assembly / low level
  lang("asm", "Assembly", "s asm nasm", pick(M.gas, "gas"), {
    alias: "gas nasm x86",
    icon: "a.asm",
  }),
  lang("z80", "Z80 Assembly", "z80", pick(M.z80, "z80"), { alias: "retro gameboy" }),
  lang("wast", "WebAssembly Text", "wat wast", pick(M.wast, "wast"), { alias: "wasm" }),
  lang("brainfuck", "Brainfuck", "bf", pick(M.brainfuck, "brainfuck"), { alias: "esolang bf" }),

  // Misc / niche
  lang("nsis", "NSIS", "nsi nsh", pick(M.nsis, "nsis")),
  lang("rpmspec", "RPM Spec", "spec", pick(M.rpm, "rpmSpec"), { alias: "rpm fedora redhat" }),
  lang("gherkin", "Gherkin", "feature story", pick(M.gherkin, "gherkin"), {
    alias: "cucumber bdd",
  }),
  lang("latex", "LaTeX", "tex sty cls ltx bib dtx ins bbx cbx", pick(M.stex, "stex"), {
    alias: "tex bibtex",
  }),
  lang("troff", "Troff / man", "roff troff nroff man", pick(M.troff, "troff"), {
    alias: "nroff groff manpage",
  }),
  lang("textile", "Textile", "textile", pick(M.textile, "textile")),
  lang("tiddlywiki", "TiddlyWiki", "tid", pick(M.tiddlywiki, "tiddlyWiki")),
  lang("mscgen", "MscGen", "msc mscgen", pick(M.mscgen, "mscgen"), { alias: "sequence diagram" }),
  lang("sieve", "Sieve", "sieve", pick(M.sieve, "sieve"), { alias: "mailfilter" }),
  lang("mirc", "mIRC Script", "mrc", pick(M.mirc, "mirc")),
  lang("cypher", "Cypher", "cypher cql cyp", pick(M.cypher, "cypher"), { alias: "neo4j" }),
  lang("turtle", "Turtle / RDF", "ttl", pick(M.turtle, "turtle"), { alias: "rdf" }),
  lang("sparql", "SPARQL", "rq sparql", pick(M.sparql, "sparql")),
  lang("xquery", "XQuery", "xq xqy xquery xqm", pick(M.xquery, "xQuery")),
];

// ── Lookup indexes (built once at module load) ───────────────────────────────

const byId = new Map<string, LanguageDef>();
const byExtension = new Map<string, LanguageDef>();
const byFilename = new Map<string, LanguageDef>();
const withPatterns: LanguageDef[] = [];

for (const def of LANGUAGES) {
  byId.set(def.id, def);
  for (const ext of def.extensions ?? []) {
    // First definition wins so the family ordering above is authoritative.
    if (!byExtension.has(ext)) byExtension.set(ext, def);
  }
  for (const name of def.filenames ?? []) {
    if (!byFilename.has(name)) byFilename.set(name, def);
  }
  if (def.filenamePatterns?.length) withPatterns.push(def);
}

function basename(filename: string): string {
  const lower = filename.toLowerCase();
  return lower.split(/[\\/]/).pop() ?? lower;
}

function extOf(base: string): string | null {
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1);
}

/**
 * Resolve a path/filename to a language id using the same precedence the file
 * tree implies: filename patterns → exact basename → extension. Returns `null`
 * when nothing matches (the editor then shows plain text).
 */
export function detectLanguageId(filename: string): string | null {
  const base = basename(filename);
  for (const def of withPatterns) {
    if (def.filenamePatterns!.some((re) => re.test(base))) return def.id;
  }
  const byName = byFilename.get(base);
  if (byName) return byName.id;
  const ext = extOf(base);
  if (ext) {
    const byExt = byExtension.get(ext);
    if (byExt) return byExt.id;
  }
  return null;
}

function isStreamParser(v: unknown): v is StreamParser<unknown> {
  return (
    typeof v === "object" && v !== null && typeof (v as { token?: unknown }).token === "function"
  );
}

/** Load a language's CodeMirror extension, wrapping stream parsers. */
export async function loadLanguageExtension(def: LanguageDef): Promise<Extension> {
  const result = await def.load();
  if (isStreamParser(result)) return StreamLanguage.define(result);
  return result;
}

/** Resolve a language id (manual override) to a CodeMirror extension. */
export async function resolveLanguageById(id: string): Promise<Extension | null> {
  const def = byId.get(id);
  if (!def) return null;
  return loadLanguageExtension(def);
}

/** Display label for a language id, falling back to the id itself. */
export function languageLabel(id: string): string {
  return byId.get(id)?.label ?? id;
}

/** Representative filename for `fileIconUrl`, so the picker matches the tree. */
export function languageIconFile(id: string): string {
  return byId.get(id)?.icon ?? "";
}
