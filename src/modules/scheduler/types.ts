/**
 * Selector for picking a target terminal. The engine resolves the first
 * field present in order: `leafId` > `tabId` > `ordinal` > `title`.
 *
 * - `ordinal` is the leaf's stable FIFO `terminalOrdinal` — the same 1-based
 *   number rendered on the TabBar chip. Assigned at creation and preserved
 *   across closes, drags, and workspace restarts (so "terminal 3" maps to
 *   the chip the user sees, not to the leaf's current position).
 * - `title` does a case-insensitive substring match against the tab title.
 * - All fields optional; an empty target falls back to the active terminal.
 */
export type TerminalTarget = {
  leafId?: number;
  tabId?: number;
  ordinal?: number;
  title?: string;
};

/** Snapshot row returned by `listTerminals`. */
export type TerminalInfo = {
  tabId: number;
  leafId: number;
  ordinal: number;
  title: string;
  cwd: string | null;
  isActive: boolean;
};

export type ScheduleAction = "inject" | "submit";

export type ScheduleStatus = "pending" | "fired" | "failed" | "cancelled";

export type Schedule = {
  id: string;
  fireAt: number;
  command: string;
  action: ScheduleAction;
  target: TerminalTarget;
  label?: string;
  createdAt: number;
  status: ScheduleStatus;
  firedAt?: number;
  error?: string;
};
