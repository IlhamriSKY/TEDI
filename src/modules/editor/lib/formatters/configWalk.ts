// Shared filesystem walk helpers for the format-on-save config resolvers
// (.editorconfig and .prettierrc). Defined once so the two resolvers cannot
// drift on parent-walk or read semantics.
import { invoke } from "@tauri-apps/api/core";
import type { FsReadResult } from "@/lib/ipc";

/** Parent directory in forward-slash form, or null at a filesystem root.
 *  Won't ascend above a Windows drive root ("C:" or "C:/"). */
export function parentDir(path: string): string | null {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) return null;
  if (/^[a-zA-Z]:$/.test(norm.slice(0, idx))) return null;
  return norm.slice(0, idx);
}

/** Join a directory and a child segment with a single separator. */
export function joinPath(dir: string, child: string): string {
  return dir.endsWith("/") ? `${dir}${child}` : `${dir}/${child}`;
}

/** Read a text file via the fs backend, or null if it is missing or not text. */
export async function tryReadText(path: string): Promise<string | null> {
  try {
    const res = await invoke<FsReadResult>("fs_read_file", { path });
    if (res.kind !== "text") return null;
    return res.content;
  } catch {
    return null;
  }
}
