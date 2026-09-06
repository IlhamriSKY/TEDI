/**
 * TEDI extension API - public type definitions.
 *
 * This file is the typed contract for `activate(ctx)`. It is standalone (no
 * imports, no dependencies), so an extension gets full IntelliSense and
 * `// @ts-check` diagnostics in any TypeScript-aware editor with nothing
 * installed.
 *
 * ## Use it from plain JavaScript
 *
 * ```js
 * /** @param {import("./tedi").ExtensionContext} ctx *\/
 * export async function activate(ctx) {
 *   ctx.ui.toast("hello");        // <- autocompleted and type-checked
 * }
 * ```
 *
 * With the `jsconfig.json` the scaffolder writes (`checkJs: true`), a typo
 * like `ctx.ui.tost(...)` is a red squiggle before you ever build.
 *
 * ## Use it from TypeScript
 *
 * ```ts
 * import type { ExtensionContext } from "./tedi";
 * export async function activate(ctx: ExtensionContext): Promise<void> {}
 * ```
 *
 * ## Where this file comes from
 *
 * `tedi ext types` writes a copy of this file next to your `manifest.json`,
 * taken from the TEDI binary you are running - so the types you code against
 * always describe the host you are testing on. Re-run it after upgrading TEDI
 * to pick up newly added API.
 *
 * ## Stability
 *
 * The API is **additive only**. A member documented here is never removed or
 * renamed; superseded members are marked `@deprecated` and keep working.
 * Anything added after your `engines.tedi` floor should be feature-detected:
 *
 * ```js
 * if (ctx.headerBar) ctx.headerBar.setItem({ ... });
 * ```
 *
 * @see extensions/README.md for the prose guide and permission reference.
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/** Returned by every subscribe-style call. Idempotent; safe to call twice. */
export type Disposer = () => void;

/**
 * Result shapes for the Rust commands extensions call most, so
 * `ctx.invoke("shell_bg_logs", ...)` gives you something with fields on it
 * instead of `unknown`:
 *
 * ```js
 * const logs = await ctx.invoke("shell_bg_logs", { handle, sinceOffset: 0 });
 * logs.bytes;        // string     - completed, checked
 * logs.exit_code;    // number|null
 * ```
 *
 * Any command NOT listed here still works exactly the same and resolves to
 * `unknown`; narrow it yourself with a JSDoc cast when you need to.
 *
 * The list is short on purpose. Each entry is transcribed from the Rust
 * `#[derive(Serialize)]` struct that produces it, casing included, and a
 * verify script in the TEDI repo reads those structs back and fails if the
 * two ever disagree. A shape guessed from memory would be a type that lies,
 * which is worse than no type at all.
 */
export type InvokeResults = {
  /** Run a one-shot command through the user's login shell. */
  shell_run_command: {
    stdout: string;
    stderr: string;
    /** `null` when the process was killed rather than exiting. */
    exit_code: number | null;
    timed_out: boolean;
    /** Output hit the cap and was cut. */
    truncated: boolean;
  };
  /** Spawn a background process without a shell. Resolves to its handle. */
  shell_bg_spawn_direct: number;
  /** Read a background process's output from `sinceOffset`. */
  shell_bg_logs: {
    bytes: string;
    /** Pass back as `sinceOffset` on the next poll. */
    next_offset: number;
    /** Bytes lost to the ring buffer between polls. */
    dropped: number;
    exited: boolean;
    exit_code: number | null;
  };
  shell_bg_kill: null;
  shell_bg_list: {
    handle: number;
    command: string;
    cwd: string | null;
    started_at_ms: number;
    exited: boolean;
    exit_code: number | null;
  }[];
  /** Tagged union - switch on `kind`. */
  fs_read_file:
    | { kind: "text"; content: string; size: number }
    | { kind: "image"; dataUrl: string; mime: string; size: number }
    | { kind: "binary"; size: number }
    | { kind: "toolarge"; size: number; limit: number };
  fs_glob: { hits: { path: string; rel: string }[]; truncated: boolean };
  ssh_list_sessions: {
    id: number;
    host: string;
    user: string;
    cols: number;
    rows: number;
    alive: boolean;
    createdAtMs: number;
  }[];
};

/**
 * `ctx.invoke`'s two call signatures. A literal command string from
 * {@link InvokeResults} picks up the typed overload; anything else falls
 * through to the generic one.
 */
export type InvokeFn = {
  <K extends keyof InvokeResults>(
    command: K,
    args?: Record<string, unknown>,
  ): Promise<InvokeResults[K]>;
  <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
};

/** Entry point. Exported from your `manifest.main` bundle as `activate`. */
export type ActivateFn = (ctx: ExtensionContext) => void | Promise<void>;

/** Optional counterpart to {@link ActivateFn}. Must be idempotent. */
export type DeactivateFn = () => void | Promise<void>;

