/**
 * Suggested external formatter commands per language. The Settings UI
 * pre-fills these when the user flips a language to "external" with an
 * empty command, and shows a "Use suggested" link so they can re-snap
 * to the recommended invocation after they've fiddled with it.
 *
 * Each preset must respect the project's own config — that's the whole
 * point of choosing external over built-in. For tools that read config
 * from cwd (rustfmt → rustfmt.toml, prettier → .prettierrc, stylua →
 * stylua.toml, etc.), nothing extra is required — `fmt_run_external`
 * spawns with `cwd = dir(file)` so the resolver walks up correctly.
 *
 * Convention:
 *   - stdin mode wins when the tool supports it (cleaner, no temp file).
 *   - `${file}` mode is for in-place formatters that only accept a path
 *     (php-cs-fixer, dart format, taplo, xmllint).
 *
 * If a user installs the binary at a non-standard location they can
 * override the program with an absolute path; presets assume the tool is
 * on PATH.
 */

import type { FormatterConfig } from "@/modules/settings/store";

type Preset = { command: string; args: string[] };

export const EXTERNAL_PRESETS: Record<string, Preset> = {
  // Language        Tool                    Mode
  rust: { command: "rustfmt", args: ["--emit", "stdout"] }, // stdin
  go: { command: "gofmt", args: [] }, // stdin
  python: { command: "ruff", args: ["format", "-"] }, // stdin (Ruff falls back to Black-compatible style)
  ruby: { command: "rufo", args: [] }, // stdin/stdout
  php: { command: "php-cs-fixer", args: ["fix", "--quiet", "${file}"] }, // temp-file
  java: { command: "google-java-format", args: ["-"] }, // stdin
  kotlin: { command: "ktlint", args: ["--format", "${file}"] }, // temp-file
  csharp: { command: "dotnet", args: ["csharpier", "--write-stdout"] }, // stdin
  c: { command: "clang-format", args: ["--assume-filename=${file}"] }, // stdin, uses .clang-format from cwd
  cpp: { command: "clang-format", args: ["--assume-filename=${file}"] }, // stdin
  swift: { command: "swift-format", args: [] }, // stdin
  dart: { command: "dart", args: ["format", "${file}"] }, // temp-file
  lua: { command: "stylua", args: ["-"] }, // stdin (--search-parent-directories is default)
  shell: { command: "shfmt", args: ["-"] }, // stdin (respects .editorconfig)
  powershell: { command: "Invoke-Formatter", args: ["${file}"] }, // temp-file via PSScriptAnalyzer
  sql: { command: "sqlfluff", args: ["format", "-", "--dialect", "ansi"] }, // stdin
  toml: { command: "taplo", args: ["format", "-"] }, // stdin
  xml: { command: "xmllint", args: ["--format", "${file}"] }, // temp-file
  dockerfile: { command: "dockerfmt", args: [] }, // stdin
  elixir: { command: "mix", args: ["format", "${file}"] }, // temp-file (mix uses .formatter.exs)
  haskell: { command: "ormolu", args: [] }, // stdin
  nix: { command: "alejandra", args: ["--quiet", "-"] }, // stdin
  terraform: { command: "terraform", args: ["fmt", "-"] }, // stdin
  protobuf: { command: "buf", args: ["format"] }, // stdin
  zig: { command: "zig", args: ["fmt", "--stdin"] }, // stdin
  elm: { command: "elm-format", args: ["--stdin"] }, // stdin
  fsharp: { command: "fantomas", args: ["--stdout", "${file}"] }, // temp-file with stdout flag
  scala: { command: "scalafmt", args: ["--stdin", "--quiet"] }, // stdin (uses .scalafmt.conf)
  perl: { command: "perltidy", args: ["-st", "-se"] }, // stdin → stdout
  r: { command: "R", args: ["--quiet", "--vanilla", "-e", "styler::style_file('${file}')"] }, // temp-file
};

/** Returns a fully-formed FormatterConfig for the preset, ready to drop
 *  into the prefs store. */
export function buildPresetConfig(language: string): FormatterConfig | null {
  const preset = EXTERNAL_PRESETS[language];
  if (!preset) return null;
  return { type: "external", command: preset.command, args: preset.args };
}

export function hasPreset(language: string): boolean {
  return language in EXTERNAL_PRESETS;
}
