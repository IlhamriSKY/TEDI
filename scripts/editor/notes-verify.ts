/**
 * Self-check for quick notes (`+` -> Note) and the saves that back them.
 * Run: `npx tsx scripts/editor/notes-verify.ts`.
 *
 * A note is an ordinary file that happens to live in the app data dir, so `+`
 * gives you a scratch buffer with no folder to pick and no name to invent. Two
 * things can silently break that:
 *  1. `nextNoteName` - must never hand back a name that already exists, or
 *     `fs_create_file` errors and the `+` -> Note click does nothing.
 *  2. The wiring the compiler cannot see. Notes used to autosave on a debounce;
 *     that is gone, so a note is only ever written when the user asks. Which
 *     makes the ways to ask load-bearing: Ctrl+S, and Save / Save As on the
 *     tab's context menu. Lose those and typing into a note has no way out.
 */
export {}; // dynamic-import-only file; marks it a module so top-level await is legal.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { nextNoteName } = await import("../../src/modules/editor/lib/notes");

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("1. the new note never collides with an existing one");
check("empty dir", nextNoteName([]), "note-1.md");
check("skips taken", nextNoteName(["note-1.md", "note-2.md"]), "note-3.md");
check("fills a gap", nextNoteName(["note-1.md", "note-3.md"]), "note-2.md");
check("ignores other files", nextNoteName(["todo.md", "note-1.md"]), "note-2.md");

console.log("\n2. nothing writes an editor to disk on its own");
{
  const pane = readFileSync(join(ROOT, "src/modules/editor/EditorPane.tsx"), "utf8");
  const notes = readFileSync(join(ROOT, "src/modules/editor/lib/notes.ts"), "utf8");
  check("the pane hands CodeMirror the plain onChange", pane.includes("onChange={onChange}"), true);
  check("no debounced save survives in the pane", /autosave/i.test(pane), false);
  check("and no flush registry survives in notes", /flush/i.test(notes), false);
}

console.log("\n3. a save is still reachable without the keyboard");
{
  const entry = readFileSync(join(ROOT, "src/modules/tabs/components/renderEntryBody.tsx"), "utf8");
  check(
    "the tab menu offers it on editor leaves",
    /leafKind === "editor" && !!onSaveEntry/.test(entry),
    true,
  );
  check("Save", /onSaveEntry!\(e\.leafId, "save"\)/.test(entry), true);
  check("Save As", /onSaveEntry!\(e\.leafId, "saveAs"\)/.test(entry), true);
}

console.log(failed === 0 ? "\nnotes-verify: PASS" : `\nnotes-verify: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
