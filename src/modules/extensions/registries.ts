/**
 * Contribution registries. Each stores one map per extension id; deactivate
 * clears that extension's slice. Built-in code reads via `list*()`.
 * Each registry is a small event emitter for React hooks. Vanilla (no
 * zustand) to avoid a circular dep with `store.ts`.
 */

import type {
  ContributedAiTool,
  ContributedCommand,
  ContributedKeybinding,
  ContributedPanel,
  ContributedSetting,
} from "./manifest";

type Listener = () => void;

/**
 * Status-bar item. Unlike `contribute.*` registries (declarative snapshot
 * per category), status items are runtime-only; extensions set/remove them
 * as their state changes. Rendered in the bottom-right of the StatusBar.
 * Icon resolution:
 *   `lucide:<Name>` renders a Lucide icon (e.g. `lucide:Globe`); legacy
 *   `hugeicon:<Name>` refs still resolve to their nearest Lucide equivalent.
 *   `ext-asset:<relPath>` reads `<ext-root>/<relPath>` via `ext_read_asset_bytes`.
 *   `data:image/...;base64,...` renders as a data URL.
 */
/** One row of a `StatusItem.detail` tooltip. Renders as: label, an optional
 *  real progress bar, an optional value, and muted trailing note. A row with an
 *  empty `label` and no `progress` is a plain footer line. */
export type StatusItemDetailRow = {
  label: string;
  /** 0..1 fill; when set the row draws a real themed progress bar. */
  progress?: number;
  /** Bar colour, same palette as `StatusItem.tone`. */
  tone?: "default" | "success" | "warning" | "error";
  /** Value shown after the bar, e.g. `"62%"`. */
  value?: string;
  /** Muted trailing text, e.g. `"resets in 3h 9m"`. */
  note?: string;
};

export type StatusItem = {
  id: string;
  icon: string;
  tooltip: string;
  /** Tone for active / warning / error tinting. */
  tone?: "default" | "success" | "warning" | "error";
  /** Optional short text rendered after the icon (e.g. `"62%"`). Kept tiny;
   *  put the full detail in `tooltip`. */
  label?: string;
  /** Optional 0..1 fill. When set, the item renders a compact themed progress
   *  bar after the icon/label (clamped to [0,1]); the fill colour follows
   *  `tone` (error red, warning amber, else accent). Omit for an icon-only
   *  item (the default; existing items are unaffected). */
  progress?: number;
  /** Optional structured tooltip. When set, the tooltip renders a small panel
   *  with a real progress bar per row instead of the plain `tooltip` string
   *  (which stays the aria-label and the fallback on hosts that ignore this). */
  detail?: { title?: string; rows: StatusItemDetailRow[] };
  /** Optional click handler. When set the item renders as a real `<button>`
   *  instead of a decorative `<span role="img">`, so it is focusable and
   *  keyboard-activatable. Without this an extension that wants a clickable
   *  status icon has to attach a document-wide listener and match the DOM,
   *  which breaks whenever the host's markup changes. Status items are set at
   *  runtime through `ctx.statusBar` (they are not a manifest contribution),
   *  so a function on this object is passed in-process and never serialised. */
  onClick?: () => void;
  /**
   * Which status-bar group this belongs to. `"status"` is something you read
   * (a usage meter, a connection state); `"action"` is a button you press to
   * make something happen. The bar groups them separately so a row of readouts
   * is not interleaved with a row of buttons.
   *
   * Left unset it is inferred: an item that displays data (`label`, `progress`
   * or `detail`) is a status, anything else with an `onClick` is an action.
   * Declare it when the inference is wrong - an icon-only connection state with
   * a click handler (Discord, Remote Access) is a status, not an action.
   */
  kind?: "status" | "action";
};

class Registry<T> {
  /** Items contributed per extension. */
  private readonly byExt = new Map<string, T[]>();
  /** Runtime handlers (event callbacks, React components) that can't live
   *  in the JSON declaration. */
  private readonly runtime = new Map<string, Map<string, unknown>>();
  private readonly listeners = new Set<Listener>();
  /**
   * Cached `list()` snapshot. `useSyncExternalStore` compares via
   * `Object.is`, so returning a fresh array each call loops forever.
   * Invalidated on `set`/`clear`.
   */
  private cachedList: { extensionId: string; item: T }[] | null = null;

  set(extensionId: string, items: T[]): void {
    this.byExt.set(extensionId, items);
    this.cachedList = null;
    this.emit();
  }

