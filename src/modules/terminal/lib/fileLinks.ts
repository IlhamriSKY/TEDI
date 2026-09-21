/**
 * Clickable `path:line:col` references in terminal output. A compiler error, a
 * stack trace or a failing test names the file and line it is about; clicking
 * that reference opens the file in an editor pane at that line.
 *
 * A candidate only becomes a link once the file is known to EXIST (one
 * `fs_canonicalize` per candidate, cached briefly), so a version number, a
 * domain or any word with a dot in it is never underlined. xterm asks for a
 * line's links only when the pointer moves onto that line, which keeps the IPC
 * to the line under the mouse.
 *
 * Local terminals only: an SSH pane's paths live on the remote host.
 */
import { invoke } from "@tauri-apps/api/core";
import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";

export type FileRef = {
  /** The path exactly as printed. */
  path: string;
  /** 1-indexed, when the tool printed one. */
  line?: number;
  col?: number;
  /** String offsets into the line text, end exclusive, position suffix included. */
  start: number;
  end: number;
  /** The unextended match, tried when a reach-back to a drive letter was wrong. */
  fallback?: { path: string; start: number };
};

// A path ending in an extension, then an optional position in any of the
// shapes tools print one:
//   src/app.ts:12:5   (tsc --pretty, eslint, vite, cargo, go, node, phpunit)
//   App.cs(12,5)      (msbuild, plain tsc)
//   "app.py", line 12 (python tracebacks)
//   app.php on line 12 (php)
const FILE_REF_RE =
  /((?:[A-Za-z]:)?(?:[\w.~@+-]*[\\/])*[\w.@+-]*[\w@+-]\.[A-Za-z]\w{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|"?,\s*line\s+(\d+)|\s+on\s+line\s+(\d+))?/g;

/** Where an absolute Windows path can begin, so a path with spaces is found whole. */
const DRIVE_START_RE = /[A-Za-z]:[\\/]/g;

/** Every file reference in one line of terminal text. Pure, so a verify can pin it. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  for (const m of text.matchAll(FILE_REF_RE)) {
    const start = m.index ?? 0;
    let path = m[1];
    // A URL is the web-links addon's, and `//host/x` is a UNC share that would
    // make the existence check wait on the network.
    const tokenStart =
      Math.max(text.lastIndexOf(" ", start - 1), text.lastIndexOf("\t", start - 1)) + 1;
    if (text.slice(tokenStart, start + path.length).includes("://")) continue;
    if (path.startsWith("//") || path.startsWith("\\\\")) continue;
    let from = start;
    let fallback: FileRef["fallback"];
    // `C:\Users\IT STAFF\app\x.ts:3` matches from `STAFF\...`; reach back to the
    // drive letter when nothing that ends a path sits in between.
    if (!/^[A-Za-z]:/.test(path)) {
      const before = text.slice(0, start);
      let drive = -1;
      for (const d of before.matchAll(DRIVE_START_RE)) drive = d.index ?? -1;
      if (drive >= 0 && !/["'()<>|\t:]/.test(before.slice(drive + 2))) {
        fallback = { path, start };
        from = drive;
        path = text.slice(drive, start) + path;
      }
    }
    const num = (s: string | undefined) => (s ? Number.parseInt(s, 10) : undefined);
    const line = num(m[2] ?? m[4] ?? m[6] ?? m[7]);
    const col = num(m[3] ?? m[5]);
    out.push({ path, line, col, start: from, end: start + m[0].length, fallback });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Paths to try for one reference, most specific first: an absolute path as is,
 * then anything relative (or a POSIX-rooted `/src/x.ts` a dev server prints)
 * against the shell's cwd. Forward slashes, the frontend's canonical form.
 */
export function candidatePaths(raw: string, cwd: string | null): string[] {
  const p = raw.replace(/\\/g, "/");
  const out: string[] = [];
  const winAbs = /^[A-Za-z]:\//.test(p);
  if (winAbs || p.startsWith("/")) out.push(p);
  if (cwd && !winAbs) {
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    out.push(`${base}/${p.replace(/^\.\//, "").replace(/^\/+/, "")}`);
  }
  return out;
}

const EXISTS_TTL_MS = 10_000;
const existsCache = new Map<string, { at: number; value: Promise<string | null> }>();

/** The canonical path when `path` exists, else null. Cached so hovering is cheap. */
function canonicalIfExists(path: string): Promise<string | null> {
  const now = Date.now();
  const hit = existsCache.get(path);
  if (hit && now - hit.at < EXISTS_TTL_MS) return hit.value;
  // ponytail: wholesale clear instead of LRU; a hover touches a handful of paths.
  if (existsCache.size > 256) existsCache.clear();
  const value = invoke<string>("fs_canonicalize", { path }).catch(() => null);
  existsCache.set(path, { at: now, value });
  return value;
}

async function resolveRef(raw: string, cwd: string | null): Promise<string | null> {
  for (const p of candidatePaths(raw, cwd)) {
    const hit = await canonicalIfExists(p);
    if (hit) return hit;
  }
  return null;
}

/**
 * The line's text plus, for each string index, the cell it was drawn in. A wide
 * glyph (CJK, most emoji) is one character across two cells, so string offsets
 * and link columns part ways after the first one.
 */
function readLine(line: IBufferLine, cols: number): { text: string; cellOf: number[] } {
  let text = "";
  const cellOf: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cellOf.push(x);
    text += chars;
  }
  return { text, cellOf };
}

export type FileLinkTarget = { path: string; line?: number };

export function registerFileLinks(
  term: Terminal,
  getCwd: () => string | null,
  open: (target: FileLinkTarget) => void,
): () => void {
  const d = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const { text, cellOf } = readLine(line, term.cols);
      const refs = findFileRefs(text);
      if (refs.length === 0) return callback(undefined);
      const cwd = getCwd();
      void Promise.all(
        refs.map(async (ref): Promise<ILink | null> => {
          let start = ref.start;
          let path = await resolveRef(ref.path, cwd);
          if (!path && ref.fallback) {
            start = ref.fallback.start;
            path = await resolveRef(ref.fallback.path, cwd);
          }
          if (!path) return null;
          return {
            range: {
              start: { x: (cellOf[start] ?? 0) + 1, y },
              end: { x: (cellOf[ref.end - 1] ?? 0) + 1, y },
            },
            text: text.slice(start, ref.end),
            decorations: { underline: true, pointerCursor: true },
            activate: () => open({ path, line: ref.line }),
          };
        }),
      ).then((links) => {
        const found = links.filter((l): l is ILink => l !== null);
        callback(found.length > 0 ? found : undefined);
      });
    },
  });
  return () => d.dispose();
}
