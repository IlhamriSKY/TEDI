/**
 * Cross-module bridge: any code path that mutates the filesystem can call
 * `dispatchFsRefresh(parentPath)` to ask the explorer to silently re-read
 * the affected directory. Decouples the explorer from the AI tool layer
 * (and any other future mutator) without an explicit dependency.
 *
 * Falls back gracefully — the explorer also polls on a short interval and
 * refreshes on window focus, so missing a dispatch isn't a correctness
 * problem, just a latency one.
 */

export const FS_REFRESH_EVENT = "tedi:refresh-fs";

/** Notify any mounted file tree to re-read `path` (its parent directory).
 *  Omit `path` to refresh every currently-loaded directory. */
export function dispatchFsRefresh(path?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(FS_REFRESH_EVENT, {
      detail: path ? { path } : undefined,
    }),
  );
}

/** Convenience: derive `dirname(filePath)` and dispatch a refresh for it.
 *  Handles both `/` and `\` separators. */
export function dispatchFsRefreshForFile(filePath: string): void {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (i <= 0) return;
  dispatchFsRefresh(filePath.slice(0, i));
}
