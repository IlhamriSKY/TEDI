import { create } from "zustand";
import type { AiCliStatus } from "./aiCliStatus";

/**
 * Per-leaf AI CLI status (idle / working / blocking), written directly by the
 * session's detector for the term's whole life - NOT the attach-bound
 * `onAiCliStatus` callback chain, which `detachSession` clears the moment a
 * workspace goes inactive. A running agent's detector keeps ticking on the live
 * session even while its workspace is hidden, so a reactive store keeps the
 * status alive for the Workspaces panel: a non-active workspace's terminal row
 * still shows the spinner instead of falling back to a dead grey icon. Mirrors
 * {@link useTerminalTitles}. Keyed by pane-leaf id; the entry is cleared on
 * session disposal.
 *
 * The App-level `aiCliStatuses` map (callback chain) still drives the tab dot,
 * header indicator, and toast/beep transitions for the active workspace; this
 * store is the sidebar's live, attach-independent source.
 */
type AiCliStatusesState = {
  statuses: Record<number, NonNullable<AiCliStatus>>;
  setStatus: (leafId: number, status: AiCliStatus) => void;
  clearStatus: (leafId: number) => void;
};

export const useAiCliStatuses = create<AiCliStatusesState>((set) => ({
  statuses: {},
  setStatus: (leafId, status) =>
    set((s) => {
      // A null status means no AI CLI is running - drop the entry.
      if (!status) {
        if (!(leafId in s.statuses)) return s;
        const next = { ...s.statuses };
        delete next[leafId];
        return { statuses: next };
      }
      // Only tool + state drive the sidebar icon; ignore `since`-only churn so
      // a re-emit of the same state doesn't re-render every workspace row.
      const prev = s.statuses[leafId];
      if (prev && prev.tool === status.tool && prev.state === status.state) return s;
      return { statuses: { ...s.statuses, [leafId]: status } };
    }),
  clearStatus: (leafId) =>
    set((s) => {
      if (!(leafId in s.statuses)) return s;
      const next = { ...s.statuses };
      delete next[leafId];
      return { statuses: next };
    }),
}));
