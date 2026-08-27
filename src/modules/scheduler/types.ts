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
  /**
   * The AI CLI running in this pane (`claude`, `codex`, ...), or null.
   *
   * This is how TEDI's own agent learns that another agent is working in the
   * window. Everything needed was already tracked - `PaneLeaf.activeTool` and
   * the OSC 9;4 detector's status store - but none of it reached the snapshot,
   * so the built-in agent was blind to its neighbours while an outside CLI could
   * see it perfectly through the `ai` tool. One field, one direction fixed.
   */
  agent?: string | null;
  /** What that CLI is doing right now: idle, working, or blocked on a prompt.
   *  `blocking` is the one that matters - it means a human is expected to
   *  answer something before that pane moves. */
  agentState?: "idle" | "working" | "blocking" | "done" | null;
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
