// Quick notes: scratch files for a thought you don't want to name, pick a
// folder for, or press Ctrl+S on.
//
// A note is a REAL file living under the app data dir, so the editor pane, the
// workspace serializer and workspace restore all keep working unchanged - the
// only thing that makes it a note is WHERE it lives, which is what
// `isNotePath` (and hence EditorPane's autosave) keys on. That is why there is
// no "unsaved buffer" concept anywhere: an unsaved buffer would be exactly the
// thing that dies when TEDI closes.

import { joinPath, toForwardSlash } from "@/lib/path";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

let dir = "";

/** Resolves once the notes dir is known. `isNotePath` lies (returns false)
 *  until then, so anything gating on it should await this first. */
export const notesReady: Promise<string> = appDataDir()
  .then((d) => (dir = joinPath(toForwardSlash(d).replace(/\/+$/, ""), "notes")))
  .catch(() => dir);

/** True when `path` sits inside directory `root`. Both separators, so a note
 *  path that arrived from the OS with backslashes still matches, and a sibling
 *  dir sharing the prefix (`.../notes-old/x`) does not. */
export function isUnder(root: string, path: string): boolean {
  return root !== "" && toForwardSlash(path).startsWith(`${root}/`);
}

/** True when `path` is a quick note. Sync (EditorPane reads it per keystroke),
 *  hence the module-level cache; see `notesReady`. */
export function isNotePath(path: string): boolean {
  return isUnder(dir, path);
}

/** First free `note-N.md` given the names already in the notes dir. */
export function nextNoteName(taken: Iterable<string>): string {
  const names = new Set(taken);
  let n = 1;
  while (names.has(`note-${n}.md`)) n++;
  return `note-${n}.md`;
}

/**
 * Editors with a pending autosave register here so the quit guard can flush
 * them. Closing the window does not unmount React, so the debounce alone would
 * drop the last keystrokes typed before the click on X - the exact "my note is
 * gone" case notes exist to prevent.
 */
const pendingFlushes = new Set<() => void | Promise<void>>();

export function registerNoteFlush(flush: () => void | Promise<void>): () => void {
  pendingFlushes.add(flush);
  return () => void pendingFlushes.delete(flush);
}

/** Run every pending autosave. Never rejects: a failed write must not wedge the quit. */
export async function flushNotes(): Promise<void> {
  await Promise.all(
    [...pendingFlushes].map((f) =>
      Promise.resolve()
        .then(f)
        .catch(() => {}),
    ),
  );
}

/** Create the next free `note-N.md` and return its absolute path. */
export async function createNote(): Promise<string> {
  const root = await notesReady;
  if (!root) throw new Error("no app data dir");
  // Fails when it already exists, which is the normal case.
  await invoke("fs_create_dir", { path: root }).catch(() => {});
  const taken = (await invoke<{ name: string }[]>("fs_read_dir", { path: root })).map(
    (e) => e.name,
  );
  const path = joinPath(root, nextNoteName(taken));
  await invoke("fs_create_file", { path });
  return path;
}
