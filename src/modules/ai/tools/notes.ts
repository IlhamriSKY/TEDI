/**
 * The user's OWN notes and todo list, as tools.
 *
 * Not to be confused with `todo_write`, which is the agent's plan for the
 * current turn and lives per AI session. This pair reaches the list the user
 * keeps in the toolbar panel, which outlives every session. Both exist on
 * purpose; the descriptions below are what keeps the model from reaching for
 * the wrong one.
 *
 * Two tools, not six. The tool list is re-sent on every request, so each name
 * is a standing token cost - a read and a small op-tagged write buy the whole
 * surface for two.
 *
 * `notes_write` can add and complete, and CANNOT delete or overwrite. Deleting
 * a person's note is not a thing worth the risk of a misread instruction, and
 * the panel is two keystrokes away for the user who really wants it gone.
 */
import { tool } from "ai";
import { z } from "zod";

import { useNotesStore } from "@/modules/notes";

export function buildNotesTools(opts: { autoApprove?: boolean } = {}) {
  // Mirrors the edit tools: the main agent raises an approval card, an
  // autonomous worker subagent (no approver in its loop) executes directly.
  const needsApproval = opts.autoApprove ? false : true;

  /** The panel loads itself on mount, but the agent can run before the user has
   *  ever opened it. `load` is idempotent, so this just guarantees the lists are
   *  the ones on disk rather than the empty pre-load state. */
  const ready = async () => {
    await useNotesStore.getState().load();
    return useNotesStore.getState();
  };

  return {
    notes_read: tool({
      description:
        "Read the user's own saved notes and todo list (the toolbar panel), which persists across sessions. Returns ids needed by notes_write. This is NOT your per-turn plan - that is todo_write. Read-only, auto.",
      inputSchema: z.object({}),
      execute: async () => {
        const { notes, todos } = await ready();
        return {
          todos: todos.map((t) => ({ id: t.id, text: t.text, done: t.done })),
          notes: notes.map((n) => ({ id: n.id, title: n.title, body: n.body })),
        };
      },
    }),

    notes_write: tool({
      description:
        "Add a todo, complete a todo, or add a note to the user's own saved list. Call notes_read first to get an id for complete_todo. Cannot delete or overwrite anything. Approval.",
      inputSchema: z.object({
        op: z.enum(["add_todo", "complete_todo", "add_note"]),
        text: z
          .string()
          .optional()
          .describe("The todo line for add_todo, or the note title for add_note."),
        body: z.string().optional().describe("Note body. add_note only; optional."),
        id: z.string().optional().describe("Todo id from notes_read. complete_todo only."),
      }),
      needsApproval,
      execute: async ({ op, text, body, id }) => {
        const state = await ready();

        if (op === "complete_todo") {
          if (!id) return { error: "complete_todo needs `id`; call notes_read for it" };
          if (!state.todos.some((t) => t.id === id)) return { error: `no todo with id "${id}"` };
          state.setTodoDone(id, true);
          return { ok: true, op, id };
        }

        const line = text?.trim();
        if (!line) return { error: `${op} needs \`text\`` };

        if (op === "add_todo") {
          state.addTodo(line);
          return { ok: true, op, text: line };
        }

        // add_note
        const noteId = state.addNote(line);
        if (!noteId) return { error: "note title was empty after trimming" };
        if (body) state.updateNote(noteId, { body });
        return { ok: true, op, id: noteId, title: line };
      },
    }),
  } as const;
}