  setRuntime(extensionId: string, key: string, value: unknown): void {
    let map = this.runtime.get(extensionId);
    if (!map) {
      map = new Map();
      this.runtime.set(extensionId, map);
    }
    map.set(key, value);
    // Runtime entries don't appear in `list()`; cache stays valid.
    // Still notify in case a subscriber tracks runtime state.
    this.emit();
  }

  getRuntime(extensionId: string, key: string): unknown {
    return this.runtime.get(extensionId)?.get(key);
  }

  clear(extensionId: string): void {
    this.byExt.delete(extensionId);
    this.runtime.delete(extensionId);
    this.cachedList = null;
    this.emit();
  }

  list(): { extensionId: string; item: T }[] {
    if (this.cachedList !== null) return this.cachedList;
    const out: { extensionId: string; item: T }[] = [];
    for (const [extId, items] of this.byExt) {
      for (const it of items) out.push({ extensionId: extId, item: it });
    }
    this.cachedList = out;
    return out;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[extensions] registry listener threw", err);
      }
    }
  }
}

export const settingsRegistry = new Registry<ContributedSetting>();
export const commandsRegistry = new Registry<ContributedCommand>();
export const keybindingsRegistry = new Registry<ContributedKeybinding>();
export const panelsRegistry = new Registry<ContributedPanel>();
export const aiToolsRegistry = new Registry<ContributedAiTool>();

/**
 * Runtime, id-keyed registry. Stores one `Map<itemId, T>` per extension;
 * extensions mutate by item id (set / remove) and the host reads via `list()`.
 * Backs the status-bar, header-bar and sidebar-section slots — each a
 * byte-identical emitter differing only in the item type and the emit log
 * label. `label` preserves each registry's original error wording.
 */
class KeyedRegistry<T extends { id: string }> {
  private readonly byExt = new Map<string, Map<string, T>>();
  private readonly listeners = new Set<Listener>();
  private cachedList: { extensionId: string; item: T }[] | null = null;

  constructor(private readonly label = "keyed") {}

  set(extensionId: string, item: T): void {
    let map = this.byExt.get(extensionId);
    if (!map) {
      map = new Map();
      this.byExt.set(extensionId, map);
    }
    map.set(item.id, item);
    this.cachedList = null;
    this.emit();
  }

  remove(extensionId: string, id: string): void {
    const map = this.byExt.get(extensionId);
    if (!map) return;
    if (map.delete(id)) {
      if (map.size === 0) this.byExt.delete(extensionId);
      this.cachedList = null;
      this.emit();
    }
  }

  clear(extensionId: string): void {
    if (!this.byExt.has(extensionId)) return;
    this.byExt.delete(extensionId);
    this.cachedList = null;
    this.emit();
  }

  list(): { extensionId: string; item: T }[] {
    if (this.cachedList !== null) return this.cachedList;
    const out: { extensionId: string; item: T }[] = [];
    for (const [extId, items] of this.byExt) {
      for (const item of items.values()) out.push({ extensionId: extId, item });
    }
    this.cachedList = out;
    return out;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error(`[extensions] ${this.label} listener threw`, err);
      }
    }
  }
}

export const statusItemsRegistry = new KeyedRegistry<StatusItem>("status-item");

/**
 * Header-bar item shape. Identical fields to `StatusItem` but the slot
 * sits in the header row (next to SSH / Extensions / Settings) instead
 * of the status bar. `onClick` is required because the host has no
 * default action like the right-panel auto-toggle; the extension wires
 * the click to its own command handler.
 */
export type HeaderItem = {
  id: string;
  icon: string;
  tooltip: string;
  /** Optional badge / tone. Same semantics as `StatusItem.tone`. */
  tone?: "default" | "success" | "warning" | "error";
  /** Where the icon lands in the header row. `"right"` (default) is the
   *  cluster after the SSH divider, alongside Extensions / Settings.
   *  `"left"` lands immediately before the markdown-preview toggle, in
   *  the file-view-mode area, for buttons that act on the active editor. */
  placement?: "left" | "right";
  /** Synchronous click handler. Receives the click event. The host
   *  wraps the call in try/catch and surfaces errors via console. */
  onClick: (event: MouseEvent) => void;
};

/**
 * Header-bar item registry. Mirrors `statusItemsRegistry` but the
 * rendered slot is in the top header row.
 */
export const headerItemsRegistry = new KeyedRegistry<HeaderItem>("header-item");

/**
 * A button shown either in a sidebar section's header (e.g. add / refresh)
 * or revealed on a row's hover (e.g. edit / delete). `icon` accepts the same
 * forms as `HeaderItem.icon`: `lucide:<Name>` (or legacy `hugeicon:<Name>`),
 * `data:` URL, or `ext-asset:<relPath>`.
 */
