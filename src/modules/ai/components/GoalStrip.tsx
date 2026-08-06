import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { Check, Target, X } from "lucide-react";
import { useEffect } from "react";
import { formatElapsed, useLiveNow } from "../lib/elapsed";
import { goalElapsed } from "../lib/goal";
import { useGoalStore } from "../store/goalStore";

type Props = { sessionId: string | null };

/**
 * The session goal and how long it has been open.
 *
 * The clock ticks off `useLiveNow` against the goal's stored `startedAt` rather
 * than `useElapsedSince`: that hook restarts whenever its flag flips, which
 * would reset the timer on every remount and every session switch back. A goal
 * is measured from when it was SET, across reloads.
 */
export function GoalStrip({ sessionId }: Props) {
  const hydrate = useGoalStore((s) => s.hydrate);
  const goal = useGoalStore((s) => (sessionId ? s.bySession[sessionId] : null));
  const hidden = useGoalStore((s) => (sessionId ? s.hidden.has(sessionId) : false));
  const completeGoal = useGoalStore((s) => s.completeGoal);
  const hideStrip = useGoalStore((s) => s.hideStrip);

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  const running = !!goal && goal.completedAt === null;
  // Hook order is fixed, so tick before any early return.
  const now = useLiveNow(running);

  if (!sessionId || !goal || hidden) return null;

  const elapsed = goalElapsed(goal, now);

  return (
    <div className="border-border/80 bg-muted/20 shrink-0 border-t px-3 py-1.5">
      <div className="my-1.5 flex items-center gap-2">
        <Target
          size={11}
          strokeWidth={2}
          className={cn("shrink-0", running ? "text-foreground" : "text-muted-foreground")}
        />
        <span className="text-foreground text-[11px] font-medium">Goal</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px]",
            running ? "text-muted-foreground" : "text-muted-foreground line-through",
          )}
          title={goal.text}
        >
          {goal.text}
        </span>
        <span
          className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums"
          title={running ? "Time on this goal" : "Time it took"}
        >
          {formatElapsed(elapsed)}
        </span>
        {/* Both controls are for a goal still in flight: mark it done by hand,
            or get the strip out of the way. A finished goal needs neither - it
            closed itself - so the done state is just the text and what it took.
            Clearing it is `/goal clear`, or setting the next goal. */}
        {running && (
          <>
            <IconTooltip label="Mark goal done" side="top">
              <button
                type="button"
                onClick={() => completeGoal(sessionId)}
                aria-label="Mark goal done"
                className={cn(
                  "text-muted-foreground flex size-4 cursor-pointer items-center justify-center rounded",
                  "hover:bg-foreground/10 hover:text-foreground transition-colors",
                )}
              >
                <Check size={10} strokeWidth={2} />
              </button>
            </IconTooltip>
            <IconTooltip label="Hide goal" side="top">
              <button
                type="button"
                onClick={() => hideStrip(sessionId)}
                aria-label="Hide goal"
                className={cn(
                  "text-muted-foreground flex size-4 cursor-pointer items-center justify-center rounded",
                  "hover:bg-destructive/10 hover:text-destructive transition-colors",
                )}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </IconTooltip>
          </>
        )}
      </div>
    </div>
  );
}
