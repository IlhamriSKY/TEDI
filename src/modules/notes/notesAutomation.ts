/**
 * The user's own notes and todos on the automation bridge, so an OUTSIDE AI CLI
 * reaches the same list over MCP that TEDI's own agent reaches through the native
 * `notes_read` / `notes_write` tools (`ai/tools/notes.ts`).
 *
 * WHY THIS EXISTS SEPARATELY. The native tools live in the ai-native tool module
 * and only the in-app agent has them; an outside CLI driving TEDI over the stdio
 * MCP server had no route to the panel at all - not even to SEE what the user had
 * jotted against the work it was about to do. This is the bridge capability the
 * stdio server calls, exactly the shape `schedule` took
 * (`scheduler/lib/bridge.ts`): one function, registered at module scope so it
 * answers from the moment the window is up, imported for its side effect by
 * `automation/bridgeHost.ts` beside `worktreeAutomation`.
 *
 * ONE IMPLEMENTATION. `notes_write` calls `runNotesAction` too, so the two
 * surfaces cannot disagree about what an action does or which ids it accepts.
 *
 * NOT `todo_write`. That is the AGENT's plan for one turn and lives per session;
 * this is the list the user keeps in the toolbar panel, which outlives every
 * session. Two different lists on purpose - the tool description says so to keep
 * a model off the wrong one.
 *
 * FULL MANAGEMENT, BEHIND THE CARD. It used to be add-and-complete only, which
 * left an agent able to fill the list and never tidy it: a todo it added by
 * mistake stayed until the user deleted it by hand. Every action but `read` still
 * raises an approval card on both surfaces, so a delete is the user's call either
 * way - the card is the gate, not a missing verb.
 *
 * TEXT out, not an object - the other half of "one definition, two transports":
 * a tool result is prose in the model's context either way, so formatting it once
 * here is fewer tokens than pretty-printed JSON and identical on both transports
 * by construction.
 */
import { registerBridge } from "@/modules/automation/bridge";
import { normalizeLine, useNotesStore } from "./store";

export type NotesArgs = {
  action?: string;
  /** Todo actions: the line. Note actions: the title. */
  text?: string;
  /** add_note / edit_note: the note body. */
  body?: string;
  /** The todo or note id from `read`. On `read`, returns that one note in full. */
  id?: string;
};

/** Every action but `read`: the ones that change the list. */
export const NOTES_WRITE_ACTIONS = [
  "add_todo",
  "edit_todo",
  "complete_todo",
  "reopen_todo",
  "delete_todo",
  "clear_done",
  "add_note",
  "edit_note",
  "delete_note",
] as const;

const NOTES_ACTIONS = ["read", ...NOTES_WRITE_ACTIONS];

/** Both lists as text, with the ids every other action takes. */
function render(): string {
  const { notes, todos } = useNotesStore.getState();
  const todoLines = todos.length
    ? todos.map((t) => `[${t.done ? "x" : " "}] ${t.id}\t${t.text}`).join("\n")
    : "  (none)";
  const noteLines = notes.length
    ? notes.map((n) => `${n.id}\t${n.title}${n.body ? "  (+ body)" : ""}`).join("\n")
    : "  (none)";
  return `TODOS\n${todoLines}\n\nNOTES\n${noteLines}`;
}

function needId(args: NotesArgs, action: string): string {
  const id = args.id?.trim();
  if (!id) throw new Error(`\`${action}\` needs \`id\` (call \`read\` for it).`);
  return id;
}

function todoId(args: NotesArgs, action: string): string {
  const id = needId(args, action);
  if (!useNotesStore.getState().todos.some((t) => t.id === id)) {
    throw new Error(`No todo with id "${id}". Call \`read\` first.`);
  }
  return id;
}

function noteId(args: NotesArgs, action: string): string {
  const id = needId(args, action);
  if (!useNotesStore.getState().notes.some((n) => n.id === id)) {
    throw new Error(`No note with id "${id}". Call \`read\` first.`);
  }
  return id;
}

/** Run one action and answer with a sentence plus the lists. Throws with the
 *  reason on a bad call, so both surfaces report the same words. */
export async function runNotesAction(rawArgs: NotesArgs = {}): Promise<string> {
  const args = rawArgs ?? {};
  const action = args.action ?? "read";
  const s = useNotesStore.getState();
  // Idempotent, and needed: an outside CLI can call before the user has ever
  // opened the panel, so the lists on disk have not been read into the store yet.
  await s.load();

  switch (action) {
    case "read": {
      if (!args.id) return render();
      // The list shows only "(+ body)", so this is the one way to see a body -
      // and an agent cannot edit a note it has never read.
      const id = args.id.trim();
      const note = useNotesStore.getState().notes.find((n) => n.id === id);
      if (note) return `${note.id}\t${note.title}\n\n${note.body || "(empty body)"}`;
      const todo = useNotesStore.getState().todos.find((t) => t.id === id);
      if (todo) return `[${todo.done ? "x" : " "}] ${todo.id}\t${todo.text}`;
      throw new Error(`No note or todo with id "${id}". Call \`read\` first.`);
    }

    case "add_todo": {
      if (!normalizeLine(args.text ?? "")) throw new Error("`add_todo` needs `text`.");
      s.addTodo(args.text!);
      return `Added a todo.\n\n${render()}`;
    }

    case "edit_todo": {
      const id = todoId(args, action);
      if (!normalizeLine(args.text ?? "")) throw new Error("`edit_todo` needs the new `text`.");
      s.updateTodo(id, args.text!);
      return `Edited ${id}.\n\n${render()}`;
    }

    case "complete_todo":
    case "reopen_todo": {
      const id = todoId(args, action);
      s.setTodoDone(id, action === "complete_todo");
      return `${action === "complete_todo" ? "Completed" : "Reopened"} ${id}.\n\n${render()}`;
    }

    case "delete_todo": {
      const id = todoId(args, action);
      s.removeTodo(id);
      return `Deleted ${id}.\n\n${render()}`;
    }

    case "clear_done": {
      const n = useNotesStore.getState().todos.filter((t) => t.done).length;
      s.clearDoneTodos();
      return `Cleared ${n} done todo${n === 1 ? "" : "s"}.\n\n${render()}`;
    }

    case "add_note": {
      const id = s.addNote(args.text ?? "");
      if (!id) throw new Error("`add_note` needs `text` (the note title).");
      if (args.body) s.updateNote(id, { body: args.body });
      return `Added note ${id}.\n\n${render()}`;
    }

    case "edit_note": {
      const id = noteId(args, action);
      const patch: { title?: string; body?: string } = {};
      if (args.text !== undefined) {
        const title = normalizeLine(args.text);
        if (!title) throw new Error("`edit_note` got an empty `text`; a note needs a title.");
        patch.title = title;
      }
      if (args.body !== undefined) patch.body = args.body;
      if (!Object.keys(patch).length) {
        throw new Error("`edit_note` needs `text` (new title), `body`, or both.");
      }
      s.updateNote(id, patch);
      return `Edited note ${id}.\n\n${render()}`;
    }

    case "delete_note": {
      const id = noteId(args, action);
      s.removeNote(id);
      return `Deleted note ${id}.\n\n${render()}`;
    }

    default:
      throw new Error(`Unknown notes action "${action}". Use ${NOTES_ACTIONS.join(", ")}.`);
  }
}

registerBridge({ notes: runNotesAction });
