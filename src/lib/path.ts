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
