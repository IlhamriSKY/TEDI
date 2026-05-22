/**
 * Bridge for FS mutators. Call `dispatchFsRefresh(parentPath)` to ask the
 * explorer to re-read the directory. Decouples the explorer from the AI tool
 * layer and any other mutator.
 * Missing a dispatch is fine; the explorer also polls and refreshes on focus.
 */

export const FS_REFRESH_EVENT = "tedi:refresh-fs";

/** Tells mounted file trees to re-read `path` (its parent directory). Omit
 *  `path` to refresh every loaded directory. */
export function dispatchFsRefresh(path?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(FS_REFRESH_EVENT, {
      detail: path ? { path } : undefined,
    }),
  );
}

/** Derives `dirname(filePath)` and dispatches a refresh. Handles `/` and `\`. */
export function dispatchFsRefreshForFile(filePath: string): void {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (i <= 0) return;
  dispatchFsRefresh(filePath.slice(0, i));
}