/** Static OS snapshot exposed as `ctx.os`. Resolved once at load. */
export type ExtensionOs = {
  platform: "windows" | "macos" | "linux" | "ios" | "android" | "unknown";
  arch: "x86_64" | "aarch64" | "x86" | "arm" | "unknown";
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/** One live terminal, as seen by `AppContextSnapshot.terminals`. */
export type AppContextTerminal = {
  /** Daemon PTY id, or `ssh:<id>` for an SSH session. */
  ptyId: string;
  /** The tab's FIFO number, the same one the desktop UI shows. */
  ordinal: number;
  /** AI-CLI run state, when a tool is detected on that terminal. */
  state?: "idle" | "working" | "blocking";
  /** Host-captured, glyph-stripped OSC 0/2 window title. Prefer this over
   *  re-deriving a title from the byte stream. */
  title?: string;
  /** True when the tab this terminal lives in is pinned. */
  pinned?: boolean;
  /** The user's own name for the tab (absent = the derived one). Kept separate
   *  from `title`, which is whatever a running program set as its window
   *  title. */
  customTitle?: string;
  wsId?: string;
  wsName?: string;
  wsActive?: boolean;
};

/** Read-only view of app state. See `ctx.app.getContext()`. */
export type AppContextSnapshot = {
  workspaceCwd: string | null;
  activeFileName: string | null;
  /** Terminal leaves in the ACTIVE workspace. Prefer `terminalCountAll` when
   *  "all open terminals" is what you mean. */
  terminalCount: number;
  /** Kind of the focused tab. `null` when no tab is active. */
  /** `"browser"` is not reported: a browser is an extension, so its pane
   *  reports `"ext"` like any other. Kept in the union so an extension that
   *  branches on it still type-checks. */
  activeTabKind: "terminal" | "ssh" | "editor" | "diff" | "browser" | "ext" | null;
  /** Workspaces the user has open. Always >= 1. */
  workspaceCount: number;
  /** Terminal leaves summed across every workspace. */
  terminalCountAll: number;
  /** Every terminal with a live PTY, across all workspaces visited this run. */
  terminals: AppContextTerminal[];
};

/** Read-only view of the AI agent. See `ctx.ai.getState()`. */
export type AiStateSnapshot = {
  /** Currently selected model id, as shown in the chat dropdown. */
  modelId: string;
  /** Provider that owns `modelId`. Pass this back to `setModel`. */
  provider: string;
  status: "idle" | "thinking" | "streaming" | "awaiting-approval" | "error";
  /** Human-readable current step while running, else `null`. */
  step: string | null;
  approvalsPending: number;
  /** Cumulative tokens for the active session (TEDI's own BYOK agent). */
  usage: { input: number; output: number; cached: number };
  activeSessionId: string | null;
  /** The user's safety posture. Read-only by design - there is deliberately
   *  no `setApprovalMode`. */
  approvalMode: "ask" | "semi" | "yolo";
  /** Whether the agent may delegate to sub-agents. */
  subagentsEnabled: boolean;
  /** Whether a key is configured for `modelId`'s provider. The key itself is
   *  never exposed. */
  hasKey: boolean;
};

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** The focused editor leaf's live buffer. `ctx.editor.getActive()`. */
export type ActiveEditorSnapshot = {
  /** Absolute path of the file in the active editor leaf. */
  path: string;
  /** Live (possibly unsaved) buffer content. */
  content: string;
  /** True when the buffer diverges from the last-saved disk content. */
  dirty: boolean;
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Lifecycle tone for an extension tab / pane title.
 * `connecting`/`reconnecting` pulse amber, `connected` is green,
 * `disconnected`/`error` are red, `idle` is the default.
 */
export type ExtensionTabState =
  "idle" | "connecting" | "reconnecting" | "connected" | "disconnected" | "error";

/** Options accepted by `ctx.tabs.openExtensionTab` / `openExtensionPane`. */
export type OpenExtensionTabOptions = {
  /** A panel id previously passed to `ctx.registerPanelRenderer`. */
  panelId: string;
  title: string;
  /** `lucide:<Name>`, `ext-asset:<relPath>` or a `data:` URL. */
  icon?: string;
  /** Stable key for dedup - re-opening with the same key focuses the
   *  existing tab instead of pushing a new one. */
  reuseKey?: string;
};

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

/** Secret-free projection of a saved SSH connection. The password / private
 *  key never crosses this boundary; only the connection `id` does. */
export type SafeSshConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** True only when a server key has been pinned by a prior successful
   *  connect. `openConnection` and `openForward` refuse an unpinned host. */
  pinned: boolean;
};

// ---------------------------------------------------------------------------
// Status bar / header bar
// ---------------------------------------------------------------------------

/**
 * One row of a {@link StatusItem} `detail` tooltip: a label, an optional real
 * progress bar, an optional value, and a muted trailing note. A row with an
 * empty `label` and no `progress` renders as a plain footer line.
 */
/**
 * A pixel chart drawn above a {@link StatusItem} `detail`'s rows: one column
 * per sample, oldest first, on the same 4 px grid the status bar's meters use.
 * The host does no scaling - each value is already 0..1 - because only you know
 * whether your axis starts at zero, auto-fits a window, or tracks a budget.
 *
 * At most the newest 48 columns are drawn: that is the widest grid the
 * tooltip's popover holds without wrapping.
 */
export type StatusItemDetailChart = {
  /** Oldest first, newest last. Each 0..1; 0 draws an empty column, so a gap in
   *  the data and a value at the floor stay distinguishable. */
  values: number[];
  /** Fill colour, same palette as `StatusItem.tone`. */
  tone?: "default" | "success" | "warning" | "error";
  /** Grid height in cells. Clamped to 3..16, default 8. */
  rows?: number;
  /** Caption under the grid, left (e.g. `"last 3 min"`). */
  label?: string;
  /** Caption under the grid, right (e.g. `"peak 6.0G · low 4.8G"`). */
  note?: string;
};

export type StatusItemDetailRow = {
  label: string;
  /** 0..1 fill; when set the row draws a themed progress bar. */
  progress?: number;
  /** Bar colour, same palette as `StatusItem.tone`. */
  tone?: "default" | "success" | "warning" | "error";
  /** Value shown after the bar, e.g. `"62%"`. */
  value?: string;
  /** Muted trailing text, e.g. `"resets in 3h 9m"`. */
  note?: string;
};

/**
 * A bottom-right status-bar icon. Runtime-only (not a manifest contribution):
 * set and remove it as your state changes via `ctx.statusBar`.
 *
 * `icon` accepts `lucide:<Name>` (e.g. `"lucide:Globe"`), the legacy
 * `hugeicon:<Name>` alias, `ext-asset:<relPath>` (read from your install
 * folder) or a `data:image/...;base64,...` URL.
 */
export type StatusItem = {
  id: string;
  icon: string;
  tooltip: string;
  /** Tone for active / warning / error tinting. */
  tone?: "default" | "success" | "warning" | "error";
  /** Short text after the icon (e.g. `"62%"`). Keep it tiny; put the full
   *  story in `tooltip` or `detail`. */
  label?: string;
  /** 0..1 fill. Renders a compact themed progress bar after the icon/label.
   *
   *  It also decides PLACEMENT: an extension that publishes any metered item
   *  sorts before the icon-only ones (then by extension id), so the readouts
   *  group together instead of being scattered among the state lights, and the
   *  compact bar keeps exactly these. The rank is per extension, so one meter
   *  going temporarily unavailable does not move its siblings. */
  progress?: number;
  /** Structured tooltip. When set it replaces the plain `tooltip` string in
   *  the popover (which stays the aria-label and the fallback). `chart` adds a
   *  pixel trend above the rows. */
  detail?: { title?: string; rows: StatusItemDetailRow[]; chart?: StatusItemDetailChart };
  /** When set the item renders as a real focusable `<button>` instead of a
   *  decorative span. Prefer this over document-wide click listeners. */
  onClick?: () => void;
  /**
   * Which status-bar group this belongs to. `"status"` is something you read
   * (a usage meter, a connection state); `"action"` is a button you press.
   *
   * Inferred when omitted: an item with `label`, `progress` or `detail` is a
   * status, anything else with an `onClick` is an action. Declare it when the
   * inference is wrong - an icon-only connection state with a click handler is
   * a status, not an action.
   */
  kind?: "status" | "action";
};

/**
 * A top-header icon, in the cluster next to SSH / Extensions / Settings.
 * Same shape as {@link StatusItem} except `onClick` is required: the header
 * slot has no default action.
 */
export type HeaderItem = {
  id: string;
  icon: string;
  tooltip: string;
  /** Same semantics as `StatusItem.tone`. */
  tone?: "default" | "success" | "warning" | "error";
  /** `"right"` (default) is the cluster after the SSH divider. `"left"` lands
   *  just before the markdown-preview toggle, for buttons acting on the
   *  active editor. */
  placement?: "left" | "right";
  /** Synchronous click handler. The host wraps the call in try/catch. */
  onClick: (event: MouseEvent) => void;
};

// ---------------------------------------------------------------------------
// Sidebar sections
// ---------------------------------------------------------------------------

/**
 * A button in a sidebar section's header (add / refresh) or revealed on a
 * row's hover (edit / delete). `icon` takes the same forms as
 * {@link StatusItem}`.icon`.
 */
export type SidebarSectionAction = {
  id: string;
  icon: string;
  tooltip: string;
  /** Paints the button in the destructive palette (red hover). */
  danger?: boolean;
};

/**
 * One row in an extension sidebar section. Rows nest to form a lazy tree
 * (connection -> database -> schema -> table): set `expandable` for a caret,
 * drive `expanded` + `children` from your own model, load children in
 * `onItemToggle`, then re-call `setSection` with the updated tree. Indentation
 * is computed by the host.
 */
export type SidebarSectionItem = {
  id: string;
  label: string;
  /** Detail shown in a hover tooltip on the row (e.g. `host:port`). */
  sublabel?: string;
  /** Row icon, same forms as {@link SidebarSectionAction}`.icon`. */
  icon?: string;
  /** Highlight this row as the active one (brand accent surface). */
  active?: boolean;
  /** Lifecycle tone for the label text. */
  tone?: "default" | "connecting" | "connected" | "error";
  /** Compact pill after the label (e.g. an engine type). `tone` wins over
   *  `variant` when both are set; both map to host tokens so the badge
   *  follows the active theme. */
  badge?: {
    text: string;
    variant?: "default" | "secondary" | "destructive" | "outline";
    tone?: "success" | "warning" | "error" | "info" | "primary" | "muted";
  };
  /** Show an expand/collapse caret (a tree node). */
  expandable?: boolean;
  /** Caret state. When true the host renders `children`. */
  expanded?: boolean;
  /** Show a small spinner hint on the row (e.g. while loading children). */
  loading?: boolean;
  /** Child rows, rendered indented when `expanded`. */
  children?: SidebarSectionItem[];
  /** Hover-revealed per-row action buttons. */
  actions?: SidebarSectionAction[];
};

/**
 * A left-sidebar section, rendered with the host's own Workspaces-panel
 * chrome as one of the reorderable / collapsible sidebar sections. It exists
 * only while your extension is active, so it appears and disappears with
 * enable / disable. Re-call `setSection` with the same `id` to update rows.
 */
export type SidebarSection = {
  id: string;
  title: string;
  /** Section-header icon. `lucide:<Name>` recommended for host parity. */
  icon?: string;
  /** Buttons in the section header (e.g. add / refresh). */
  headerActions?: SidebarSectionAction[];
  items: SidebarSectionItem[];
  /** Shown when `items` is empty. */
  emptyText?: string;
  /** Render a filter input above the list. The host filters the tree
   *  client-side by label/sublabel and auto-expands matching branches. */
  searchable?: boolean;
  /** Placeholder for the `searchable` filter input. */
  searchPlaceholder?: string;
  /** Offer a "move to right panel" toggle in the section header. Placement
   *  persists per section. */
  movableToRight?: boolean;
  /** Click a row (its `id`). */
  onItemClick?: (itemId: string) => void;
  /** Toggle a row's caret. Load children here, then re-call `setSection`. */
  onItemToggle?: (itemId: string) => void;
  /** Click a row's hover action. */
  onItemAction?: (itemId: string, actionId: string) => void;
  /** Right-click a row. `at` is in viewport coordinates so you can open your
   *  own menu there; the host suppresses the native menu when this is set. */
  onItemContextMenu?: (itemId: string, at: { x: number; y: number }) => void;
  /** Click a header action. */
  onHeaderAction?: (actionId: string) => void;
};

// ---------------------------------------------------------------------------
// Shell transform
// ---------------------------------------------------------------------------

/** `bash` = hidden agent shells (`bash_run` / `bash_background`);
 *  `terminal` = the visible PTY (the `sh` MCP tool, `schedule_command`). */
export type ShellCommandKind = "bash" | "terminal";

/**
 * Rewrites a shell command before an AI tool executes it. Synchronous by
 * design - this is on the AI hot path, so cache any state you need. Return
 * the original string to pass through. Non-string returns are dropped and the
 * call is wrapped in try/catch.
 */
export type ShellCommandTransformer = (command: string, kind: ShellCommandKind) => string;

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * Paints an extension panel into a host-owned container. Return a cleanup
 * callback (or nothing). Pair with a `contributes.panels[]` entry.
 */
export type PanelRenderer = (
  container: HTMLElement,
  /** Present when the panel was opened as a tab or split-pane leaf.
   *  `reuseKey` is the key the pane was opened with, so a panel that runs one
   *  instance per key can tell its mounts apart. */
  ctx?: { surface: "tab" | "pane"; reuseKey?: string },
) => (() => void) | void;

// ---------------------------------------------------------------------------
// ui.mountFolderTree
// ---------------------------------------------------------------------------

export type MountFolderTreeOptions = {
  /** Absolute path of the tree root. A user pick via "Open Folder" wins until
   *  the prop changes; a new `rootPath` from `update()` clears the pick. */
  rootPath: string | null;
  /** Restore an "Open Folder" pick on first mount. Only honored on the first
   *  render of a given mount; pass it on every `mountFolderTree` call. */
  initialPickedPath?: string | null;
  /** Fires after every pick change. Persist this so the next mount can pass
   *  it back as `initialPickedPath`. */
  onPickedPathChange?: (path: string | null) => void;
  /** File-open handler. Defaults to routing through the workspace bridge. */
  onOpenFile?: (path: string, pin?: boolean) => void;
  /** Show the "Open Folder" picker icon and a reset chip. */
  showOpenFolder?: boolean;
  /** Click handler for the header close X. Omit to hide the button. */
  onClose?: () => void;
};

export type MountedFolderTree = {
  /** Replace props without remounting. Preserves expansion state. */
  update(next: MountFolderTreeOptions): void;
  /** Detach the React root and clear children. Idempotent. */
  dispose(): void;
};

// ---------------------------------------------------------------------------
// ui.codeEditor
// ---------------------------------------------------------------------------

export type CodeEditorLanguage =
  "sql" | "sql:mysql" | "sql:postgres" | "sql:sqlite" | "json" | "javascript" | "http" | "plain";

/**
 * One autocomplete suggestion. `type` selects the leading icon CodeMirror
 * paints (`keyword`, `variable`, `property`, `type`, `function`, ...).
 */
export type CodeEditorCompletion = {
  label: string;
  /** Short inline label on the right (e.g. the parent table for a column). */
  detail?: string;
  /** Longer hover description. */
  info?: string;
  type?: string;
  /** Replacement text. Defaults to `label`. */
  apply?: string;
  /** Sort hint. Higher floats to the top. Default 0. */
  boost?: number;
};

export type CodeEditorOptions = {
  language?: CodeEditorLanguage;
  value?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Fires on Ctrl/Cmd+Enter. */
  onCmdEnter?: () => void;
  /** Synchronous completion source. Receives the word before the caret (may
   *  be empty on an explicit Ctrl+Space). Return `[]` for no popup. Older
   *  hosts ignore this field, so it is safe to pass without bumping
   *  `engines.tedi`. */
  completions?: (prefix: string) => CodeEditorCompletion[];
};

export type CodeEditorHandle = {
  setValue(value: string): void;
  getValue(): string;
  /** The selected text, or `""` when the selection is empty. */
  getSelection(): string;
  /** Caret offset in the document. */
  getCursor(): number;
  focus(): void;
  setLanguage(language: CodeEditorLanguage): void;
  dispose(): void;
};

// ---------------------------------------------------------------------------
// Manifest contributions
// ---------------------------------------------------------------------------

/**
 * Unknown keys are preserved rather than rejected on every contribution type,
 * so a manifest written for a newer TEDI still installs on an older one (the
 * host iterates only the fields it knows). That is why each type below is
 * intersected with an index signature.
 */
type Loose = { [key: string]: unknown };

/** A row on your extension's Settings card. */
export type ContributedSetting = {
  id: string;
  type: "string" | "number" | "boolean" | "select" | "note";
  label: string;
  description?: string;
  default?: string | number | boolean | null;
  /** Required when `type` is `"select"`. */
  options?: { value: string; label: string }[];
  /** Parsed but not currently used for grouping. */
  section?: string;
  /** Store the value in the OS keychain instead of the settings store. */
  secret?: boolean;
} & Loose;

/** A command, surfaced in the Command Palette. Bind it with
 *  `ctx.registerCommandHandler(id, fn)`. */
export type ContributedCommand = {
  id: string;
  title: string;
  category?: string;
} & Loose;

/** A keybinding for a contributed command. `key` uses `Mod+` for
 *  Ctrl-on-Windows/Linux, Cmd-on-macOS, e.g. `"Mod+Alt+B"`. */
export type ContributedKeybinding = {
  command: string;
  key: string;
  /** Advisory in this version. */
  when?: string;
} & Loose;

/** A panel surface. Bind the renderer with `ctx.registerPanelRenderer`. */
export type ContributedPanel = {
  id: string;
  title: string;
  /** `"right"` is the slide-out slot next to the workspace (mutually
   *  exclusive with the AI sidebar). `"tab"` mounts the renderer as a full
   *  workspace tab, opened via `ctx.tabs.openExtensionTab`. The other
   *  surfaces are reserved. */
  surface: "sidebar-bottom" | "statusbar-right" | "right" | "tab";
  icon?: string;
  /** Open this panel once per session on launch. The user can override. */
  defaultOpen?: boolean;
  /** Command id (also in `contributes.commands`) that toggles this panel.
   *  Surfaces as a keyboard-shortcut chip on the toggle button. */
  toggleCommand?: string;
  /** Hide the host's title + close-X strip. You then paint the whole panel
   *  and must provide your own close via `ctx.panel.close(panelId)`. */
  hideHostHeader?: boolean;
  /** Cluster this panel's status-bar toggle with the borderless extension
   *  icons instead of next to the AI / SCM toggles. Ordering only. */
  compact?: boolean;
  /** What the status-bar button does. `"panel"` (default) opens the right
   *  slot; `"action"` runs `toggleCommand` and opens nothing. */
  kind?: "panel" | "action";
} & Loose;

/**
 * A tool the AI agent can call. Bind it with
 * `ctx.registerAiToolHandler(name, fn)` from `activate()` - never from the
 * manifest alone, since manifest contributions are seeded before `activate()`
 * runs and would otherwise publish a tool with no handler behind it.
 *
 * The host forces approval on every extension tool regardless of `approval`.
 * The `description` is injected into the model's context on every turn and is
 * shown to the user in the install review dialog.
 */
export type ContributedAiTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  approval?: "auto" | "needsApproval";
} & Loose;

