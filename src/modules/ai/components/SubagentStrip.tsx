import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkSquare02Icon,
  RobotIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useEffect, useState } from "react";
import { useSubagentRunStore, type SubagentRun } from "../store/subagentRunStore";

type Props = { sessionId: string | null };

const EMPTY_RUNS: SubagentRun[] = [];

/** Tick once a second, but only while something is actually running AND the
 *  strip is visible, so the "running" rows show a live elapsed time without a
 *  permanent (or hidden-but-still-firing) interval. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function SubagentStrip({ sessionId }: Props) {
  const runs =
    useSubagentRunStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ?? EMPTY_RUNS;
  const hidden = useSubagentRunStore((s) => (sessionId ? s.hidden.has(sessionId) : false));
  const hideStrip = useSubagentRunStore((s) => s.hideStrip);

  // Single pass for the header counts (cheaper than three filter scans).
  const counts = runs.reduce(
    (acc, r) => {
      if (r.status === "running") acc.running += 1;
      else if (r.status === "error") acc.failed += 1;
      else acc.done += 1;
      return acc;
    },
    { running: 0, done: 0, failed: 0 },
  );
  const now = useNow(counts.running > 0 && !hidden);

  if (!sessionId || runs.length === 0 || hidden) return null;

  return (
    <div className="border-border/80 bg-muted/20 shrink-0 border-t px-3 py-1.5">
      <div className="my-1.5 flex items-center gap-2">
        <HugeiconsIcon
          icon={RobotIcon}
          size={12}
          strokeWidth={1.75}
          className={cn(
            "shrink-0",
            counts.running > 0 ? "text-icon-working" : "text-muted-foreground",
          )}
        />
        <span className="text-foreground text-[11px] font-medium">Subagents</span>
        <span className="text-muted-foreground flex-1 truncate font-mono text-[11px] tabular-nums">
          {counts.running > 0 ? `${counts.running} running` : `${counts.done} done`}
          {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
        </span>
        <IconTooltip label="Hide subagents" side="top">
          <button
            type="button"
            onClick={() => hideStrip(sessionId)}
            aria-label="Hide subagents"
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
        {runs.map((r) => (
          // Only running rows need the live `now`; finished rows get a stable 0
          // so the memoized row skips re-rendering on every 1s tick.
          <SubagentRow key={r.id} run={r} now={r.status === "running" ? now : 0} />
        ))}
      </ul>
    </div>
  );
}

const SubagentRow = memo(function SubagentRow({ run, now }: { run: SubagentRun; now: number }) {
  const isRunning = run.status === "running";
  const isError = run.status === "error";
  const elapsed = isRunning ? now - run.startedAt : run.durationMs;

  const stats = [
    run.stepCount != null ? `${run.stepCount} step${run.stepCount === 1 ? "" : "s"}` : null,
    elapsed != null ? formatDuration(elapsed) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const row = (
    <li
      className={cn(
        "flex flex-col gap-0.5 rounded px-1.5 py-1 text-[11px] leading-snug",
        isRunning && "border-icon-working/50 bg-muted/40 border-l-2",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          {isRunning ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon
              icon={isError ? AlertCircleIcon : CheckmarkSquare02Icon}
              size={12}
              strokeWidth={1.75}
              className={isError ? "text-destructive" : "text-diff-added"}
            />
          )}
        </span>
        <span className="bg-foreground/10 text-foreground shrink-0 rounded px-1.5 py-0.5 font-mono font-medium">
          {run.type}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isError ? "text-destructive" : isRunning ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {isError ? run.error || "failed" : run.label || "(no label)"}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
          {stats}
        </span>
      </div>
      {/* Live "what it's doing now" line, only while running. */}
      {isRunning && run.currentStep ? (
        <div className="text-muted-foreground/80 truncate pl-[22px] font-mono text-[10px]">
          {run.currentStep}
        </div>
      ) : null}
    </li>
  );

  // Errors get a tooltip with the full message; running/done rows only when a
  // label is present (so the truncated text is recoverable on hover).
  const tip = isError ? run.error : run.label;
  if (!tip) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-80 break-words">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
});

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
