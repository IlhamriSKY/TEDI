/**
 * Central language registry - the single source of truth for editor syntax
 * highlighting.
 *
 * Each {@link LanguageDef} carries everything three surfaces need:
 *  - detection: `extensions`, `filenames`, and `filenamePatterns` map a path to
 *    a language id (used by `resolveLanguage` and the diff panes);
 *  - the manual override picker: `label` + `aliases` drive fuzzy search and
 *    `icon` (a representative filename) is fed through the explorer's
 *    `fileIconUrl` so the picker shows the *exact* glyph the file tree does;
 *  - lazy loading: `load` dynamic-imports the CodeMirror parser so a language
 *    pack only enters the bundle when a matching file is opened or picked.
 *
 * Loaders return either an `Extension` (`@codemirror/lang-*` packages) or a raw
 * `StreamParser` (`@codemirror/legacy-modes` + the hand-rolled
 * `./streamLanguages`); `loadLanguageExtension` wraps the latter in
 * `StreamLanguage`.
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

// Shared loaders for families so the entries below stay terse and the same
// dynamic import is reused (one chunk) across related extensions.
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
const cMode = () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c);
const cppMode = () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp);
const rubyMode = () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby);
const shellMode = () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell);
const xmlMode = () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml);
const propsMode = () =>
  import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties);
const goMode = () => import("@codemirror/legacy-modes/mode/go").then((m) => m.go);
const dockerMode = () =>
  import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile);
const cmakeMode = () => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake);

/**
 * The registry. Order here is the picker's display order before its
 * alphabetical sort, so grouping by family only aids maintenance, not the UI.
 */
