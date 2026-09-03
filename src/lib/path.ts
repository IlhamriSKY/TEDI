// Shared path helpers. The canonical path form on the frontend is forward-slash
// (see TEDI.md), but paths can still arrive with backslashes from the OS / OSC 7,
// so anything that splits a path must handle BOTH separators. Defined once and
// used everywhere so display logic and the AI secret-path guard cannot drift
// apart (a divergent basename copy was a real correctness/security risk).

/** Convert backslashes to forward slashes (the canonical frontend form). */
export function toForwardSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Split a path on both `/` and `\`, dropping empty segments. */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/**
 * Last path segment. Handles both separators and trailing separators
 * ("foo/bar/" -> "bar"); a string with no separator returns itself; "/" -> "/".
 */
export function basename(path: string): string {
  const parts = pathSegments(path);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Join a directory and a child segment with exactly one `/`. Does not
 *  normalize separators; pass an already forward-slash `dir`. */
export function joinPath(dir: string, child: string): string {
  return dir.endsWith("/") ? `${dir}${child}` : `${dir}/${child}`;
}

/** Parent directory in forward-slash form. Returns "" when there is no parent. */
export function dirname(path: string): string {
  const parts = pathSegments(path);
  if (parts.length <= 1) return "";
  const norm = toForwardSlash(path).replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "" : norm.slice(0, i);
}

/** Percent-encode each `/`-separated segment (spaces, `#`, `?`, … become %xx)
 *  while leaving the separators intact, so a path with spaces or a literal `#`
 *  in a filename survives as a valid file:// URL. */
function encodeFileUrlPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * True for a file the editor cannot show but a browser can. Today that is PDF
 * alone: `fs_read_file` sniffs it as binary (it is not one of the
 * `<img>`-renderable formats), so an editor tab would only ever print
 * "Binary file", while every browser ships a PDF viewer.
 *
 * Deliberately not a general "viewable in a browser" list: every entry has to
 * be a format the editor genuinely cannot handle AND a browser genuinely can.
 * Images already round-trip through `fs_read_file` as a data URL that
 * `EditorPane` renders, so adding them here would be a regression.
 */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/**
 * Convert a local filesystem path to a `file://` URL, or null if it isn't an
 * absolute local path. Handles Windows drive paths (`D:\dir\f.html` /
 * `D:/dir/f.html`), UNC paths (`\\server\share\f`), and POSIX absolute paths
 * (`/dir/f`). Used to hand a local file to the browser.
 */
export function pathToFileUrl(path: string): string | null {
  // Windows drive path: D:\… or D:/…  ->  file:///D:/…
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (drive) {
    return `file:///${drive[1].toUpperCase()}:/${encodeFileUrlPath(drive[2].replace(/\\/g, "/"))}`;
  }
  // UNC path: \\server\share\…  ->  file://server/share/…
  const unc = /^\\\\([^\\/]+)[\\/](.*)$/.exec(path);
  if (unc) {
    return `file://${encodeURIComponent(unc[1])}/${encodeFileUrlPath(unc[2].replace(/\\/g, "/"))}`;
  }
  // POSIX absolute path: /…  ->  file:///…  (macOS / Linux)
  if (path.startsWith("/")) {
    return `file://${encodeFileUrlPath(path)}`;
  }
  return null;
}
