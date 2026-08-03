import { useEffect, useState } from "react";

/** `Date.now()` that re-renders once a second while `active`, then freezes.
 *  One shared ticker shape for every live clock in the AI UI. */
export function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Milliseconds since `active` last flipped true, ticking once a second; 0 while
 *  inactive. This is the proof-of-life behind every "still running" indicator:
 *  a tool that takes 90s (an API request, a slow provider) is indistinguishable
 *  from a frozen app unless something on screen keeps moving. */
export function useElapsedSince(active: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setStartedAt(active ? Date.now() : null);
  }, [active]);
  const now = useLiveNow(active);
  return active && startedAt !== null ? Math.max(0, now - startedAt) : 0;
}

/** Whole-second clock for a RUNNING timer: "8s", "1m 05s". Deliberately coarser
 *  than tool.tsx's `formatDuration` (which keeps sub-second precision for a
 *  FINISHED run): a live counter re-rendered every second must not show a
 *  jittering decimal. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}
