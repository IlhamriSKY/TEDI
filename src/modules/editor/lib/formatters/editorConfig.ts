/**
 * Minimal `.editorconfig` resolver.
 *
 * Walks parents of the file looking for `.editorconfig`. Stops walking at
 * the first file that sets `root = true` at the unnamed top section.
 * Per the spec, sibling sections farther from the file are overridden by
 * sections closer to the file — so we accumulate options bottom-up by
 * walking root-down (last write wins).
 *
 * We only honour the keys the built-in Prettier path can map:
 *   indent_style  (tab / space)        → useTabs
 *   indent_size   (number)             → tabWidth
 *   end_of_line   (lf / crlf / cr)     → endOfLine
 *   max_line_length (number)           → printWidth
 *
 * That's a strict subset of EditorConfig but it covers the keys that
 * actually influence reformatting; the rest (charset, insert_final_newline,
 * trim_trailing_whitespace) are file-write concerns Prettier handles on
 * its own.
 *
 * Section matching is a small glob subset:
 *   `*`                  any characters in a single path segment
 *   `**`                 any characters across path segments
 *   `?`                  any single character
 *   `[abc]` / `[!abc]`   char class
 *   `{a,b,c}`            alternation
 *   `{1..N}`             numeric range (not implemented — uncommon)
 */

import { invoke } from "@tauri-apps/api/core";
import type { FsReadResult } from "@/lib/ipc";
import type { PartialPrettierOptions } from "./projectConfig";

type Section = {
  pattern: string;
  options: PartialPrettierOptions;
};

type Parsed = {
  root: boolean;
  sections: Section[];
  /** Absolute dir this file lives in — section globs are relative to it. */
  baseDir: string;
};

const cache = new Map<string, Promise<Parsed | null>>();

function parentDir(path: string): string | null {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) return null;
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

function mapKeyValue(key: string, value: string, into: PartialPrettierOptions): void {
  const v = value.trim().toLowerCase();
  switch (key.trim().toLowerCase()) {
    case "indent_style":
      if (v === "tab") into.useTabs = true;
      else if (v === "space") into.useTabs = false;
      return;
    case "indent_size": {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0 && n <= 16) into.tabWidth = n;
      return;
    }
    case "end_of_line":
      if (v === "lf" || v === "crlf" || v === "cr") into.endOfLine = v;
      return;
    case "max_line_length": {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) into.printWidth = n;
      return;
    }
  }
}

function parseEditorConfig(text: string, baseDir: string): Parsed {
  const result: Parsed = { root: false, sections: [], baseDir };
  let current: Section | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[;#].*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = { pattern: line.slice(1, -1), options: {} };
      result.sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (current === null) {
      // Top-level section: only `root = true` is meaningful for us.
      if (key.toLowerCase() === "root" && value.toLowerCase() === "true") {
        result.root = true;
      }
      continue;
    }
    mapKeyValue(key, value, current.options);
  }
  return result;
}

/** Convert an editorconfig glob to a regex anchored to the full relative
 *  path. Approximates the spec — close enough for the keys we care about. */
function globToRegex(glob: string): RegExp {
  let g = glob;
  // EditorConfig: if pattern lacks `/`, it matches in any subdirectory.
  if (!g.includes("/")) g = `**/${g}`;
  // Trim leading `/`.
  g = g.replace(/^\/+/, "");

  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const close = g.indexOf("]", i);
      if (close === -1) {
        re += "\\[";
      } else {
        let body = g.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += `[${body}]`;
        i = close;
      }
    } else if (ch === "{") {
      const close = g.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
      } else {
        const alts = g
          .slice(i + 1, close)
          .split(",")
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = close;
      }
    } else if (/[.+^${}()|\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

function relPath(file: string, dir: string): string | null {
  const fn = file.replace(/\\/g, "/");
  const dn = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!fn.toLowerCase().startsWith(`${dn.toLowerCase()}/`)) return null;
  return fn.slice(dn.length + 1);
}

async function loadFromDir(dir: string): Promise<Parsed | null> {
  const text = await tryReadText(joinPath(dir, ".editorconfig"));
  if (text === null) return null;
  return parseEditorConfig(text, dir);
}

/**
 * Resolves the effective editorconfig options for `filepath`. Walks
 * upward, accumulates matching sections, and stops at the first
 * `root = true` file (per spec).
 */
export async function resolveEditorConfig(filepath: string): Promise<PartialPrettierOptions> {
  const stack: Parsed[] = [];
  let dir = parentDir(filepath);
  while (dir) {
    let cached = cache.get(dir);
    if (!cached) {
      cached = loadFromDir(dir);
      cache.set(dir, cached);
    }
    const parsed = await cached;
    if (parsed) {
      stack.push(parsed);
      if (parsed.root) break;
    }
    const next = parentDir(dir);
    if (next === dir || next === null) break;
    dir = next;
  }

  // Apply outer (rootmost) → inner (file-closest) so closer overrides win.
  const out: PartialPrettierOptions = {};
  for (let i = stack.length - 1; i >= 0; i--) {
    const parsed = stack[i]!;
    const rel = relPath(filepath, parsed.baseDir);
    if (rel === null) continue;
    for (const section of parsed.sections) {
      try {
        if (globToRegex(section.pattern).test(rel)) {
          Object.assign(out, section.options);
        }
      } catch {
        // A pattern we can't translate is silently skipped — better to
        // miss one section than corrupt the format.
      }
    }
  }
  return out;
}

export function _clearEditorConfigCache(): void {
  cache.clear();
}
