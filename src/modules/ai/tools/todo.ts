import { tool } from "ai";
import { z } from "zod";
import { newTodoId, validateTodos, type Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";
import type { ToolContext } from "./context";
import { flexArrayReq } from "./schedule";

const TodoStatus = z.enum(["pending", "in_progress", "completed"]);

export function buildTodoTools(ctx: ToolContext) {
  return {
    todo_write: tool({
      description:
        "Replace the task list (for ≥3-step tasks). Exactly one in_progress at a time. Pass the FULL list each call (not a delta). Auto.",
      inputSchema: z.object({
        todos: flexArrayReq(
          z.object({
            id: z
              .string()
              .optional()
              .describe(
                "Stable id; generated if omitted. Reuse ids across calls to keep UI stable.",
              ),
            title: z.string().min(1),
            description: z.string().optional(),
            status: TodoStatus,
          }),
        ).describe("The complete list of todos for this task."),
      }),
      execute: async ({ todos }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active session; cannot persist todos" };

        const normalized: Todo[] = todos.map((t) => ({
          id: t.id ?? newTodoId(),
          title: t.title,
          description: t.description,
          status: t.status,
        }));

        const err = validateTodos(normalized);
        if (err) return { error: err };

        useTodosStore.getState().setTodos(sessionId, normalized);

        return {
          ok: true,
          count: normalized.length,
          inProgress: normalized.find((t) => t.status === "in_progress")?.title ?? null,
        };
      },
    }),
  } as const;
}