export const LANGUAGES: LanguageDef[] = [
  // ── JavaScript / TypeScript family ─────────────────────────────────────────
  {
    id: "javascript",
    label: "JavaScript",
    aliases: ["js", "node"],
    extensions: ["js", "mjs", "cjs"],
    icon: "a.js",
    load: js,
  },
  {
    id: "jsx",
    label: "JavaScript JSX",
    aliases: ["react"],
    extensions: ["jsx"],
    icon: "a.jsx",
    load: jsx,
  },
  {
    id: "typescript",
    label: "TypeScript",
    aliases: ["ts"],
    extensions: ["ts", "mts", "cts"],
    icon: "a.ts",
    load: ts,
  },
  {
    id: "tsx",
    label: "TypeScript JSX",
    aliases: ["react", "tsx"],
    extensions: ["tsx"],
    icon: "a.tsx",
    load: tsx,
  },
  {
    id: "json",
    label: "JSON",
    aliases: ["json5"],
    extensions: ["json", "jsonc", "json5", "jsonl", "geojson", "webmanifest"],
    filenames: [".babelrc", ".prettierrc", ".eslintrc", "tsconfig.json"],
    icon: "a.json",
    load: json,
  },
  {
    id: "markdown",
    label: "Markdown",
    aliases: ["md", "mdx"],
    extensions: ["md", "markdown", "mdx", "mdown", "mkd"],
    icon: "a.md",
    load: markdown,
  },

  // ── Web ────────────────────────────────────────────────────────────────────
  {
    id: "html",
    label: "HTML",
    aliases: ["htm"],
    extensions: ["html", "htm", "xhtml"],
    icon: "a.html",
    load: html,
  },
  {
    id: "css",
    label: "CSS",
    extensions: ["css"],
    icon: "a.css",
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  },
  {
    id: "scss",
    label: "SCSS",
    aliases: ["sass"],
    extensions: ["scss"],
    icon: "a.scss",
    load: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.sCSS),
  },
  {
    id: "less",
    label: "Less",
    extensions: ["less"],
    icon: "a.less",
    load: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.less),
  },
  {
    id: "sass",
    label: "Sass",
    extensions: ["sass"],
    icon: "a.sass",
    load: () => import("@codemirror/legacy-modes/mode/sass").then((m) => m.sass),
  },
  {
    id: "stylus",
    label: "Stylus",
    extensions: ["styl"],
    icon: "a.styl",
    load: () => import("@codemirror/legacy-modes/mode/stylus").then((m) => m.stylus),
  },
  { id: "vue", label: "Vue", aliases: ["vuejs"], extensions: ["vue"], icon: "a.vue", load: html },
  { id: "svelte", label: "Svelte", extensions: ["svelte"], icon: "a.svelte", load: html },
  { id: "astro", label: "Astro", extensions: ["astro"], icon: "a.astro", load: html },
  {
    id: "php",
    label: "PHP",
    extensions: ["php", "phtml", "php3", "php4", "php5"],
    icon: "a.php",
    load: php,
  },

  // ── Systems ────────────────────────────────────────────────────────────────
  {
    id: "rust",
    label: "Rust",
    aliases: ["rs"],
    extensions: ["rs"],
    icon: "a.rs",
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  },
  {
    id: "go",
    label: "Go",
    aliases: ["golang"],
    extensions: ["go"],
    filenames: ["go.mod", "go.sum"],
    icon: "a.go",
    load: goMode,
  },
  { id: "c", label: "C", extensions: ["c", "h"], icon: "a.c", load: cMode },
  {
    id: "cpp",
    label: "C++",
    aliases: ["cplusplus", "cxx"],
    extensions: ["cpp", "cc", "cxx", "hpp", "hxx", "hh", "ino"],
    icon: "a.cpp",
    load: cppMode,
  },
  {
    id: "csharp",
    label: "C#",
    aliases: ["cs", "dotnet"],
    extensions: ["cs", "csx"],
    icon: "a.cs",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),
  },
  {
    id: "objective-c",
    label: "Objective-C",
    aliases: ["objc"],
    extensions: ["m"],
    icon: "a.m",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC),
  },
  {
    id: "objective-cpp",
    label: "Objective-C++",
    aliases: ["objcpp"],
    extensions: ["mm"],
    icon: "a.mm",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveCpp),
  },
  {
    id: "d",
    label: "D",
    extensions: ["d"],
    icon: "a.d",
    load: () => import("@codemirror/legacy-modes/mode/d").then((m) => m.d),
  },
  {
    id: "zig",
    label: "Zig",
    extensions: ["zig"],
    icon: "a.zig",
    load: () => import("./streamLanguages").then((m) => m.zig),
  },
  {
    id: "odin",
    label: "Odin",
    extensions: ["odin"],
    icon: "a.odin",
    load: () => import("./streamLanguages").then((m) => m.odin),
  },
  {
    id: "nim",
    label: "Nim",
    extensions: ["nim", "nims", "nimble"],
    icon: "a.nim",
    load: () => import("./streamLanguages").then((m) => m.nim),
  },
  {
    id: "hare",
    label: "Hare",
    extensions: ["ha"],
    icon: "a.ha",
    load: () => import("./streamLanguages").then((m) => m.hare),
  },

  // ── JVM ────────────────────────────────────────────────────────────────────
  {
    id: "java",
    label: "Java",
    extensions: ["java"],
    icon: "a.java",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java),
  },
  {
    id: "kotlin",
    label: "Kotlin",
    aliases: ["kt"],
    extensions: ["kt", "kts"],
    icon: "a.kt",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  },
  {
    id: "scala",
    label: "Scala",
    extensions: ["scala", "sc"],
    icon: "a.scala",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
  },
  {
    id: "groovy",
    label: "Groovy",
    aliases: ["gradle"],
    extensions: ["groovy", "gradle"],
    icon: "a.groovy",
    load: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy),
  },
  {
    id: "clojure",
    label: "Clojure",
    extensions: ["clj", "cljs", "cljc", "edn"],
    icon: "a.clj",
    load: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  },

  // ── Apple / mobile ─────────────────────────────────────────────────────────
  {
    id: "swift",
    label: "Swift",
    extensions: ["swift"],
    icon: "a.swift",
    load: () => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),
  },
  {
    id: "dart",
    label: "Dart",
    aliases: ["flutter"],
    extensions: ["dart"],
    icon: "a.dart",
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart),
  },

  // ── Scripting ──────────────────────────────────────────────────────────────
  {
    id: "python",
    label: "Python",
    aliases: ["py"],
    extensions: ["py", "pyw", "pyi"],
    icon: "a.py",
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  },
  {
    id: "ruby",
    label: "Ruby",
    aliases: ["rb"],
    extensions: ["rb", "rake", "gemspec"],
    filenames: ["gemfile", "rakefile", "podfile", "vagrantfile"],
    icon: "a.rb",
    load: rubyMode,
  },
  {
    id: "perl",
    label: "Perl",
    extensions: ["pl", "pm", "t", "pod"],
    icon: "a.pl",
    load: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  },
  {
    id: "lua",
    label: "Lua",
    extensions: ["lua"],
    icon: "a.lua",
    load: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),
  },
  {
    id: "r",
    label: "R",
    extensions: ["r", "rmd"],
    icon: "a.r",
    load: () => import("@codemirror/legacy-modes/mode/r").then((m) => m.r),
  },
  {
    id: "julia",
    label: "Julia",
    extensions: ["jl"],
    icon: "a.jl",
    load: () => import("@codemirror/legacy-modes/mode/julia").then((m) => m.julia),
  },
  {
    id: "coffeescript",
    label: "CoffeeScript",
    extensions: ["coffee"],
    icon: "a.coffee",
    load: () => import("@codemirror/legacy-modes/mode/coffeescript").then((m) => m.coffeeScript),
  },
  {
    id: "livescript",
    label: "LiveScript",
    extensions: ["ls"],
    icon: "a.ls",
    load: () => import("@codemirror/legacy-modes/mode/livescript").then((m) => m.liveScript),
  },
  {
    id: "tcl",
    label: "Tcl",
    extensions: ["tcl"],
    icon: "a.tcl",
    load: () => import("@codemirror/legacy-modes/mode/tcl").then((m) => m.tcl),
  },

  // ── Functional ─────────────────────────────────────────────────────────────
  {
    id: "haskell",
    label: "Haskell",
    extensions: ["hs", "lhs"],
    icon: "a.hs",
    load: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell),
  },
  {
    id: "ocaml",
    label: "OCaml",
    extensions: ["ml", "mli"],
    icon: "a.ml",
    load: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml),
  },
  {
    id: "fsharp",
    label: "F#",
    extensions: ["fs", "fsx", "fsi"],
    icon: "a.fsx",
    load: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp),
  },
  {
    id: "elm",
    label: "Elm",
    extensions: ["elm"],
    icon: "a.elm",
    load: () => import("@codemirror/legacy-modes/mode/elm").then((m) => m.elm),
  },
  {
    id: "erlang",
    label: "Erlang",
    extensions: ["erl", "hrl"],
    icon: "a.erl",
    load: () => import("@codemirror/legacy-modes/mode/erlang").then((m) => m.erlang),
  },
  {
    id: "crystal",
    label: "Crystal",
    extensions: ["cr"],
    icon: "a.cr",
    load: () => import("@codemirror/legacy-modes/mode/crystal").then((m) => m.crystal),
  },
  {
    id: "gleam",
    label: "Gleam",
    extensions: ["gleam"],
    icon: "a.gleam",
    load: () => import("./streamLanguages").then((m) => m.gleam),
  },
  {
    id: "haxe",
    label: "Haxe",
    extensions: ["hx", "hxml"],
    icon: "a.hx",
    load: () => import("@codemirror/legacy-modes/mode/haxe").then((m) => m.haxe),
  },
  {
    id: "smalltalk",
    label: "Smalltalk",
    extensions: ["st"],
    icon: "a.st",
    load: () => import("@codemirror/legacy-modes/mode/smalltalk").then((m) => m.smalltalk),
  },
  {
    id: "commonlisp",
    label: "Common Lisp",
    aliases: ["lisp"],
    extensions: ["lisp", "cl", "el"],
    icon: "a.lisp",
    load: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
  },
  {
    id: "scheme",
    label: "Scheme",
    aliases: ["racket"],
    extensions: ["scm", "ss", "rkt"],
    icon: "a.scm",
    load: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme),
  },

  // ── Legacy / enterprise ────────────────────────────────────────────────────
  {
    id: "pascal",
    label: "Pascal",
    extensions: ["pas", "pp"],
    icon: "a.pas",
    load: () => import("@codemirror/legacy-modes/mode/pascal").then((m) => m.pascal),
  },
  {
    id: "vb",
    label: "Visual Basic",
    extensions: ["vb"],
    icon: "a.vb",
    load: () => import("@codemirror/legacy-modes/mode/vb").then((m) => m.vb),
  },
  {
    id: "vbscript",
    label: "VBScript",
    extensions: ["vbs"],
    icon: "a.vbs",
    load: () => import("@codemirror/legacy-modes/mode/vbscript").then((m) => m.vbScript),
  },
  {
    id: "fortran",
    label: "Fortran",
    extensions: ["f", "f90", "f95", "f03", "for"],
    icon: "a.f90",
    load: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran),
  },
  {
    id: "cobol",
    label: "COBOL",
    extensions: ["cob", "cbl", "cpy"],
    icon: "a.cob",
    load: () => import("@codemirror/legacy-modes/mode/cobol").then((m) => m.cobol),
  },

  // ── Smart contracts ────────────────────────────────────────────────────────
  {
    id: "solidity",
    label: "Solidity",
    aliases: ["sol", "ethereum"],
    extensions: ["sol"],
    icon: "a.sol",
    load: () => import("./streamLanguages").then((m) => m.solidity),
  },

  // ── Shell / config ─────────────────────────────────────────────────────────
  {
    id: "shell",
    label: "Shell Script",
    aliases: ["bash", "sh", "zsh", "fish"],
    extensions: ["sh", "bash", "zsh", "fish", "ksh", "ash"],
    filenames: [".bashrc", ".bash_profile", ".zshrc", ".zshenv", ".profile", ".zprofile"],
    icon: "a.sh",
    load: shellMode,
  },
  {
    id: "powershell",
    label: "PowerShell",
    aliases: ["pwsh", "ps"],
    extensions: ["ps1", "psm1", "psd1"],
    icon: "a.ps1",
    load: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  },
  {
    id: "dockerfile",
    label: "Dockerfile",
    aliases: ["docker", "container", "containerfile", "oci"],
    extensions: ["dockerfile"],
    filenames: ["dockerfile", "containerfile"],
    filenamePatterns: [/^(dockerfile|containerfile)(\.[^.\\/]+)+$/],
    icon: "Dockerfile",
    load: dockerMode,
  },
  {
    id: "yaml",
    label: "YAML",
    aliases: ["yml"],
    extensions: ["yaml", "yml"],
    icon: "a.yml",
    load: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  },
  {
    id: "toml",
    label: "TOML",
    extensions: ["toml"],
    filenames: ["cargo.lock", "gleam.toml"],
    icon: "a.toml",
    load: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  },
  {
    id: "ini",
    label: "INI / Properties",
    aliases: ["conf", "cfg", "properties", "env", "dotenv"],
    extensions: ["ini", "conf", "cfg", "properties", "env", "editorconfig"],
    filenames: [".env", ".npmrc", ".editorconfig"],
    filenamePatterns: [/^\.env(\.[^.\\/]+)+$/],
    icon: "a.ini",
    load: propsMode,
  },
  {
    id: "nginx",
    label: "Nginx",
    extensions: ["nginx"],
    filenames: ["nginx.conf"],
    icon: "nginx.conf",
    load: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx),
  },
  {
    id: "cmake",
    label: "CMake",
    extensions: ["cmake"],
    filenames: ["cmakelists.txt"],
    icon: "a.cmake",
    load: cmakeMode,
  },
  {
    id: "terraform",
    label: "Terraform / HCL",
    aliases: ["hcl", "tf"],
    extensions: ["tf", "tfvars", "hcl"],
    icon: "a.tf",
    load: () => import("./streamLanguages").then((m) => m.terraform),
  },
  {
    id: "prisma",
    label: "Prisma",
    extensions: ["prisma"],
    icon: "schema.prisma",
    load: () => import("./streamLanguages").then((m) => m.prisma),
  },
  {
    id: "graphql",
    label: "GraphQL",
    aliases: ["gql"],
    extensions: ["graphql", "gql"],
    icon: "a.graphql",
    load: () => import("./streamLanguages").then((m) => m.graphql),
  },
  {
    id: "protobuf",
    label: "Protocol Buffers",
    aliases: ["proto", "grpc"],
    extensions: ["proto"],
    icon: "a.proto",
    load: () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf),
  },

  // ── Data / markup ──────────────────────────────────────────────────────────
  {
    id: "xml",
    label: "XML",
    extensions: ["xml", "xsl", "xsd", "svg", "plist", "rss", "atom", "wsdl", "xaml"],
    icon: "a.xml",
    load: xmlMode,
  },
  {
    id: "sql",
    label: "SQL",
    extensions: ["sql"],
    icon: "a.sql",
    load: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL),
  },
  {
    id: "mysql",
    label: "MySQL",
    extensions: ["mysql"],
    icon: "a.sql",
    load: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.mySQL),
  },
  {
    id: "pgsql",
    label: "PostgreSQL",
    aliases: ["postgres", "psql"],
    extensions: ["pgsql", "psql"],
    icon: "a.sql",
    load: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.pgSQL),
  },
  {
    id: "sqlite",
    label: "SQLite",
    extensions: ["sqlite"],
    icon: "a.sql",
    load: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.sqlite),
  },
  {
    id: "diff",
    label: "Diff / Patch",
    extensions: ["diff", "patch"],
    icon: "a.diff",
    load: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  },

  // ── Hardware description ────────────────────────────────────────────────────
  {
    id: "verilog",
    label: "Verilog",
    extensions: ["v", "sv", "svh"],
    icon: "a.v",
    load: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => m.verilog),
  },
  {
    id: "vhdl",
    label: "VHDL",
    extensions: ["vhd", "vhdl"],
    icon: "a.vhd",
    load: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => m.vhdl),
  },

  // ── Templating ─────────────────────────────────────────────────────────────
  {
    id: "pug",
    label: "Pug",
    aliases: ["jade"],
    extensions: ["pug", "jade"],
    icon: "a.pug",
    load: () => import("@codemirror/legacy-modes/mode/pug").then((m) => m.pug),
  },

  // ── Assembly / low level ───────────────────────────────────────────────────
  {
    id: "asm",
    label: "Assembly",
    aliases: ["gas", "nasm"],
    extensions: ["s", "asm"],
    icon: "a.asm",
    load: () => import("@codemirror/legacy-modes/mode/gas").then((m) => m.gas),
  },
  {
    id: "wast",
    label: "WebAssembly Text",
    aliases: ["wasm"],
    extensions: ["wat", "wast"],
    icon: "a.wat",
    load: () => import("@codemirror/legacy-modes/mode/wast").then((m) => m.wast),
  },

  // ── Misc / niche ───────────────────────────────────────────────────────────
  {
    id: "nsis",
    label: "NSIS",
    extensions: ["nsi", "nsh"],
    icon: "a.nsi",
    load: () => import("@codemirror/legacy-modes/mode/nsis").then((m) => m.nsis),
  },
  {
    id: "gherkin",
    label: "Gherkin",
    aliases: ["cucumber", "bdd"],
    extensions: ["feature"],
    icon: "a.feature",
    load: () => import("@codemirror/legacy-modes/mode/gherkin").then((m) => m.gherkin),
  },
  {
    id: "latex",
    label: "LaTeX",
    aliases: ["tex"],
    extensions: ["tex", "sty", "cls", "ltx"],
    icon: "a.tex",
    load: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  },
  {
    id: "cypher",
    label: "Cypher",
    aliases: ["neo4j"],
    extensions: ["cypher", "cql", "cyp"],
    icon: "a.cypher",
    load: () => import("@codemirror/legacy-modes/mode/cypher").then((m) => m.cypher),
  },
  {
    id: "turtle",
    label: "Turtle / RDF",
    aliases: ["rdf"],
    extensions: ["ttl"],
    icon: "a.ttl",
    load: () => import("@codemirror/legacy-modes/mode/turtle").then((m) => m.turtle),
  },
  {
    id: "sparql",
    label: "SPARQL",
    extensions: ["rq", "sparql"],
    icon: "a.rq",
    load: () => import("@codemirror/legacy-modes/mode/sparql").then((m) => m.sparql),
  },
  {
    id: "xquery",
    label: "XQuery",
    extensions: ["xq", "xqy", "xquery"],
    icon: "a.xq",
    load: () => import("@codemirror/legacy-modes/mode/xquery").then((m) => m.xQuery),
  },
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

export function getLanguageDef(id: string): LanguageDef | undefined {
  return byId.get(id);
}

/** Display label for a language id, falling back to the id itself. */
export function languageLabel(id: string): string {
  return byId.get(id)?.label ?? id;
}

/** Representative filename for `fileIconUrl`, so the picker matches the tree. */
export function languageIconFile(id: string): string {
  return byId.get(id)?.icon ?? "";
}