export type SidebarSectionAction = {
  id: string;
  icon: string;
  tooltip: string;
  /** Paints the button in the destructive palette (red hover). */
  danger?: boolean;
};

/** One row in an extension-contributed sidebar section. Rows may nest to form
 *  a lazy tree (e.g. connection → database → schema → table): set `expandable`
 *  to show a caret, drive `expanded` + `children` from the extension's own
 *  model, and load children on the `onItemToggle` callback (re-call
 *  `setSection` with the updated tree). Depth/indent is computed by the host. */
export type SidebarSectionItem = {
  id: string;
  label: string;
  /** Optional detail shown in a hover tooltip on the row (e.g. host:port). */
  sublabel?: string;
  /** Row icon, same forms as `SidebarSectionAction.icon`. */
  icon?: string;
  /** Highlight this row as the active/selected one (brand accent surface). */
  active?: boolean;
  /** Lifecycle tone for the label text. Mirrors the SSH / ext-tab palette:
   *  `connecting` pulses amber, `connected` is emerald, `error` is red. */
  tone?: "default" | "connecting" | "connected" | "error";
  /** Optional pill rendered just after the label (e.g. a connection's engine
   *  type: MySQL / PostgreSQL / SQLite). `variant` maps 1:1 to the host
   *  `<Badge>` variants so extension badges stay visually consistent with the
   *  rest of the app. Kept compact for the dense sidebar row. */
  badge?: {
    text: string;
    variant?: "default" | "secondary" | "destructive" | "outline";
    /**
     * Optional semantic colour, for a badge whose TEXT is a category the reader
     * scans for (an HTTP verb, a severity, an engine). Every value is an
     * existing theme token, so a badge tinted this way follows the active
     * theme and travels with an exported one; there is no raw-colour escape
     * hatch on purpose. Wins over `variant` when both are set.
     */
    tone?: "success" | "warning" | "error" | "info" | "primary" | "muted";
  };
  /** Show an expand/collapse caret (a tree node). */
  expandable?: boolean;
  /** Caret state. When true the host renders `children`. */
  expanded?: boolean;
  /** Show a small "…" spinner hint on the row (e.g. while loading children). */
  loading?: boolean;
  /** Child rows, rendered (indented) when `expanded`. */
  children?: SidebarSectionItem[];
  /** Hover-revealed per-row action buttons. */
  actions?: SidebarSectionAction[];
};

/**
 * An extension-contributed left-sidebar section. The host renders it with the
 * same chrome as the built-in Workspaces panel (h-8 header with icon + title +
 * action buttons, then a scrollable row list), as one of the reorderable /
 * collapsible AppSidebar sections. A section lives in the sidebar only while
 * the owning extension is active, so it appears / disappears with the
 * extension's enable / disable state (no separate "is installed" gate needed).
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
   *  client-side by label/sublabel (a node shows if it — or any loaded
   *  descendant — matches); matching branches auto-expand. */
  searchable?: boolean;
  /** Placeholder for the `searchable` filter input. */
  searchPlaceholder?: string;
  /** Offer a "move to right panel" toggle in the section header (mirrors the
   *  Source Control right-panel layout). When moved, the section leaves the
   *  left sidebar and is reachable from a status-bar icon that opens it in the
   *  shared right slot. Placement persists per section. */
  movableToRight?: boolean;
  /** Click a row (its `id`). */
  onItemClick?: (itemId: string) => void;
  /** Toggle a row's expand caret (`itemId`). Load children here, mutate your
   *  model, then re-call `setSection` with the updated tree. */
  onItemToggle?: (itemId: string) => void;
  /** Click a row's hover action (`itemId`, `actionId`). */
  onItemAction?: (itemId: string, actionId: string) => void;
  /** Right-click a row. `at` is the pointer position in viewport coordinates,
   *  so the extension can open its own menu there. Rows carry only a handful
   *  of hover actions; a tree (a database schema, a file list) usually needs a
   *  longer per-node menu than that, and this is how it gets one. The host
   *  suppresses the native menu when this is set. */
  onItemContextMenu?: (itemId: string, at: { x: number; y: number }) => void;
  /** Click a header action (`actionId`). */
  onHeaderAction?: (actionId: string) => void;
};

/**
 * Sidebar-section registry. Mirrors `headerItemsRegistry` (runtime, callback-
 * carrying, keyed by id) but the rendered slot is a left-sidebar section.
 * Per-extension Map<sectionId, SidebarSection>; `clearExtensionContributions`
 * drops the slice on deactivate so the section vanishes when disabled.
 */
