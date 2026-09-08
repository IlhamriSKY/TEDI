import { useCallback, useState } from "react";
import { toast } from "@/components/ui/toast";
import { friendlyGhError } from "./gh";

/**
 * Run one labelled `gh` action from a PR view, with the bookkeeping both views
 * need: refuse while another is in flight, toast the outcome, and reload.
 *
 * Shared because `PrReviewView` and `PullRequestsView` had the same fifteen
 * lines each. The reload is deliberately BOTH halves: a `gh` checkout or sync
 * moves HEAD, so the surrounding panel's own status goes stale at the same
 * moment this view's does.
 *
 * `running` is the label of the action in flight, which the caller also renders
 * as the per-button spinner - so it is returned rather than kept private.
 */
export function usePrAction(opts: {
  /** True while the surrounding panel is busy; blocks starting another action. */
  busy?: boolean;
  /** Refresh the surrounding SCM panel. */
  onRefresh: () => void;
  /** Reload this view's own data. */
  load: () => Promise<void>;
}): {
  running: string | null;
  /** True when this view or the panel is busy. */
  busyAll: boolean;
  act: (label: string, fn: () => Promise<void>, done?: string) => Promise<void>;
} {
  const { busy, onRefresh, load } = opts;
  const [running, setRunning] = useState<string | null>(null);

  const act = useCallback(
    async (label: string, fn: () => Promise<void>, done?: string) => {
      if (running || busy) return;
      setRunning(label);
      try {
        await fn();
        toast(done ?? `${label} finished.`, { variant: "success" });
        onRefresh();
        await load();
      } catch (e) {
        toast(friendlyGhError(e), { variant: "error" });
      } finally {
        setRunning(null);
      }
    },
    [running, busy, onRefresh, load],
  );

  return { running, busyAll: Boolean(busy) || running !== null, act };
}
