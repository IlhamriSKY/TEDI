/**
 * Self-check for `runNotesAction`, the one implementation behind both the MCP
 * `notes` tool and the in-app agent's `notes_write`.
 * Run: `npx tsx scripts/mcp/notes-actions-verify.ts`.
 *
 * Pins the management actions that used to be missing (edit, reopen, delete,
 * clear) and that a bad id is refused instead of silently doing nothing.
 */
import { NOTES_WRITE_ACTIONS, runNotesAction } from "../../src/modules/notes/notesAutomation";
import { useNotesStore } from "../../src/modules/notes/store";
import { TOOL_DEFS } from "./tools.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log("    ", detail);
  }
}
async function throws(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

// `loaded: true` so `load()` never reaches the Tauri store in node.
useNotesStore.setState({ loaded: true, notes: [], todos: [] });
const st = () => useNotesStore.getState();

console.log("[notes] the MCP enum and the native op enum list the same actions");
const mcpEnum = (TOOL_DEFS.notes.schema.properties?.action as { enum: string[] }).enum;
check(
  "tools.mjs enum === read + NOTES_WRITE_ACTIONS",
  JSON.stringify(mcpEnum) === JSON.stringify(["read", ...NOTES_WRITE_ACTIONS]),
  mcpEnum,
);

console.log("[todos]");
await runNotesAction({ action: "add_todo", text: "first" });
const td = st().todos[0].id;
await runNotesAction({ action: "edit_todo", id: td, text: "renamed" });
check("edit_todo replaces the line", st().todos[0].text === "renamed");
await runNotesAction({ action: "complete_todo", id: td });
check("complete_todo ticks it", st().todos[0].done === true);
await runNotesAction({ action: "reopen_todo", id: td });
check("reopen_todo unticks it", st().todos[0].done === false);
await runNotesAction({ action: "add_todo", text: "second" });
await runNotesAction({ action: "complete_todo", id: st().todos[1].id });
await runNotesAction({ action: "clear_done" });
check("clear_done drops only the done one", st().todos.length === 1 && st().todos[0].id === td);
await runNotesAction({ action: "delete_todo", id: td });
check("delete_todo removes it", st().todos.length === 0);
check(
  "an unknown todo id is refused",
  await throws(runNotesAction({ action: "delete_todo", id: "td-nope" })),
);
check(
  "edit_todo with a blank line is refused",
  await throws(runNotesAction({ action: "edit_todo", id: td, text: "  " })),
);

console.log("[notes]");
await runNotesAction({ action: "add_note", text: "title", body: "hello" });
const nt = st().notes[0].id;
const full = await runNotesAction({ action: "read", id: nt });
check("read with an id returns the body", full.includes("hello"), full);
await runNotesAction({ action: "edit_note", id: nt, body: "changed" });
check(
  "edit_note body-only keeps the title",
  st().notes[0].title === "title" && st().notes[0].body === "changed",
);
check(
  "edit_note with nothing to change is refused",
  await throws(runNotesAction({ action: "edit_note", id: nt })),
);
check(
  "a todo id is not a note id",
  await throws(runNotesAction({ action: "delete_note", id: "td-x" })),
);
await runNotesAction({ action: "delete_note", id: nt });
check("delete_note removes it", st().notes.length === 0);
check("an unknown action is refused", await throws(runNotesAction({ action: "nuke" })));

console.log(
  failed === 0 ? "\nnotes-actions-verify: PASS" : `\nnotes-actions-verify: ${failed} FAILED`,
);
// Exit before the store's 300ms debounced write reaches Tauri, which node lacks.
process.exit(failed === 0 ? 0 : 1);
