// Quick notes: scratch files for a thought you don't want to name or pick a
// folder for.
//
// A note is a REAL file living under the app data dir, so the editor pane, the
// workspace serializer and workspace restore all keep working unchanged - the
// only thing that makes it a note is WHERE it lives. That is also why there is
// no "unsaved buffer" concept anywhere: an unsaved buffer would be exactly the
// thing that dies when TEDI closes.
//
// Notes are saved the same way every other file is, with Ctrl+S or the tab's
// context menu. They used to autosave on a debounce; that was dropped so
// nothing in TEDI writes to disk without being asked.

import { joinPath, toForwardSlash } from "@/lib/path";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

let dir = "";

/** Resolves once the notes dir is known. `isNotePath` lies (returns false)
 *  until then, so anything gating on it should await this first. */
export const notesReady: Promise<string> = appDataDir()
  .then((d) => (dir = joinPath(toForwardSlash(d).replace(/\/+$/, ""), "notes")))
  .catch(() => dir);

/** First free `note-N.md` given the names already in the notes dir. */
export function nextNoteName(taken: Iterable<string>): string {
  const names = new Set(taken);
  let n = 1;
  while (names.has(`note-${n}.md`)) n++;
  return `note-${n}.md`;
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
