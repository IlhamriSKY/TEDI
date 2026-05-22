import { useMemo, useSyncExternalStore } from "react";
import { scheduler } from "./lib/engine";
import type { Schedule } from "./types";

/** Live list of all schedules: pending plus recent history. */
export function useSchedules(): Schedule[] {
  return useSyncExternalStore(
    (cb) => scheduler.subscribe(cb),
    () => scheduler.getAll(),
    () => scheduler.getAll(),
  );
}

/** Pending-only selector. Memoized so the filter result stays stable for `useSyncExternalStore`. */
export function usePendingSchedules(): Schedule[] {
  const all = useSchedules();
  return useMemo(() => all.filter((s) => s.status === "pending"), [all]);
}
