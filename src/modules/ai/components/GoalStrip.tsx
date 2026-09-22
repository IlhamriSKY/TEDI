import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Check, Pause, Play, Target, X } from "lucide-react";
import { useEffect } from "react";
import { formatElapsed, useLiveNow } from "../lib/elapsed";
import { goalElapsed } from "../lib/goal";
import { disarmGoalRun, goalRunStatus, pauseGoalRun } from "../lib/goalRunner";
import { resumeGoal } from "../lib/slashCommands";
import { toast } from "@/components/ui/toast";
import { useGoalStore } from "../store/goalStore";

type Props = { sessionId: string | null };

const BTN = cn(
  "text-muted-foreground flex size-4 cursor-pointer items-center justify-center rounded",
  "hover:bg-foreground/10 hover:text-foreground transition-colors",
);

/**
 * The session goal, how long it has been open, and what its loop is doing.
 *
 * The clock ticks off `useLiveNow` against the goal's stored `startedAt` rather
 * than `useElapsedSince`: that hook restarts whenever its flag flips, which
 * would reset the timer on every remount and every session switch back. A goal
 * is measured from when it was SET, across reloads.
 *
 * The run state (turn count, evaluator in flight, paused and why) comes from the
 * store the loop itself writes, so the strip never claims a goal is running
 * when nothing will continue it.
 */
export function GoalStrip({ sessionId }: Props) {
  const hydrate = useGoalStore((s) => s.hydrate);
  const goal = useGoalStore((s) => (sessionId ? s.bySession[sessionId] : null));
  const run = useGoalStore((s) => (sessionId ? s.runs[sessionId] : undefined));
  const hidden = useGoalStore((s) => (sessionId ? s.hidden.has(sessionId) : false));
  const completeGoal = useGoalStore((s) => s.completeGoal);
  const clearGoal = useGoalStore((s) => s.clearGoal);

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  const open = !!goal && goal.completedAt === null;
  // Hook order is fixed, so tick before any early return.
  const now = useLiveNow(open);

  if (!sessionId || !goal || hidden) return null;

  const elapsed = goalElapsed(goal, now);
  const armed = open && !!run && !run.paused;
  // Null until there is something to say: a just-set goal shows no turn count.
  const status = goalRunStatus(run, open);

  return (
    <div className="border-border/80 bg-muted/20 shrink-0 border-t px-3 py-1.5">
      <div className="my-1.5 flex items-center gap-2">
        <Target
          size={11}
          strokeWidth={2}
          className={cn("shrink-0", armed ? "text-foreground" : "text-muted-foreground")}
        />
        <span className="text-foreground text-[11px] font-medium">Goal</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[11px]",
                open ? "text-muted-foreground" : "text-muted-foreground line-through",
              )}
            >
              {goal.text}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-80 whitespace-pre-line">
            {goal.text}
            {run?.reason ? `\n\nLast check: ${run.reason}` : ""}
          </TooltipContent>
        </Tooltip>
        {status && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground shrink-0 text-[10.5px]">{status}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80">
              {run?.reason ?? (armed ? "Working on it" : "Not running. /goal or ▶ resumes it.")}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
              {formatElapsed(elapsed)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{open ? "Time on this goal" : "Time it took"}</TooltipContent>
        </Tooltip>
        {/* Controls are for a goal still open. A finished goal closed itself, so
            the done state is just the text and what it took; `/goal clear` or
            the next goal removes it. */}
        {open && (
          <>
            <IconTooltip label={armed ? "Pause goal" : "Resume goal"} side="top">
              <button
                type="button"
                onClick={() => {
                  if (armed) return pauseGoalRun(sessionId, "paused by you");
                  const err = resumeGoal(sessionId);
                  if (err) toast(err, { variant: "warning" });
                }}
                aria-label={armed ? "Pause goal" : "Resume goal"}
                className={BTN}
              >
                {armed ? <Pause size={10} strokeWidth={2} /> : <Play size={10} strokeWidth={2} />}
              </button>
            </IconTooltip>
            <IconTooltip label="Mark goal done" side="top">
              <button
                type="button"
                onClick={() => {
                  disarmGoalRun(sessionId);
                  completeGoal(sessionId);
                }}
                aria-label="Mark goal done"
                className={BTN}
              >
                <Check size={10} strokeWidth={2} />
              </button>
            </IconTooltip>
            <IconTooltip label="Clear goal" side="top">
              <button
                type="button"
                onClick={() => {
                  disarmGoalRun(sessionId);
                  clearGoal(sessionId);
                }}
                aria-label="Clear goal"
                className={cn(BTN, "hover:bg-destructive/10 hover:text-destructive")}
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
