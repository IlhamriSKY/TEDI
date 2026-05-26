/**
 * Contribution registries. Each stores one map per extension id; deactivate
 * clears that extension's slice. Built-in code reads via `list*()`.
 * Each registry is a small event emitter for React hooks. Vanilla (no
 * zustand) to avoid a circular dep with `store.ts`.
 */

import type {
  ContributedAiTool,
  ContributedCommand,
  ContributedEditorTheme,
  ContributedKeybinding,
  ContributedPanel,
  ContributedSetting,
  ContributedSlashCommand,
  ContributedTheme,
} from "./manifest";

type Listener = () => void;

/**
 * Status-bar item. Unlike `contribute.*` registries (declarative snapshot
 * per category), status items are runtime-only; extensions set/remove them
 * as their state changes. Rendered in the bottom-right of the StatusBar.
 * Icon resolution:
 *   `ext-asset:<relPath>` reads `<ext-root>/<relPath>` via `ext_read_asset_bytes`.
 *   `data:image/...;base64,...` renders as a data URL.
 */
export type StatusItem = {
  id: string;
  icon: string;
  tooltip: string;
  /** Tone for active / warning / error tinting. */
  tone?: "default" | "success" | "warning" | "error";
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

  /** Finds a runtime handler across all extensions. Used by command dispatch. */
  findRuntime(key: string): { extensionId: string; value: unknown } | null {
    for (const [extId, map] of this.runtime) {
      const v = map.get(key);
      if (v !== undefined) return { extensionId: extId, value: v };
    }
    return null;
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
export const slashCommandsRegistry = new Registry<ContributedSlashCommand>();
export const themesRegistry = new Registry<ContributedTheme>();
export const editorThemesRegistry = new Registry<ContributedEditorTheme>();
export const panelsRegistry = new Registry<ContributedPanel>();
export const aiToolsRegistry = new Registry<ContributedAiTool>();

/**
 * Runtime-only status item registry. Extensions push items via
 * `ctx.statusBar.setItem(id, item)`; StatusBar subscribes via `useRegistry`.
 * Stored as Map<itemId, StatusItem> per extension since mutations are by id.
 */
class StatusItemRegistry {
  private readonly byExt = new Map<string, Map<string, StatusItem>>();
  private readonly listeners = new Set<Listener>();
  private cachedList: { extensionId: string; item: StatusItem }[] | null = null;

  setItem(extensionId: string, item: StatusItem): void {
    let map = this.byExt.get(extensionId);
    if (!map) {
      map = new Map();
      this.byExt.set(extensionId, map);
    }
    map.set(item.id, item);
    this.cachedList = null;
    this.emit();
  }

  removeItem(extensionId: string, itemId: string): void {
    const map = this.byExt.get(extensionId);
    if (!map) return;
    if (map.delete(itemId)) {
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

  list(): { extensionId: string; item: StatusItem }[] {
    if (this.cachedList !== null) return this.cachedList;
    const out: { extensionId: string; item: StatusItem }[] = [];
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
        console.error("[extensions] status-item listener threw", err);
      }
    }
  }
}

export const statusItemsRegistry = new StatusItemRegistry();

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
class HeaderItemRegistry {
  private readonly byExt = new Map<string, Map<string, HeaderItem>>();
  private readonly listeners = new Set<Listener>();
  private cachedList: { extensionId: string; item: HeaderItem }[] | null = null;

  setItem(extensionId: string, item: HeaderItem): void {
    let map = this.byExt.get(extensionId);
    if (!map) {
      map = new Map();
      this.byExt.set(extensionId, map);
    }
    map.set(item.id, item);
    this.cachedList = null;
    this.emit();
  }

  removeItem(extensionId: string, itemId: string): void {
    const map = this.byExt.get(extensionId);
    if (!map) return;
    if (map.delete(itemId)) {
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

  list(): { extensionId: string; item: HeaderItem }[] {
    if (this.cachedList !== null) return this.cachedList;
    const out: { extensionId: string; item: HeaderItem }[] = [];
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
        console.error("[extensions] header-item listener threw", err);
      }
    }
  }
}

export const headerItemsRegistry = new HeaderItemRegistry();

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
          console.error(
            `[extensions] shell transformer from "${extId}" returned non-string`,
            next,
          );
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
export type PanelRenderer = (container: HTMLElement) => (() => void) | void;

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
  slashCommandsRegistry.clear(extensionId);
  themesRegistry.clear(extensionId);
  editorThemesRegistry.clear(extensionId);
  panelsRegistry.clear(extensionId);
  panelRenderersRegistry.clear(extensionId);
  aiToolsRegistry.clear(extensionId);
  statusItemsRegistry.clear(extensionId);
  headerItemsRegistry.clear(extensionId);
  shellTransformersRegistry.clear(extensionId);
}
