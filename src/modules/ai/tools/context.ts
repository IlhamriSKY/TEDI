import type { BrowserDiag } from "@/modules/browser";
import type { BrowserInfo, TerminalInfo, TerminalTarget } from "@/modules/scheduler/types";
import type { ProviderKeys } from "../lib/keyring";
import type { DynamicModelId, ProviderId } from "../config";

export type ToolContext = {
  /** Active terminal cwd for resolving relative paths. Null means home.
   *  While a turn is pinned (see `pinTurnCwd`), returns the turn-start snapshot
   *  so a mid-turn tab switch can't move the agent to another folder. */
  getCwd: () => string | null;
  /** Workspace (explorer) root. Pinned for the turn alongside the cwd. */
  getWorkspaceRoot: () => string | null;
  /** Freeze `getCwd`/`getWorkspaceRoot` to this turn's snapshot. Called once at
   *  turn start; re-pinned each turn. Mutates the stable session context (no
   *  clone) so `buildTools`' per-ctx cache keeps hitting across turns. */
  pinTurnCwd?: (cwd: string | null, workspaceRoot: string | null) => void;
  /** Last N lines (default 300) of the active terminal buffer, or null if the
   *  active tab isn't a terminal. */
  getTerminalContext: (lines?: number) => string | null;
  /** Type text into the active terminal without executing. Returns false when
   *  there's no active terminal. */
  injectIntoActivePty: (text: string) => boolean;
  /** Open an in-app preview tab at `url`. Returns the new pane's TAB id (resolve
   *  the leaf id the browser tools take via `listBrowsers`), or null on failure. */
  openPreview: (url: string) => number | null;
  /** Snapshot every open in-app browser pane (tabId/leafId/url/isActive). Lets a
   *  tool resolve the leaf id of a pane it just opened with `openPreview`. */
  listBrowsers: () => BrowserInfo[];
  /** Navigate an existing browser pane (leaf id from `listBrowsers`) to a URL.
   *  False if that leaf isn't a browser. */
  navigateBrowser: (leafId: number, url: string) => boolean;
  /** Drive an existing browser pane's history: back / forward / reload. */
  dispatchBrowser: (leafId: number, action: "back" | "forward" | "reload" | "stop") => boolean;
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
  /** Drain a browser pane's captured console errors, warnings, uncaught
   *  exceptions, and unhandled rejections. Null if that leaf isn't a browser. */
  consoleBrowser: (leafId: number) => Promise<BrowserDiag[] | null>;
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
  ) => { ok: true; orientation: "row" | "col"; changed: boolean } | { ok: false; error: string };
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
  /** Provider picked alongside the selected model; disambiguates ids shared by
   *  two providers so a sub-agent inherits the parent's actual provider. */
  getSelectedProvider?: () => ProviderId | undefined;
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

/**
 * Clamp a long string that a tool feeds back into the model's context every
 * step (shell output, background logs, subagent summaries). Keeps the head and
 * the tail - errors usually land at the end, setup/context at the start - so a
 * chatty build or dev server doesn't flood the window. The native layer already
 * hard-caps these; this is the smaller model-facing trim. Returns the input
 * unchanged when it's within `max`.
 */
export function clampForModel(s: string, max = 48 * 1024): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n...[${s.length - max} chars truncated]...\n\n${s.slice(s.length - tail)}`;
}

// Per-path advisory locks so two concurrent odyssey workers doing a
// read-modify-write on the SAME file (edit/multi_edit) can't lose each other's
// update; different paths still run in parallel (the intended worker feature).
const fileLocks = new Map<string, Promise<unknown>>();

/** Serialize async ops keyed by `key` (a normalized path). Advisory: it only
 *  orders callers that go through it, not raw native writes. */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the previous holder settles
  const tail = run.catch(() => {});
  fileLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

/** Normalize a path for scope comparison: forward slashes, collapse `.`/`..`
 *  segments (so `ws/../etc` can't masquerade as inside `ws`), lowercase
 *  (Windows is case-insensitive), and strip a trailing slash. */
function normForScope(p: string): string {
  const fwd = p.replace(/\\/g, "/");
  const drive = (fwd.match(/^[a-zA-Z]:/) ?? [""])[0];
  const isAbs = drive !== "" || fwd.startsWith("/");
  const out: string[] = [];
  for (const seg of fwd.slice(drive.length).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `${drive}${isAbs ? "/" : ""}${out.join("/")}`.toLowerCase().replace(/\/$/, "");
}

/**
 * True when `rawPath` resolves OUTSIDE both the workspace root and the active
 * terminal cwd. Read tools (read_file / list_directory / grep / glob) use it as
 * a `needsApproval` predicate so an out-of-project read prompts the user for
 * consent - a prompt-injection exfil guard - while in-project reads stay auto.
 * Errs toward in-scope (no approval) when scope is undefined or the path can't
 * resolve; the read's own secret deny-list still applies regardless.
 */
export function isReadOutsideScope(rawPath: string, ctx: ToolContext): boolean {
  try {
    if (!rawPath || !rawPath.trim()) return false;
    const abs = normForScope(resolvePath(rawPath, ctx.getCwd()));
    const roots = [ctx.getWorkspaceRoot(), ctx.getCwd()]
      .filter((r): r is string => !!r)
      .map(normForScope)
      .filter((r) => r.length > 0);
    // Fail CLOSED: with no workspace root AND no terminal cwd we can't tell
    // whether a path is "in project", so require approval instead of
    // auto-reading an arbitrary absolute path (prompt-injection exfil guard).
    if (roots.length === 0) return true;
    return !roots.some((r) => abs === r || abs.startsWith(`${r}/`));
  } catch {
    return false;
  }
}

/**
 * True when `rawPath` resolves to a directory that IS, or CONTAINS, the
 * workspace root or the active terminal cwd - i.e. a destructive op on it would
 * wipe or relocate the project you're working in (or a parent of it). Used by
 * `delete_file`/`move_file` to refuse clobbering the working tree's own roots,
 * even though such a path passes the secret/system-dir guards. Errs toward
 * `false` (allow) only when scope is undefined or the path can't resolve.
 */
export function isScopeRootOrAncestor(rawPath: string, ctx: ToolContext): boolean {
  try {
    if (!rawPath || !rawPath.trim()) return false;
    const abs = normForScope(resolvePath(rawPath, ctx.getCwd()));
    const roots = [ctx.getWorkspaceRoot(), ctx.getCwd()]
      .filter((r): r is string => !!r)
      .map(normForScope)
      .filter((r) => r.length > 0);
    // `abs` clobbers a root when it equals that root or is an ancestor of it
    // (the root sits inside `abs`).
    return roots.some((r) => r === abs || r.startsWith(`${abs}/`));
  } catch {
    return false;
  }
}
