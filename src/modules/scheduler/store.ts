import { useMemo, useSyncExternalStore } from "react";
import { scheduler } from "./lib/engine";
import type { Schedule } from "./types";

/** Live list of all schedules (pending + recent history). */
export function useSchedules(): Schedule[] {
  return useSyncExternalStore(
    (cb) => scheduler.subscribe(cb),
    () => scheduler.getAll(),
    () => scheduler.getAll(),
  );
}

/** Pending-only convenience selector. Derived via useMemo to avoid breaking
 *  `useSyncExternalStore`'s referential-equality contract (filter creates a
 *  fresh array each call). */
export function usePendingSchedules(): Schedule[] {
  const all = useSchedules();
  return useMemo(() => all.filter((s) => s.status === "pending"), [all]);
}
