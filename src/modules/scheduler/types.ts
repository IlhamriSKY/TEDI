/**
 * Selector for picking a target terminal. The engine resolves the first
 * field present in order: `leafId` > `tabId` > `ordinal` > `title`.
 *
 * - `ordinal` is **1-based** and counts only terminal leaves, left-to-right
 *   in current tab order. "terminal 1" → ordinal: 1.
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
