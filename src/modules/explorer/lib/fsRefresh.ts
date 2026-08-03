/**
 * Bridge for FS mutators. Call `dispatchFsRefresh(parentPath)` to ask the
 * explorer to re-read the directory. Decouples the explorer from the AI tool
 * layer and any other mutator.
 * Missing a dispatch is fine; the explorer also polls and refreshes on focus.
 */

import { toForwardSlash } from "@/lib/path";

export const FS_REFRESH_EVENT = "tedi:refresh-fs";

type FsRefreshDetail = { path?: string; file?: string };

/** Tells mounted file trees to re-read `path` (its parent directory). Omit
 *  `path` to refresh every loaded directory. `file` names the exact file that
 *  changed when the caller knows it, so an open editor can reload just that
 *  one instead of guessing from the directory. */
export function dispatchFsRefresh(path?: string, file?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FsRefreshDetail | undefined>(FS_REFRESH_EVENT, {
      detail: path ? { path, file } : undefined,
    }),
  );
}

/** Derives `dirname(filePath)` and dispatches a refresh. Handles `/` and `\`. */
export function dispatchFsRefreshForFile(filePath: string): void {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (i <= 0) return;
  dispatchFsRefresh(filePath.slice(0, i), filePath);
}

/**
 * Subscribe to writes of one exact file, so an open editor can reload in place
 * rather than showing stale text until it is closed and reopened. Comparison is
 * slash-agnostic and case-insensitive: the same file reaches this bridge as both
 * `C:\a\b.md` and `C:/a/b.md`, and Windows paths differ only in case.
 */
export function subscribeFileChange(getPath: () => string, onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const norm = (p: string) => toForwardSlash(p).toLowerCase();
  const handler = (ev: Event) => {
    const file = (ev as CustomEvent<FsRefreshDetail | undefined>).detail?.file;
    if (file && norm(file) === norm(getPath())) onChange();
  };
  window.addEventListener(FS_REFRESH_EVENT, handler);
  return () => window.removeEventListener(FS_REFRESH_EVENT, handler);
}