/** The `contributes` block of `manifest.json`. */
export type Contributes = {
  settings?: ContributedSetting[];
  commands?: ContributedCommand[];
  keybindings?: ContributedKeybinding[];
  panels?: ContributedPanel[];
  aiTools?: ContributedAiTool[];
} & Loose;

/**
 * `manifest.json`, as the host parses it. Add
 * `"$schema": "https://tedi.ilhamriski.com/schema/manifest.schema.json"` to
 * the top of your manifest for editor autocomplete and validation.
 */
export type Manifest = {
  /** Lowercase, dotted or kebab, 3-64 chars. Convention: `<publisher>.<name>`. */
  id: string;
  name: string;
  version: string;
  description?: string | null;
  author?: string | null;
  homepage?: string | null;
  /** Relative path to an image in your package, used as the extension icon. */
  icon?: string | null;
  /** Relative path to the ES-module entry point. Omit for a declarative-only
   *  pack (settings, no code). */
  main?: string | null;
  permissions: Permission[];
  contributes: Contributes;
  engines?: { tedi?: string } & Loose;
} & Loose;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * A permission string declared in `manifest.permissions` and approved by the
 * user at install time.
 *
 * The union below lists every permission the host currently checks, so an
 * editor can complete them - but the type stays open (`| (string & {})`)
 * because `invoke:<command>` is unbounded and unknown strings are ignored
 * rather than rejected. Ask for the narrowest set that works: the install
 * dialog badges each one low / medium / high and users do read it.
 */
