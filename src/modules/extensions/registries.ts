/**
 * Contribution registries.
 *
 * These are the "hooking points" extensions plug into. Each registry stores
 * one map per extension id; deactivate clears that extension's slice
 * without touching anyone else's contributions. Built-in code reads the
 * flattened view via `list*()`.
 *
 * Every registry is a tiny event emitter so React hooks can subscribe.
 * Keeping these vanilla (no zustand here) avoids circular deps with
 * `store.ts` which depends on extension state.
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
 * Status-bar status item. Unlike the contribute.* registries (which take
 * a declarative snapshot of an entire category at activate time), status
 * items live on a runtime-only registry: extensions set / remove
 * individual items as their internal state changes (connected, busy,
 * has-error, ...). The host renders all visible items as small icons in
 * the bottom-right of the StatusBar.
 *
 * The icon field is resolved by the host:
 *   - "ext-asset:<relPath>" reads the binary at <ext-root>/<relPath>
 *     via ext_read_asset_bytes (same pipeline as the install card).
 *   - "data:image/...;base64,..." is rendered straight as a data URL.
 */
export type StatusItem = {
  id: string;
  icon: string;
  tooltip: string;
  /** Optional badge dot for "active / warning / error" tinting. */
  tone?: "default" | "success" | "warning" | "error";
};

class Registry<T> {
  /** Map<extensionId, items contributed by that extension>. */
  private readonly byExt = new Map<string, T[]>();
  /** Map<extensionId, Map<itemKey, runtimeHandler>>. Runtime side-channel
   *  for things that can't live in the JSON declaration (event callbacks,
   *  React components). */
  private readonly runtime = new Map<string, Map<string, unknown>>();
  private readonly listeners = new Set<Listener>();
  /**
   * Cached flattened view of `byExt`. Rebuilt lazily on first `list()`
   * call after a `set`/`clear` invalidation. React's
   * `useSyncExternalStore` compares snapshots via `Object.is`, so
   * returning a fresh array on every call triggers an infinite render
   * loop ("The result of getSnapshot should be cached to avoid an
   * infinite loop"). Caching by reference makes the contract honest.
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
    // Runtime side-channel doesn't appear in `list()` output, so the
    // cached snapshot is still valid. Notify subscribers in case they
    // care about runtime-only state via a different path.
    this.emit();
  }

  getRuntime(extensionId: string, key: string): unknown {
    return this.runtime.get(extensionId)?.get(key);
  }

  /** Find runtime handler regardless of which extension owns it. Used by
   *  command dispatch where the caller only knows the command id. */
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
 * Runtime-only status item registry. Extensions push items in via
 * `ctx.statusBar.setItem(id, item)` and the StatusBar component
 * subscribes via `useRegistry`.
 *
 * Stored as a per-extension Map<itemId, StatusItem> rather than a flat
 * array because mutations are by id (set/remove single items) not
 * batches.
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

export function clearExtensionContributions(extensionId: string): void {
  settingsRegistry.clear(extensionId);
  commandsRegistry.clear(extensionId);
  keybindingsRegistry.clear(extensionId);
  slashCommandsRegistry.clear(extensionId);
  themesRegistry.clear(extensionId);
  editorThemesRegistry.clear(extensionId);
  panelsRegistry.clear(extensionId);
  aiToolsRegistry.clear(extensionId);
  statusItemsRegistry.clear(extensionId);
}
