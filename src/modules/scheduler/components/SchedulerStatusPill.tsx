import { useEffect, useState } from "react";
import {
  Cancel01Icon,
  Clock04Icon,
  ComputerTerminal02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { scheduler } from "../lib/engine";
import { useSchedules } from "../store";
import type { Schedule } from "../types";

export function SchedulerStatusPill() {
  const schedules = useSchedules();
  const pending = schedules.filter((s) => s.status === "pending");
  if (pending.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${pending.length} scheduled command(s)`}
          className={cn(
            "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            "hover:bg-amber-500/15 flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
          )}
        >
          <HugeiconsIcon icon={Clock04Icon} size={11} strokeWidth={1.75} />
          <span className="tabular-nums">{pending.length} scheduled</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        // Reset the primitive's default `flex flex-col gap-4 rounded-3xl p-4`
        // so the header sits flush at the top and the inner list scrolls
        // cleanly inside the rounded container. Matches SnippetPicker style.
        className="border-border/60 bg-popover/95 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden rounded-lg border p-0 shadow-xl backdrop-blur-xl"
      >
        <div className="border-border/60 bg-muted/30 flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[12px] font-medium">
          <HugeiconsIcon icon={Clock04Icon} size={12} strokeWidth={1.75} />
          <span>Scheduled commands</span>
          <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
            {pending.length} pending
          </span>
        </div>
        <ul
          // max-h-72 + overflow-y-auto: vertical scroll when more than ~6 rows
          // fit. The unified scrollbar style in globals.css picks this up
          // automatically (borderless chrome), so we don't override colors.
          className="flex max-h-72 min-h-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-1"
        >
          {pending.map((s) => (
            <ScheduleRow key={s.id} schedule={s} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ScheduleRow({ schedule }: { schedule: Schedule }) {
  // Tick once a second to update the countdown. Cheap - one timer per visible
  // pending row (auto-cleaned when the row unmounts).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const secs = Math.max(0, Math.round((schedule.fireAt - now) / 1000));
  const target = formatTarget(schedule);
  const label = schedule.label?.trim() || schedule.command;

  return (
    <li className="hover:bg-accent/40 group relative flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors">
      <HugeiconsIcon
        icon={ComputerTerminal02Icon}
        size={12}
        strokeWidth={1.75}
        className="text-muted-foreground mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{label}</span>
        </div>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px]">
          <span className="tabular-nums">in {formatCountdown(secs)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{target}</span>
          <span aria-hidden>·</span>
          <span className="tracking-wide uppercase">{schedule.action}</span>
        </div>
      </div>
      <button
        type="button"
        aria-label="Cancel scheduled command"
        title="Cancel"
        onClick={() => {
          void scheduler.cancel(schedule.id);
        }}
        // Visible at 40% by default so touch users can still tap it; full
        // opacity on row-hover or button-focus for keyboard users.
        className="hover:bg-destructive/10 hover:text-destructive focus-visible:ring-ring/40 text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
      </button>
    </li>
  );
}

function formatCountdown(secs: number): string {
  if (secs <= 0) return "now";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

function formatTarget(s: Schedule): string {
  const t = s.target;
  if (typeof t.ordinal === "number") return `terminal ${t.ordinal}`;
  if (typeof t.leafId === "number") return `leaf ${t.leafId}`;
  if (typeof t.tabId === "number") return `tab ${t.tabId}`;
  if (t.title && t.title.trim()) return `“${t.title.trim()}”`;
  return "active terminal";
}
