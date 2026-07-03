/**
 * Project-local formatter config discovery.
 *
 * Walks from the file's directory up toward the filesystem root, reading
 * candidate config files via `fs_read_file`. Caches per-directory results
 * for the session so repeated formats don't replay the IO. Returns a
 * partial Prettier options object (the keys we know how to merge); the
 * caller layers it over the built-in defaults.
 *
 * Supported sources (priority order — first hit wins):
 *
 *   1. `.prettierrc` (JSON)
 *   2. `.prettierrc.json`
 *   3. `.prettierrc.json5` (parsed as relaxed JSON — // comments + trailing commas stripped)
 *   4. `package.json` with a top-level `"prettier"` field
 *
 * Not supported (would require executing JS in the webview, which we
 * deliberately don't):
 *   - `.prettierrc.js` / `prettier.config.js` / `.cjs` / `.mjs`
 *
 * `.prettierrc.yaml` / `.yml` is also skipped because pulling in a YAML
 * parser to read one config file would bloat the editor bundle. Users on
 * YAML prettier configs should either convert to JSON, add a one-line
 * `package.json#prettier` mirror, or switch the language's formatter type
 * to `external` with `prettier --stdin-filepath ${file}` (which respects
 * every config flavour natively).
 *
 * `.editorconfig` is read separately by `editorConfig.ts` and merged in
 * before the prettierrc layer (prettierrc wins).
 */

import { invoke } from "@tauri-apps/api/core";
import type { FsReadResult } from "@/lib/ipc";

export type PartialPrettierOptions = Partial<{
  semi: boolean;
  singleQuote: boolean;
  jsxSingleQuote: boolean;
  tabWidth: number;
  useTabs: boolean;
  printWidth: number;
  trailingComma: "all" | "none" | "es5";
  bracketSpacing: boolean;
  bracketSameLine: boolean;
  arrowParens: "always" | "avoid";
  endOfLine: "lf" | "crlf" | "auto" | "cr";
  proseWrap: "always" | "never" | "preserve";
}>;

type Override = {
  files: string | string[];
  options: PartialPrettierOptions;
};

type PrettierConfigFile = PartialPrettierOptions & {
  overrides?: Override[];
};

const CONFIG_FILENAMES = [".prettierrc", ".prettierrc.json", ".prettierrc.json5"];

/** Cache by directory so repeated formats inside a folder don't re-walk. */
const cache = new Map<string, Promise<PrettierConfigFile | null>>();

function parentDir(path: string): string | null {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) return null;
  // Don't ascend above a drive root on Windows ("C:" or "C:/").
  if (/^[a-zA-Z]:$/.test(norm.slice(0, idx))) return null;
  return norm.slice(0, idx);
}

function joinPath(dir: string, child: string): string {
  return dir.endsWith("/") ? `${dir}${child}` : `${dir}/${child}`;
}

async function tryReadText(path: string): Promise<string | null> {
  try {
    const res = await invoke<FsReadResult>("fs_read_file", { path });
    if (res.kind !== "text") return null;
    return res.content;
  } catch {
    return null;
  }
}

/** Strips // line comments and trailing commas. Just enough JSON5 to read
 *  the common prettier config flavours; not a full JSON5 implementation. */
function parseRelaxedJson(input: string): unknown {
  // Strict JSON first: a valid `.prettierrc`/`.prettierrc.json` may hold a
  // "$schema" URL whose `//` the comment-stripper below would otherwise eat,
  // breaking the parse and silently dropping the whole config. Only fall back
  // to the relaxed pass for genuinely JSON5-flavoured files.
  try {
    return JSON.parse(input);
  } catch {
    // not strict JSON — try the relaxed stripping below
  }
  let cleaned = input.replace(/\/\/[^\n]*\n/g, "\n");
  // Strip /* */ block comments.
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip trailing commas in objects and arrays.
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

function applyOverrides(
  base: PartialPrettierOptions,
  overrides: Override[] | undefined,
  filepath: string,
): PartialPrettierOptions {
  if (!overrides || overrides.length === 0) return base;
  const name = filepath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  let out: PartialPrettierOptions = { ...base };
  for (const ov of overrides) {
    const patterns = Array.isArray(ov.files) ? ov.files : [ov.files];
    if (patterns.some((p) => matchesGlob(name, p.toLowerCase()))) {
      out = { ...out, ...ov.options };
    }
  }
  return out;
}

// Tiny glob match: supports leading `*.ext`, `globstar/*.ext`, and exact
// matches. Prettier's full glob set is broader but `.prettierrc` overrides
// almost always use the extension form, and that's what we support.
function matchesGlob(name: string, pattern: string): boolean {
  const clean = pattern.replace(/^\*\*\//, "");
  if (clean.startsWith("*.")) {
    return name.endsWith(clean.slice(1));
  }
  if (clean.startsWith("*")) {
    return name.endsWith(clean.slice(1));
  }
  return name === clean;
}

async function loadFromDir(dir: string): Promise<PrettierConfigFile | null> {
  // short-circuit search: returns on first config file found
  for (const name of CONFIG_FILENAMES) {
    const text = await tryReadText(joinPath(dir, name));
    if (text === null) continue;
    try {
      const parsed = parseRelaxedJson(text) as PrettierConfigFile;
      return parsed;
    } catch {
      // Malformed config — skip silently rather than blowing up the save.
      return null;
    }
  }
  // package.json fallback. Only honour it when it actually has a "prettier"
  // field; otherwise an unrelated package.json shouldn't halt the walk.
  const pkg = await tryReadText(joinPath(dir, "package.json"));
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as { prettier?: PrettierConfigFile };
      if (parsed.prettier && typeof parsed.prettier === "object") {
        return parsed.prettier;
      }
    } catch {
      // Ignore bad JSON in package.json — it's not the formatter's job.
    }
  }
  return null;
}

/**
 * Walks parents of `filepath` looking for a prettier config. The first
 * directory with a recognised config wins; the result is cached so a hot
 * editor session pays the IO only once per directory.
 */
export async function resolvePrettierConfig(
  filepath: string,
): Promise<PartialPrettierOptions | null> {
  let dir = parentDir(filepath);
  const visited: string[] = [];
  while (dir) {
    visited.push(dir);
    let cached = cache.get(dir);
    if (!cached) {
      cached = loadFromDir(dir);
      cache.set(dir, cached);
    }
    const found = await cached;
    if (found) {
      // Apply overrides[] against the file's name before returning so the
      // caller doesn't need to know about the override schema.
      return applyOverrides(found, found.overrides, filepath);
    }
    const next = parentDir(dir);
    if (next === dir || next === null) break;
    dir = next;
  }
  // Negative-cache every walked dir so a follow-up format from a sibling
  // file doesn't re-read the same parents.
  for (const d of visited) {
    if (!cache.has(d)) cache.set(d, Promise.resolve(null));
  }
  return null;
}
