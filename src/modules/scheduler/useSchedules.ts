import { useSyncExternalStore } from "react";
import { scheduler } from "./lib/engine";
import type { Schedule } from "./types";

/** Live list of all schedules: pending plus recent history.
 *
 *  Named for the hook, not `store`: `lib/store.ts` beside it is the PERSISTENCE
 *  layer (the plugin-store file), which is what `store.ts` means everywhere else
 *  in the codebase. Two files by that name in one module read as one thing. */
export function useSchedules(): Schedule[] {
  return useSyncExternalStore(
    (cb) => scheduler.subscribe(cb),
    () => scheduler.getAll(),
    () => scheduler.getAll(),
  );
}
