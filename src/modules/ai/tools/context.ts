import type { TerminalInfo, TerminalTarget } from "@/modules/scheduler/types";

export type ToolContext = {
  /** Active terminal tab cwd, used to resolve relative paths. Null = home. */
  getCwd: () => string | null;
  /** Workspace root (explorer root). Used by tools that operate over the project. */
  getWorkspaceRoot: () => string | null;
  /** Last N lines (default 300) of the active terminal buffer, or null if
   *  the active tab is not a terminal. Includes prompt, user input, and
   *  command output as the user sees them. */
  getTerminalContext: (lines?: number) => string | null;
  /**
   * Type a string into the active terminal at the prompt - without executing.
   * Returns false if there is no active terminal tab to inject into.
   */
  injectIntoActivePty: (text: string) => boolean;
  /** Open a new preview tab (in-app iframe) at the given URL. */
  openPreview: (url: string) => boolean;
  /** Open a new terminal tab. Optional cwd overrides the inherited cwd
   *  (workspace root). Returns true on success. */
  openTerminal: (cwd?: string | null) => boolean;
  /** Advanced terminal-open: tab vs split, target tab, split direction.
   *  Returns a discriminated union so the tool can surface specific errors. */
  openTerminalAdvanced: (opts: {
    cwd?: string | null;
    mode?: "tab" | "split";
    splitDir?: "row" | "col";
    targetTabId?: number | null;
  }) =>
    | { ok: true; tabId: number; leafId: number | null; mode: "tab" | "split" }
    | { ok: false; error: string };
  /** Collect every open terminal leaf into a single tab (group). Refuses
   *  cleanly when the total count exceeds the per-tab pane cap. */
  consolidateTerminalsIntoGroup: (targetTabId: number) =>
    | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
    | { ok: false; error: string; movedBeforeFailure?: number };
  /** Close a single terminal leaf. If it's the only leaf in its tab the
   *  tab is dropped. Refuses to drop the very last tab. */
  closeTerminalLeaf: (leafId: number) =>
    | { ok: true; closedTab: boolean }
    | { ok: false; error: string };
  /** Submit a command into the active visible terminal (with newline).
   *  Output stays in the user's terminal tab - distinct from `bash_run`
   *  which executes in a hidden agent shell. Returns false when there is
   *  no active terminal tab. */
  runInActiveTerminal: (command: string) => boolean;
  /** Snapshot of every terminal leaf in current tab order. Used by the
   *  scheduler + targeted-injection tools so the AI can address a specific
   *  terminal by ordinal/id/title. */
  listTerminals: () => TerminalInfo[];
  /** Type a string into a specific terminal at the prompt - without executing.
   *  Resolution order: leafId > tabId > ordinal > title (substring, case-
   *  insensitive). Returns false on no-match. */
  injectIntoTerminal: (target: TerminalTarget, text: string) => boolean;
  /** Type + submit (CR) into a specific terminal. Same resolution rules as
   *  injectIntoTerminal. Returns false on no-match. */
  runInTerminal: (target: TerminalTarget, command: string) => boolean;
  /**
   * Set of absolute paths the model has read this session via `read_file`.
   * `edit`/`multi_edit` enforce read-before-edit by checking membership.
   * Mutated as a side effect of successful read_file calls.
   */
  readCache: Set<string>;
  /** Active chat session id - used by tools that persist per-session state (todos). */
  getSessionId: () => string | null;
};

export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath)) return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}