export const sidebarSectionsRegistry = new KeyedRegistry<SidebarSection>("sidebar-section");

/**
 * Shell-command transformer registry. Lets extensions rewrite shell commands
 * before the built-in AI tools execute them (e.g. RTK prefixing `git status`
 * as `rtk git status`).
 * Each transformer receives the command and a `kind` hint (`bash` for hidden
 * agent shells via `bash_run`/`bash_background`, `terminal` for visible PTY
 * injections via `suggest_command`/`run_in_terminal`) and returns the
 * rewritten string. `applyAll` chains transformers in insertion order.
 * Sync API: command-transform is on the AI hot path; extensions needing async
 * state should cache it.
 * Each transformer is wrapped in try/catch; non-string returns are dropped.
 * Disable/uninstall clears the extension's entry.
 */
export type ShellCommandKind = "bash" | "terminal";
export type ShellCommandTransformer = (command: string, kind: ShellCommandKind) => string;

class ShellTransformerRegistry {
  /** Insertion-ordered so `applyAll` is deterministic. */
  private readonly byExt = new Map<string, ShellCommandTransformer>();

  set(extensionId: string, transformer: ShellCommandTransformer): void {
    this.byExt.set(extensionId, transformer);
  }

  clear(extensionId: string): void {
    this.byExt.delete(extensionId);
  }

  size(): number {
    return this.byExt.size;
  }

  applyAll(command: string, kind: ShellCommandKind): string {
    if (this.byExt.size === 0) return command;
    let result = command;
    for (const [extId, transformer] of this.byExt) {
      try {
        const next = transformer(result, kind);
        if (typeof next !== "string") {
          console.error(`[extensions] shell transformer from "${extId}" returned non-string`, next);
          continue;
        }
        result = next;
      } catch (err) {
        console.error(`[extensions] shell transformer from "${extId}" threw`, err);
      }
    }
    return result;
  }
}

export const shellTransformersRegistry = new ShellTransformerRegistry();

/**
 * Panel renderer registry. Right-panel extensions declare panels in
 * `contributes.panels[]` (surface `"right"`) and bind a mount function via
 * `ctx.registerPanelRenderer(panelId, fn)`. The host calls it with a fresh
 * `<div>`; the extension paints into it and returns a cleanup callback.
 * Manifest carries id/title/icon for toggle button + header; the registry
 * carries the mount function.
 * Per-extension Map allows multiple panels per extension.
 * `clearExtensionContributions` drops the slice on deactivate.
 */
export type PanelRenderer = (
  container: HTMLElement,
  /** `reuseKey` is the one the pane was opened with, so a panel that runs one
   *  instance per key (the API Client runs one workbench per collection) can
   *  tell its mounts apart. Undefined for a panel opened without a key. */
  ctx?: { surface: "tab" | "pane"; reuseKey?: string },
) => (() => void) | void;

class PanelRendererRegistry {
  private readonly byExt = new Map<string, Map<string, PanelRenderer>>();
  private readonly listeners = new Set<Listener>();

  set(extensionId: string, panelId: string, renderer: PanelRenderer): void {
    let map = this.byExt.get(extensionId);
    if (!map) {
      map = new Map();
      this.byExt.set(extensionId, map);
    }
    map.set(panelId, renderer);
    this.emit();
  }

  remove(extensionId: string, panelId: string): void {
    const map = this.byExt.get(extensionId);
    if (!map) return;
    if (map.delete(panelId)) {
      if (map.size === 0) this.byExt.delete(extensionId);
      this.emit();
    }
  }

  clear(extensionId: string): void {
    if (!this.byExt.has(extensionId)) return;
    this.byExt.delete(extensionId);
    this.emit();
  }

  get(extensionId: string, panelId: string): PanelRenderer | null {
    return this.byExt.get(extensionId)?.get(panelId) ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[extensions] panel renderer listener threw", err);
      }
    }
  }
}

export const panelRenderersRegistry = new PanelRendererRegistry();

export function clearExtensionContributions(extensionId: string): void {
  settingsRegistry.clear(extensionId);
  commandsRegistry.clear(extensionId);
  keybindingsRegistry.clear(extensionId);
  panelsRegistry.clear(extensionId);
  panelRenderersRegistry.clear(extensionId);
  aiToolsRegistry.clear(extensionId);
  statusItemsRegistry.clear(extensionId);
  headerItemsRegistry.clear(extensionId);
  sidebarSectionsRegistry.clear(extensionId);
  shellTransformersRegistry.clear(extensionId);
}
