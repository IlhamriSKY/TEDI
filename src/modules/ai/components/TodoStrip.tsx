import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Cancel01Icon, CheckmarkSquare02Icon, SquareIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import type { Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";

type Props = { sessionId: string | null };

const EMPTY_TODOS: Todo[] = [];

export function TodoStrip({ sessionId }: Props) {
  const hydrate = useTodosStore((s) => s.hydrate);
  const todos =
    useTodosStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ?? EMPTY_TODOS;
  const hidden = useTodosStore((s) => (sessionId ? s.hidden.has(sessionId) : false));
  const hideStrip = useTodosStore((s) => s.hideStrip);

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  if (!sessionId || todos.length === 0 || hidden) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const pct = Math.round((completed / todos.length) * 100);

  return (
    <div className="border-border/80 bg-muted/20 shrink-0 border-t px-3 py-1.5">
      <div className="my-1.5 flex items-center gap-2">
        <span className="text-foreground text-[11px] font-medium">Todos</span>
        <Progress value={pct} className="h-1 flex-1" />
        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
          {completed}/{todos.length}
        </span>
        <IconTooltip label="Hide todos" side="top">
          <button
            type="button"
            onClick={() => hideStrip(sessionId)}
            aria-label="Hide todos"
            className={cn(
              "text-muted-foreground flex size-4 cursor-pointer items-center justify-center rounded",
              "hover:bg-destructive/10 hover:text-destructive transition-colors",
            )}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
          </button>
        </IconTooltip>
      </div>
      <ul className="flex flex-col gap-0.5">
        {todos.map((t) => (
          <TodoRow key={t.id} todo={t} />
        ))}
      </ul>
    </div>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const isInProgress = todo.status === "in_progress";
  const row = (
    <li
      className={cn(
        "flex items-start gap-2 rounded px-1.5 py-1 text-[11px] leading-snug",
        isInProgress && "border-foreground/50 bg-muted/40 border-l-2",
      )}
    >
      <span className="mt-[2px] inline-flex size-3.5 shrink-0 items-center justify-center">
        {isInProgress ? (
          <Spinner className="size-3" />
        ) : (
          <HugeiconsIcon
            icon={todo.status === "completed" ? CheckmarkSquare02Icon : SquareIcon}
            strokeWidth={1.75}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          todo.status === "completed"
            ? "text-muted-foreground/60 line-through"
            : isInProgress
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {todo.title}
      </span>
    </li>
  );

  if (!todo.description) return row;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="left">{todo.description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
