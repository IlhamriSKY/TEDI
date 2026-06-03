/**
 * Selector for a target terminal. Resolved in order: `leafId`, `tabId`,
 * `ordinal`, `title`. `ordinal` is the 1-based FIFO `terminalOrdinal` shown
 * on the TabBar chip and preserved across closes, drags, and restarts.
 * `title` is case-insensitive substring match. Empty target falls back to
 * the active terminal.
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

/** Snapshot row returned by `listBrowsers` - one open in-app browser pane. */
export type BrowserInfo = {
  tabId: number;
  leafId: number;
  /** Current page URL. */
  url: string;
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
