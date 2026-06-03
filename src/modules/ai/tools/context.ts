import type { TerminalInfo, TerminalTarget } from "@/modules/scheduler/types";
import type { ProviderKeys } from "../lib/keyring";
import type { DynamicModelId } from "../config";

export type ToolContext = {
  /** Active terminal cwd for resolving relative paths. Null means home. */
  getCwd: () => string | null;
  /** Workspace (explorer) root. */
  getWorkspaceRoot: () => string | null;
  /** Last N lines (default 300) of the active terminal buffer, or null if the
   *  active tab isn't a terminal. */
  getTerminalContext: (lines?: number) => string | null;
  /** Type text into the active terminal without executing. Returns false when
   *  there's no active terminal. */
  injectIntoActivePty: (text: string) => boolean;
  /** Open an in-app preview tab at `url`. */
  openPreview: (url: string) => boolean;
  /** Navigate an existing browser pane (leaf id from `listBrowsers`) to a URL.
   *  False if that leaf isn't a browser. */
  navigateBrowser: (leafId: number, url: string) => boolean;
  /** Drive an existing browser pane's history: back / forward / reload. */
  dispatchBrowser: (leafId: number, action: "back" | "forward" | "reload") => boolean;
  /** Read an existing browser pane's rendered text (title + visible body).
   *  With `fields` also lists tagged interactive controls as `[N]`. Null if
   *  that leaf isn't a browser. */
  readBrowser: (leafId: number, fields?: boolean) => Promise<string | null>;
  /** Type into / click an interactive control (by its `[N]` index from a
   *  `readBrowser(_, true)`) of a browser pane. Returns the raw result string
   *  ("ok" / "not-found" / ...), or null if that leaf isn't a browser. */
  actBrowser: (
    leafId: number,
    index: number,
    action: "click" | "type" | "hover" | "key" | "scroll" | "clickxy",
    text: string,
    submit: boolean,
  ) => Promise<string | null>;
  /** Capture a browser pane as a base64 JPEG (last-resort visual). Null if that
   *  leaf isn't a browser. */
  screenshotBrowser: (leafId: number) => Promise<string | null>;
  /** Open a new terminal tab. Optional cwd overrides the inherited cwd. */
  openTerminal: (cwd?: string | null) => boolean;
  /** Advanced terminal-open: tab vs split, target tab, split direction. */
  openTerminalAdvanced: (opts: {
    cwd?: string | null;
    mode?: "tab" | "split";
    splitDir?: "row" | "col";
    targetTabId?: number | null;
  }) =>
    | { ok: true; tabId: number; leafId: number | null; mode: "tab" | "split" }
    | { ok: false; error: string };
  /** Move every terminal leaf into one tab. Refuses if total exceeds the
   *  per-tab pane cap. */
  consolidateTerminalsIntoGroup: (
    targetTabId: number,
  ) =>
    | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
    | { ok: false; error: string; movedBeforeFailure?: number };
  /** Merge the given pane leaves (any kind: terminal/editor/browser) into one
   *  tab as splits - the AI-driven form of the user's "Join Group". Destination
   *  defaults to the first leaf's tab. Refuses past the per-tab pane cap. */
  groupLeavesIntoTab: (
    leafIds: number[],
    targetTabId?: number,
  ) =>
    | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
    | { ok: false; error: string };
  /** Change a pane's split orientation within its group (the user's "Rotate
   *  split"). With `direction` ("row" = beside, "col" = stacked) it sets that
   *  orientation idempotently; without it, toggles. */
  rotatePaneSplit: (
    leafId: number,
    direction?: "row" | "col",
  ) =>
    | { ok: true; orientation: "row" | "col"; changed: boolean }
    | { ok: false; error: string };
  /** Close one terminal leaf; drops the tab if it was the only leaf. Refuses
   *  the last tab. */
  closeTerminalLeaf: (
    leafId: number,
  ) => { ok: true; closedTab: boolean } | { ok: false; error: string };
  /** Submit a command (CR appended) into the active visible terminal. Output
   *  stays in the user's terminal, unlike `bash_run` which uses a hidden shell. */
  runInActiveTerminal: (command: string) => boolean;
  /** Snapshot every terminal leaf in tab order. */
  listTerminals: () => TerminalInfo[];
  /** Type into a specific terminal without executing. Resolves leafId, then
   *  tabId, then ordinal, then title substring (case-insensitive). */
  injectIntoTerminal: (target: TerminalTarget, text: string) => boolean;
  /** Type and submit into a specific terminal. Same resolution as injectIntoTerminal. */
  runInTerminal: (target: TerminalTarget, command: string) => boolean;
  /** True when the resolved terminal is busy (running a command or in a TUI
   *  alt-screen). Empty/missing target falls back to the active terminal. */
  isTerminalBusy: (target?: TerminalTarget) => boolean;
  /** Absolute paths read this session via `read_file`. `edit`/`multi_edit`
   *  enforce read-before-edit by checking membership. */
  readCache: Set<string>;
  /** Active chat session id. Used by tools that persist per-session state. */
  getSessionId: () => string | null;
  /** Provider API keys + selected model, read lazily so tools never import the
   *  chat store (which would close a store -> lib -> tools -> store import cycle).
   *  Used by `run_subagent` to spawn with the parent agent's credentials. */
  getApiKeys: () => ProviderKeys;
  getSelectedModelId: () => DynamicModelId;
  /** Fires when the agent loop is cancelled (Stop, session deleted, provider
   *  error). Tools should bail early. Undefined means never-aborted. */
  abortSignal?: AbortSignal;
};

/** Throws an AbortError-shaped error if the signal has fired. Call between
 *  IPC steps so cancellation takes effect promptly. */
export function throwIfAborted(ctx: ToolContext): void {
  if (ctx.abortSignal?.aborted) {
    const reason = ctx.abortSignal.reason ?? "aborted";
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath)) return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

/**
 * Strip home and workspace prefixes from an error string so tool failures
 * don't leak local filesystem layout back to the LLM.
 *   read failed: ENOENT 'D:\Users\Bob\Project\src\app.ts'
 *   -> read failed: ENOENT '<workspace>/src/app.ts'
 * Falls back to masking `C:\Users\<name>\` when the workspace isn't set.
 */
export function scrubErrorPath(e: unknown, ctx: ToolContext): string {
  let msg = e instanceof Error ? e.message : String(e);
  const root = ctx.getWorkspaceRoot();
  if (root) {
    const norm = root.replace(/\\/g, "/").replace(/\/$/, "");
    // Replace both slash variants of the workspace root.
    const escSlash = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escBack = norm.replace(/\//g, "\\\\").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    msg = msg.replace(new RegExp(escSlash, "gi"), "<workspace>");
    msg = msg.replace(new RegExp(escBack, "gi"), "<workspace>");
  }
  // Generic home masking fallback.
  msg = msg.replace(/[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/]+/g, "<home>");
  msg = msg.replace(/\/(?:Users|home)\/[^/]+/g, "<home>");
  return msg;
}
