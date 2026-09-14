/**
 * The user's OWN notes and todo list, as tools.
 *
 * Not to be confused with `todo_write`, which is the agent's plan for the
 * current turn and lives per AI session. This pair reaches the list the user
 * keeps in the toolbar panel, which outlives every session. Both exist on
 * purpose; the descriptions below are what keeps the model from reaching for
 * the wrong one.
 *
 * Two tools, not ten. The tool list is re-sent on every request, so each name
 * is a standing token cost - a read and a small op-tagged write buy the whole
 * surface for two.
 *
 * `notes_write` runs the SAME `runNotesAction` the MCP `notes` tool does, so the
 * two cannot drift. It can add, edit, complete, reopen and delete; every op
 * raises an approval card, which is what keeps a delete the user's call.
 */
import { tool } from "ai";
import { z } from "zod";

import { useNotesStore } from "@/modules/notes";
import { NOTES_WRITE_ACTIONS, runNotesAction } from "@/modules/notes/notesAutomation";

export function buildNotesTools(opts: { autoApprove?: boolean } = {}) {
  // Mirrors the edit tools: the main agent raises an approval card, an
  // autonomous worker subagent (no approver in its loop) executes directly.
  const needsApproval = opts.autoApprove ? false : true;

  return {
    notes_read: tool({
      description:
        "Read the user's own saved notes and todo list (the toolbar panel), which persists across sessions. Returns ids needed by notes_write. This is NOT your per-turn plan - that is todo_write. Read-only, auto.",
      inputSchema: z.object({}),
      execute: async () => {
        // The panel loads itself on mount, but the agent can run before the user
        // has ever opened it. `load` is idempotent.
        await useNotesStore.getState().load();
        const { notes, todos } = useNotesStore.getState();
        return {
          todos: todos.map((t) => ({ id: t.id, text: t.text, done: t.done })),
          notes: notes.map((n) => ({ id: n.id, title: n.title, body: n.body })),
        };
      },
    }),

    notes_write: tool({
      description:
        "Manage the user's own saved notes and todos: add, edit, complete, reopen or delete a todo, clear done todos, add, edit or delete a note. Ids come from notes_read. Approval.",
      inputSchema: z.object({
        op: z.enum(NOTES_WRITE_ACTIONS),
        id: z.string().optional().describe("Todo or note id from notes_read."),
        text: z.string().optional().describe("Todo line, or note title."),
        body: z.string().optional().describe("Note body. add_note / edit_note."),
      }),
      needsApproval,
      execute: async ({ op, id, text, body }) => {
        try {
          return await runNotesAction({ action: op, id, text, body });
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),
  } as const;
}
