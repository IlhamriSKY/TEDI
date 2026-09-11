/**
 * The user's own notes and todos on the automation bridge, so an OUTSIDE AI CLI
 * reaches the same list over MCP that TEDI's own agent already reaches through
 * the native `notes_read` / `notes_write` tools (`ai/tools/notes.ts`).
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
 * NOT `todo_write`. That is the AGENT's plan for one turn and lives per session;
 * this is the list the user keeps in the toolbar panel, which outlives every
 * session. Two different lists on purpose - the tool description says so to keep
 * a model off the wrong one.
 *
 * ADD AND COMPLETE ONLY. Like the native tool, it cannot delete or overwrite:
 * removing a person's note is not worth the risk of one misread instruction, and
 * the panel is two keystrokes away for the user who wants it gone.
 *
 * TEXT out, not an object - the other half of "one definition, two transports":
 * a tool result is prose in the model's context either way, so formatting it once
 * here is fewer tokens than pretty-printed JSON and identical on both transports
 * by construction.
 */
import { registerBridge } from "@/modules/automation/bridge";
import { useNotesStore } from "@/modules/notes";

type NotesArgs = {
  action?: string;
  /** add_todo: the checklist line. add_note: the note title. */
  text?: string;
  /** add_note: the note body. Optional. */
  body?: string;
  /** complete_todo: the todo id from `read`. */
  id?: string;
};

/** Both lists as text, with the ids `complete_todo` needs. */
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

async function notes(rawArgs: NotesArgs = {}): Promise<string> {
  const args = rawArgs ?? {};
  const action = args.action ?? "read";
  const s = useNotesStore.getState();
  // Idempotent, and needed: an outside CLI can call before the user has ever
  // opened the panel, so the lists on disk have not been read into the store yet.
  await s.load();

  switch (action) {
    case "read":
      return render();

    case "add_todo": {
      const line = args.text?.trim();
      if (!line) throw new Error("`add_todo` needs `text`.");
      s.addTodo(line);
      return `Added a todo.\n\n${render()}`;
    }

    case "complete_todo": {
      const id = args.id?.trim();
      if (!id) throw new Error("`complete_todo` needs the todo `id` (call `read` for it).");
      if (!useNotesStore.getState().todos.some((t) => t.id === id)) {
        throw new Error(`No todo with id "${id}". Call \`read\` first.`);
      }
      s.setTodoDone(id, true);
      return `Completed ${id}.\n\n${render()}`;
    }

    case "add_note": {
      const title = args.text?.trim();
      if (!title) throw new Error("`add_note` needs `text` (the note title).");
      const id = s.addNote(title);
      if (!id) throw new Error("The note title was empty after trimming.");
      if (args.body) s.updateNote(id, { body: args.body });
      return `Added note ${id}.\n\n${render()}`;
    }

    default:
      throw new Error(
        `Unknown notes action "${action}". Use read, add_todo, complete_todo or add_note.`,
      );
  }
}

registerBridge({ notes });
