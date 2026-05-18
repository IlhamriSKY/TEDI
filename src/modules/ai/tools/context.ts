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
  /** Submit a command into the active visible terminal (with newline).
   *  Output stays in the user's terminal tab - distinct from `bash_run`
   *  which executes in a hidden agent shell. Returns false when there is
   *  no active terminal tab. */
  runInActiveTerminal: (command: string) => boolean;
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