export type Permission = KnownPermission | `invoke:${string}` | (string & {});

/** The fixed (non-`invoke:`) permissions the host checks. */
export type KnownPermission =
  /** Read this extension's namespaced app settings. Also required by
   *  `settings.onChange`. */
  | "settings:read"
  /** Write this extension's namespaced app settings. */
  | "settings:write"
  /** Read from the OS keychain, namespaced to `tedi-ext:<your-id>`. */
  | "secrets:read"
  /** Write and delete in that namespace. */
  | "secrets:write"
  /** `ctx.events.emit` on your own `ext://<id>/<name>` channel. */
  | "events:emit"
  /** `ctx.events.on` for that channel. */
  | "events:listen"
  /** Show a toast. */
  | "ui:toast"
  /** Open an extension tab or split-pane leaf, and set its title state. */
  | "tabs:open"
  /** Declare panels and mount / open / toggle them. `ctx.panel.close` is
   *  ungated so you can always close your own panel. */
  | "panels:register"
  /** Add a bottom-right status-bar item. Removing your own is ungated. */
  | "statusbar:write"
  /** Add a top-header item. Removing your own is ungated. */
  | "headerbar:write"
  /** Add a left-sidebar section. Removing your own is ungated. */
  | "sidebar:write"
  /** Read the focused editor's live buffer. */
  | "editor:read"
  /** Replace the focused editor's buffer. */
  | "editor:write"
  /** List saved SSH hosts and open / forward one BY ID. Credentials never
   *  cross the boundary, but this opens a remote shell - badged high. */
  | "ssh:connections"
  /** Create and switch workspaces. */
  | "workspaces:manage"
  /** Rewrite every shell command the AI agent runs. Badged high. */
  | "shell:transform"
  /** Retarget the agent's model / provider and toggle sub-agents. */
  | "ai:configure"
  /** Submit a prompt as if the user typed it. */
  | "ai:prompt";

