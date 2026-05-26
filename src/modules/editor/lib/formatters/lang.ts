/**
 * Maps file paths to a stable language id that the formatter registry
 * keys on. Keep this list in sync with `DEFAULT_FORMATTERS` in
 * `settings/store.ts` so first-install defaults line up with detection.
 *
 * The id is what shows in Settings → Editor → Formatters and what users
 * configure their external commands against.
 */
export const LANGUAGE_LABELS: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  jsx: "JavaScript (JSX)",
  tsx: "TypeScript (TSX)",
  json: "JSON",
  jsonc: "JSON with Comments",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  vue: "Vue",
  yaml: "YAML",
  markdown: "Markdown",
  graphql: "GraphQL",
  rust: "Rust",
  go: "Go",
  python: "Python",
  ruby: "Ruby",
  php: "PHP",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  c: "C",
  cpp: "C++",
  swift: "Swift",
  dart: "Dart",
  lua: "Lua",
  shell: "Shell",
  powershell: "PowerShell",
  sql: "SQL",
  toml: "TOML",
  xml: "XML",
  dockerfile: "Dockerfile",
  elixir: "Elixir",
  haskell: "Haskell",
  nix: "Nix",
  terraform: "Terraform / HCL",
  protobuf: "Protocol Buffers",
  zig: "Zig",
  elm: "Elm",
  fsharp: "F#",
  scala: "Scala",
  perl: "Perl",
  r: "R",
};

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "vue",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  graphql: "graphql",
  gql: "graphql",
  rs: "rust",
  go: "go",
  py: "python",
  pyw: "python",
  pyi: "python",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  phtml: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  sql: "sql",
  mysql: "sql",
  pgsql: "sql",
  toml: "toml",
  xml: "xml",
  xsl: "xml",
  xsd: "xml",
  svg: "xml",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  lhs: "haskell",
  nix: "nix",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
  proto: "protobuf",
  zig: "zig",
  elm: "elm",
  fs: "fsharp",
  fsx: "fsharp",
  fsi: "fsharp",
  scala: "scala",
  sbt: "scala",
  pl: "perl",
  pm: "perl",
  r: "r",
};

const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  "dockerfile.dev": "dockerfile",
  "dockerfile.prod": "dockerfile",
  containerfile: "dockerfile",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  vagrantfile: "ruby",
};

/** Lowercased basename ext after the last `.`, or null. */
function extOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
}

export function languageFromPath(path: string): string | null {
  const base = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  const byName = FILENAME_TO_LANG[base];
  if (byName) return byName;
  const ext = extOf(base);
  if (!ext) return null;
  return EXT_TO_LANG[ext] ?? null;
}

/** Languages the bundled Prettier build can format. Settings UI uses this
 *  to grey out the "builtin" option for everything else. */
export const BUILTIN_LANGUAGES: ReadonlySet<string> = new Set([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "jsonc",
  "css",
  "scss",
  "less",
  "html",
  "vue",
  "yaml",
  "markdown",
  "graphql",
]);

/** Ordered list of every known language for table rendering. */
export const ALL_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_LABELS).sort((a, b) =>
  LANGUAGE_LABELS[a]!.localeCompare(LANGUAGE_LABELS[b]!),
);
