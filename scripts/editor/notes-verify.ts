/**
 * Self-check for quick notes (`+` -> Note).
 * Run: `npx tsx scripts/editor/notes-verify.ts`.
 *
 * A note only differs from any other file by WHERE it lives, and that single
 * fact drives the one behaviour the feature exists for: EditorPane autosaves a
 * note so the text survives quitting TEDI. So the two things that can silently
 * break it are checked here:
 *  1. `isUnder` - too loose and every project file starts autosaving; too
 *     strict (or separator-blind on Windows, where paths arrive as `C:\...`)
 *     and the note stops autosaving, which is the "my text is gone" bug.
 *  2. `nextNoteName` - must never hand back a name that already exists, or
 *     `fs_create_file` errors and the `+` -> Note click does nothing.
 * Plus the wiring the compiler cannot see: the autosave is hooked to
 * CodeMirror's onChange, and its pending write is drained by the quit guard
 * (closing the window never unmounts React, so the debounce alone loses it).
 */
export {}; // dynamic-import-only file; marks it a module so top-level await is legal.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { isUnder, nextNoteName, registerNoteFlush, flushNotes } =
  await import("../../src/modules/editor/lib/notes");

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const DIR = "C:/Users/x/AppData/Roaming/id.ilhamrisky.tedi/notes";
const winPath = (p: string) => p.replace(/\//g, "\\");

console.log("1. a note is recognised, anything else is not");
check("note in the dir", isUnder(DIR, `${DIR}/note-1.md`), true);
check("windows separators", isUnder(DIR, winPath(`${DIR}/note-1.md`)), true);
check("nested under it", isUnder(DIR, `${DIR}/sub/note-1.md`), true);
check("sibling dir sharing the prefix", isUnder(DIR, `${DIR}-old/note-1.md`), false);
check("the dir itself is not a note", isUnder(DIR, DIR), false);
check("a project file", isUnder(DIR, "D:/work/src/main.ts"), false);
check("dir not resolved yet -> never autosave", isUnder("", "D:/work/src/main.ts"), false);

console.log("2. the new note never collides with an existing one");
check("empty dir", nextNoteName([]), "note-1.md");
check("skips taken", nextNoteName(["note-1.md", "note-2.md"]), "note-3.md");
check("fills a gap", nextNoteName(["note-1.md", "note-3.md"]), "note-2.md");
check("ignores other files", nextNoteName(["todo.md", "note-1.md"]), "note-2.md");

console.log("3. the quit guard can drain a pending autosave");
{
  const written: string[] = [];
  const off = registerNoteFlush(() => void written.push("a"));
  registerNoteFlush(async () => {
    throw new Error("disk full");
  });
  let rejected = false;
  await flushNotes().catch(() => (rejected = true));
  check("pending flush ran", written, ["a"]);
  check("a failed write never wedges the quit", rejected, false);
  off();
  await flushNotes();
  check("unregistered on unmount", written, ["a"]);
}

console.log("4. the autosave is actually wired to the editor");
{
  const pane = readFileSync(join(ROOT, "src/modules/editor/EditorPane.tsx"), "utf8");
  const guard = readFileSync(join(ROOT, "src/app/hooks/useQuitGuard.ts"), "utf8");
  check("the quit guard drains them before destroy", guard.includes("flushNotes()"), true);
  check("CodeMirror uses the autosaving onChange", pane.includes("onChange={handleChange}"), true);
  check("gated on isNotePath", /autosaveRef\.current = isNotePath\(path\)/.test(pane), true);
  check(
    "the pane registers its flush with the quit guard",
    /registerNoteFlush\(flushAutosave\)/.test(pane),
    true,
  );
}

console.log(failed === 0 ? "\nnotes-verify: PASS" : `\nnotes-verify: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