/**
 * Commands `ctx.invoke` refuses outright, even under `invoke:*`.
 *
 * - The `secrets_*` family would sidestep the per-extension keychain
 *   namespace that `ctx.secrets` enforces.
 * - The `ext_*` family would let one extension install, approve, disable or
 *   uninstall another - minting install-time consent on the user's behalf.
 */
export type HardDeniedCommand =
  | "secrets_get"
  | "secrets_get_all"
  | "secrets_set"
  | "secrets_delete"
  | "ext_install_from_zip"
  | "ext_install_from_github"
  | "ext_enable"
  | "ext_disable"
  | "ext_uninstall";

// ---------------------------------------------------------------------------
// The context object
// ---------------------------------------------------------------------------

/**
 * The object handed to `activate(ctx)`. Every facade below is gated against
 * the permissions in your manifest that the user approved at install time; a
 * call without its permission throws.
 *
 * Anything you register through `ctx` is torn down automatically on
 * deactivate (disable, uninstall, or reload). Use `ctx.addDisposer` only for
 * resources the host cannot see - your own timers, sockets, listeners.
 */
export type ExtensionContext = {
  /** Your `manifest.id`. */
  id: string;
  /** Absolute path of your install folder. Join with a sidecar binary's
   *  relative path before calling `shell_bg_spawn`. */
  installPath: string;
  /** Static platform + arch. */
  os: ExtensionOs;
  /** Well-known paths. Ungated - these are strings, not access; reading
   *  anything under them still needs `invoke:fs_*`. */
  paths: {
    /** User home directory, no trailing separator. `""` if unresolvable. */
    home: string;
  };

  /** Per-extension JSON storage (`tedi-ext-<id>.json`). Ungated. */
  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** Read-only app state, plus a few chrome toggles. */
  app: {
    getContext(): AppContextSnapshot;
    /** Auto-disposed on deactivate; the returned disposer is for early
     *  unsubscribe. */
    onContextChange(cb: (ctx: AppContextSnapshot) => void): Disposer;
    /** Show / hide the left sidebar. Ungated and reversible by the user. */
    setSidebarVisible(visible: boolean): void;
    /** Same for the right aux column. Minimizes the whole column; nothing is
     *  closed, so what you hide is exactly what comes back. */
    setRightSidebarVisible(visible: boolean): void;
    /** Create a workspace and switch to it. Requires `workspaces:manage`. */
    createWorkspace(name: string): Promise<{ ok: boolean; wsId?: string; error?: string }>;
    /** Switch the active workspace by id. Requires `workspaces:manage`. */
    setActiveWorkspace(wsId: string): Promise<{ ok: boolean; error?: string }>;
    /** Rename a workspace. The new name reaches you through
     *  `terminals[].wsName`. Requires `workspaces:manage`. */
    renameWorkspace(wsId: string, name: string): Promise<{ ok: boolean; error?: string }>;
    /** Pin or unpin the tab a terminal belongs to. `key` is the id
     *  `terminals[].ptyId` publishes (a daemon ptyId, or `ssh:<sessionId>`).
     *  Requires `workspaces:manage`. */
    setTabPinned(key: string, pinned: boolean): Promise<{ ok: boolean; error?: string }>;
    /** Rename a terminal's tab, or pass `null` to drop back to the derived name.
     *  `key` is as in `setTabPinned`; the result shows up as
     *  `terminals[].customTitle`. Requires `workspaces:manage`. */
    renameTab(key: string, title: string | null): Promise<{ ok: boolean; error?: string }>;
  };

  /** App settings, namespaced under `ext:<your-id>:`. Built-in settings are
   *  not reachable here. */
  settings: {
    /** Requires `settings:read`. */
    get<T = unknown>(key: string): Promise<T | undefined>;
    /** Requires `settings:write`. */
    set<T>(key: string, value: T): Promise<void>;
    /** Requires `settings:read`. */
    onChange(key: string, cb: (value: unknown) => void): Disposer;
  };

  /**
   * The AI agent. Reads are ungated (strictly less revealing than
   * `app.getContext()`). Writes that spend the user's API credit or retarget
   * the agent need `ai:configure`; submitting a turn needs `ai:prompt`.
   *
   * There is deliberately no `setApprovalMode`: it is the user's safety
   * posture, it persists across restarts, and no UI event would tell them it
   * moved. Read it, branch on it, ask the user to change it themselves.
   */
  ai: {
    getState(): AiStateSnapshot;
    /** Fires on any agent or preference change. Coalesce if you render. */
    onStateChange(cb: (state: AiStateSnapshot) => void): Disposer;
    /** Takes effect on the NEXT prompt; an in-flight run stays bound to the
     *  model it started with. `provider` is required because ids are shared
     *  across providers - pass `getState().provider` when you only mean to
     *  change the model. Requires `ai:configure`. */
    setModel(modelId: string, provider: string): Promise<void>;
    /** Requires `ai:configure`. */
    setSubagentsEnabled(enabled: boolean): Promise<void>;
    /** Submit a turn as if the user typed it. Resolves `false` when the
     *  composer refused (no key, or a run is already active). The agent's own
     *  approval gate still applies to every tool it calls. Requires
     *  `ai:prompt`. */
    sendPrompt(text: string): Promise<boolean>;
    /** Stop the active run. Ungated: de-escalating, and the user can always
     *  do it from the UI. */
    stop(): void;
  };

  /**
   * Call a Rust command. Each command id needs its own `invoke:<command>`
   * permission; see {@link HardDeniedCommand} for the ones that are never
   * reachable.
   *
   * Commands in {@link InvokeResults} resolve to their real shape. Everything
   * else resolves to `unknown`, which in plain JavaScript means you narrow it
   * yourself:
   *
   * ```js
   * const res = await ctx.invoke("my_command", { a: 1 });
   * const ok = /** @type {{ ok: boolean }} *\/ (res).ok;
   * ```
   */
  invoke: InvokeFn;

  /** Call a Rust command that streams through a Tauri `Channel` (e.g.
   *  `pty_attach`, `ssh_attach`). The channel is created for you and passed
   *  as the `onEvent` arg. Gated by the same `invoke:<command>` permission. */
  invokeChannel<E = unknown, T = unknown>(
    command: string,
    args: Record<string, unknown> | undefined,
    onEvent: (ev: E) => void,
  ): Promise<T>;

  /** OS keychain, namespaced to `tedi-ext:<your-id>` so extensions cannot
   *  read each other's keys or the app's provider keys. */
  secrets: {
    /** Requires `secrets:read`. */
    get(name: string): Promise<string | null>;
    /** Requires `secrets:write`. */
    set(name: string, value: string): Promise<void>;
    /** Requires `secrets:write`. */
    delete(name: string): Promise<void>;
  };

  /** Event bus, namespaced as `ext://<your-id>/<name>`. */
  events: {
    /** Requires `events:emit`. */
    emit(name: string, payload?: unknown): Promise<void>;
    /** Requires `events:listen`. */
    on(name: string, cb: (payload: unknown) => void): Promise<Disposer>;
  };

  ui: {
    /** Requires `ui:toast`. */
    toast(
      message: string,
      opts?: { variant?: "default" | "success" | "info" | "warning" | "error" },
    ): void;
    /** Mount TEDI's built-in folder explorer into a container you own.
     *  Ungated: read-only render, and click-to-open routes through the same
     *  workspace bridge as the built-in explorer. Auto-disposed. */
    mountFolderTree(container: HTMLElement, options: MountFolderTreeOptions): MountedFolderTree;
    /** A `<span>` with a Lucide icon mounted inside. `name` takes a bare name
     *  (`"Plus"`), a `lucide:` ref, or the legacy `hugeicon:` ref. Unknown
     *  names render an empty span and log a warning. Ungated.
     *
     *  Each call spawns a React root; for high-frequency rendering cache one
     *  element and `.cloneNode(true)` it. All roots are unmounted on
     *  deactivate. */
    icon(
      name: string,
      opts?: { size?: number; strokeWidth?: number; className?: string },
    ): HTMLElement;
    /** Mount a CodeMirror 6 editor that reuses the host's bundle, so line
     *  numbers, gutter, selection and syntax highlight match the main editor
     *  pane exactly. Ungated; auto-disposed. */
    codeEditor(container: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle;
  };

  /** Bottom-right status-bar icons, keyed by `id`. Removed on deactivate. */
  statusBar: {
    /** Requires `statusbar:write`. */
    setItem(item: StatusItem): void;
    /** Ungated - you can always remove your own item, even after a revoke. */
    removeItem(itemId: string): void;
  };

  /** Top-header icons. Same semantics as `statusBar`. */
  headerBar: {
    /** Requires `headerbar:write`. */
    setItem(item: HeaderItem): void;
    /** Ungated. */
    removeItem(itemId: string): void;
  };

  /** A left-sidebar section rendered with the host's own chrome. */
  sidebar: {
    /** Requires `sidebar:write`. Re-call with the same `id` to update rows. */
    setSection(section: SidebarSection): void;
    /** Ungated. */
    removeSection(sectionId: string): void;
  };

  /** The focused editor leaf's CodeMirror buffer. */
  editor: {
    /** `null` when no editor is focused. Requires `editor:read`. */
    getActive(): ActiveEditorSnapshot | null;
    /** Replaces the whole buffer in one transaction; the user sees it as
     *  unsaved until Ctrl+S. Requires `editor:write`. */
    setActiveContent(content: string): boolean;
  };

  /** Extension-owned tabs and split-pane leaves. All three need `tabs:open`. */
  tabs: {
    /** Open or focus a standalone workspace tab that mounts the renderer
     *  registered for `panelId`. Returns the tab id, or `null`. */
    openExtensionTab(opts: OpenExtensionTabOptions): number | null;
    /** Same, but as a native split-pane leaf - the same frame as a terminal
     *  or editor, splittable and joinable. */
    openExtensionPane(opts: OpenExtensionTabOptions): number | null;
    /** Tint the title to reflect a lifecycle state and/or relabel it.
     *  Matches on `(extensionId, panelId, reuseKey)` and patches BOTH a
     *  standalone tab and a live pane leaf. Pass `state: null` to clear. */
    setExtensionTabState(opts: {
      panelId: string;
      reuseKey?: string;
      state: ExtensionTabState | null;
      title?: string;
      /** Same icon refs `contributes.panels[].icon` takes, including a `data:`
       *  URL - which is how a pane can wear the favicon of the page it shows. */
      icon?: string;
    }): void;
  };

  /** Saved SSH connections. Every method requires `ssh:connections`. The SSH
   *  password / key never crosses this boundary - only the connection id
   *  does, and the real connect runs inside the app's keychain-backed flow. */
  ssh: {
    /** Secret-free metadata for the user's saved hosts. */
    listConnections(): Promise<SafeSshConnection[]>;
    /** Open a saved connection as a real SSH tab. REFUSES a connection with
     *  no pinned server key, so a remote caller can never trigger a
     *  first-connect host-key prompt. */
    openConnection(id: string): Promise<{ ok: boolean; error?: string }>;
    /** Close the SSH tab whose live session id is `sessionId` (the runtime id
     *  from `ssh_list_sessions`). Returns true if one was closed. */
    closeConnection(sessionId: number): boolean;
    /** Tunnel `remoteHost:remotePort` (resolved from the SSH server) to a
     *  loopback port and return it - for reaching a service only a bastion
     *  can see. Repeat calls for the same target reuse the forward. Refuses
     *  an unpinned connection, like `openConnection`. */
    openForward(
      connectionId: string,
      remoteHost: string,
      remotePort: number,
    ): Promise<{ localPort: number }>;
    /** Release a forward. The session closes once its last forward is gone. */
    closeForward(connectionId: string, remoteHost: string, remotePort: number): Promise<void>;
  };

  shell: {
    /** Rewrite commands before `bash_run`, `bash_background`, the `sh` MCP tool
     *  and `schedule_command` execute. Transformers compose in insertion order.
     *  Requires `shell:transform`. */
    registerCommandTransformer(transformer: ShellCommandTransformer): Disposer;
  };

  /** Bind a renderer to a `contributes.panels[]` entry. The renderer gets a
   *  fresh `<div>` and returns a cleanup callback. Requires
   *  `panels:register`. Auto-disposed. */
  registerPanelRenderer(panelId: string, renderer: PanelRenderer): Disposer;

  /** Imperative right-panel control, scoped to panels you own. */
  panel: {
    /** Requires `panels:register`. */
    open(panelId: string): void;
    /** Ungated, and scoped to your own panels: the right column stacks
     *  several at once, so a bare `close()` never takes another extension's
     *  surface down with it. Omit `panelId` to close all of yours. */
    close(panelId?: string): void;
    /** Requires `panels:register`. */
    toggle(panelId: string): void;
  };

  /**
   * Runtime equivalents of the manifest's `contributes.*` block. Each call
   * REPLACES the previous declaration for that category (pass `[]` to clear),
   * and overwrites whatever the manifest seeded.
   *
   * Prefer the manifest for anything static: manifest contributions survive a
   * failed `activate()`, so the user can still reach your settings card to
   * disable or uninstall. Use these when the set is genuinely dynamic.
   */
  contribute: {
    settings(items: ContributedSetting[]): void;
    commands(items: ContributedCommand[]): void;
    keybindings(items: ContributedKeybinding[]): void;
    /** Requires `panels:register`. */
    panels(items: ContributedPanel[]): void;
    aiTools(items: ContributedAiTool[]): void;
  };

  /** Bind a handler to a contributed command id. Declare the command first,
   *  in the manifest or via `contribute.commands`. Ungated. */
  registerCommandHandler(commandId: string, handler: (...args: unknown[]) => unknown): void;

  /** Bind a handler to a contributed AI tool. The host packages the return
   *  value for the AI SDK. Call this from `activate()`. Ungated. */
  registerAiToolHandler(
    toolName: string,
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ): void;

  /** Console logger prefixed with `[ext:<your-id>]`. `info` is dropped in
   *  release builds; `warn` and `error` always survive. */
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };

  /**
   * Does this host support `feature`? Ungated.
   *
   * You only need this for the things `typeof` cannot see. A whole method or
   * facade is already detectable, and that idiom needs nothing from the host:
   *
   * ```js
   * if (typeof ctx.headerBar?.setItem === "function") { ... }
   * ```
   *
   * What that cannot detect is an **option field** or a **callback argument**
   * a newer TEDI added. An older host reads your object, ignores the key it
   * does not know, and quietly gives you the old behaviour:
   *
   * ```js
   * ctx.ui.codeEditor(el, {
   *   language: "sql",
   *   // Silently dropped before the host that added it. Ask first:
   *   completions: ctx.has?.("codeEditor.completions") ? suggest : undefined,
   * });
   * ```
   *
   * Call it optionally (`ctx.has?.(...)`) - a host older than `ctx.has` itself
   * has no such method, and `undefined` is correctly falsy.
   *
   * Prefer this over raising `engines.tedi`: feature detection degrades on an
   * old host, an engine bump locks you out of it entirely.
   *
   * @see {@link HostFeature} for what can be asked about today.
   */
  has(feature: string): boolean;

  /** Run `d` on deactivate. Everything registered through `ctx` already does
   *  this; use it for your own timers, sockets and listeners. */
  addDisposer(d: Disposer): void;
};

/**
 * Feature strings `ctx.has()` knows about in this host version. The parameter
 * is a plain `string`, not this union, on purpose: asking about a feature this
 * host has never heard of must return `false`, not fail to compile - that is
 * the whole point of asking.
 */
export type HostFeature =
  /** `CodeEditorOptions.completions` - autocomplete in `ctx.ui.codeEditor`. */
  | "codeEditor.completions"
  /** `ContributedPanel.compact` - cluster the status-bar toggle with the
   *  borderless extension icons. */
  | "panel.compact"
  /** `ContributedPanel.kind: "action"` - the toggle runs `toggleCommand`
   *  instead of opening a panel. */
  | "panel.kind.action"
  /** The second argument to a {@link PanelRenderer} (`{ surface, reuseKey }`),
   *  which is how a panel running one instance per key tells its mounts
   *  apart. */
  | "panelRenderer.mountContext"
  /** `StatusItem.label` / `.progress` / `.detail` / `.kind` - a status item
   *  that displays data rather than just an icon. */
  | "statusItem.progress"
  /** `SidebarSection.onItemContextMenu` - right-click a row. */
  | "sidebarSection.contextMenu";
