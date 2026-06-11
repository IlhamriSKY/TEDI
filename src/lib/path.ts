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
 * Convert a local filesystem path to a `file://` URL, or null if it isn't an
 * absolute local path. Handles Windows drive paths (`D:\dir\f.html` /
 * `D:/dir/f.html`), UNC paths (`\\server\share\f`), and POSIX absolute paths
 * (`/dir/f`). Used to open a local file in the in-app browser preview.
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
