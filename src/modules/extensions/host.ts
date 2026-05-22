/**
 * Builds the `ExtensionContext` passed to each extension's `activate(ctx)`.
 * Calls are gated against `manifest.permissions`. See `permissions.ts`.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit as tauriEmit, listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "@/components/ui/toast";

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
import {
  PermissionDeniedError,
  isInvokeAllowed,
  requirePermission,
} from "./permissions";
import { useRightPanelStore } from "./rightPanelStore";
import {
  mountFolderTree,
  type MountedFolderTree,
  type MountFolderTreeOptions,
} from "./components/mountFolderTree";
import {
  aiToolsRegistry,
  commandsRegistry,
  editorThemesRegistry,
  keybindingsRegistry,
  panelRenderersRegistry,
  panelsRegistry,
  settingsRegistry,
  shellTransformersRegistry,
  slashCommandsRegistry,
  statusItemsRegistry,
  themesRegistry,
  type PanelRenderer,
  type ShellCommandTransformer,
  type StatusItem,
} from "./registries";

export type ExtensionRuntime = {
  id: string;
  /** Absolute path of the extension's install folder. Used to build sidecar
   *  binary paths before spawning via `shell_bg_spawn`. */
  root: string;
  manifest: { permissions: string[] };
};

/** OS snapshot exposed via `ctx.os`. Resolved once at module load. */
export type ExtensionOs = {
  platform: "windows" | "macos" | "linux" | "ios" | "android" | "unknown";
  arch: "x86_64" | "aarch64" | "x86" | "arm" | "unknown";
};

let cachedOs: ExtensionOs | null = null;

async function detectOs(): Promise<ExtensionOs> {
  if (cachedOs) return cachedOs;
  try {
    const mod = await import("@tauri-apps/plugin-os");
    const rawPlatform = mod.platform();
    const rawArch = mod.arch();
    const platform: ExtensionOs["platform"] =
      rawPlatform === "windows" || rawPlatform === "macos" || rawPlatform === "linux"
        ? rawPlatform
        : rawPlatform === "android" || rawPlatform === "ios"
          ? rawPlatform
          : "unknown";
    const arch: ExtensionOs["arch"] =
      rawArch === "x86_64" || rawArch === "aarch64" || rawArch === "x86" || rawArch === "arm"
        ? rawArch
        : "unknown";
    cachedOs = { platform, arch };
  } catch {
    cachedOs = { platform: "unknown", arch: "unknown" };
  }
  return cachedOs;
}

type Disposer = () => void;

/** App-state snapshot exposed to extensions. Add fields when needed. */
export type AppContextSnapshot = {
  workspaceCwd: string | null;
  activeFileName: string | null;
  terminalCount: number;
  /** Kind of the focused tab. `null` when no tab is active. */
  activeTabKind: "terminal" | "ssh" | "editor" | "diff" | "preview" | null;
};

export type ExtensionContext = {
  id: string;
  /** Absolute path of the extension's install folder. Join with the sidecar
   *  binary path before calling `shell_bg_spawn`. */
  installPath: string;
  /** Static OS info (platform + arch). Resolved once at module load. */
  os: ExtensionOs;
  /** Per-extension storage backed by `tauri-plugin-store`. JSON file
   *  `tedi-ext-<id>.json`. */
  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Read-only view of app state. See `appBridge.ts`. */
  app: {
    getContext(): AppContextSnapshot;
    onContextChange(cb: (ctx: AppContextSnapshot) => void): Disposer;
  };
  /** Read/write app settings. Writes require `settings:write`. */
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    onChange(key: string, cb: (value: unknown) => void): Disposer;
  };
  /** Invoke a Rust command. Each command id needs an `invoke:` permission. */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** OS-keychain bridge. Both branches gated. */
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
  };
  /** Event bus namespaced as `ext://<id>/<name>` to prevent name collisions. */
  events: {
    emit(name: string, payload?: unknown): Promise<void>;
    on(name: string, cb: (payload: unknown) => void): Promise<Disposer>;
  };
  /** Toast / mount helpers. */
  ui: {
    toast(
      message: string,
      opts?: { variant?: "default" | "success" | "info" | "warning" | "error" },
    ): void;
    /** Mount TEDI's built-in folder explorer into a container the extension
     *  owns. No permission required: read-only render, click-to-open routes
     *  through the same workspace bridge as the built-in explorer. */
    mountFolderTree(container: HTMLElement, options: MountFolderTreeOptions): MountedFolderTree;
  };
  /** Status-bar icons in the bottom-right. Multiple items per extension;
   *  keyed by `id`. Removed automatically on `deactivate`. */
  statusBar: {
    setItem(item: StatusItem): void;
    removeItem(itemId: string): void;
  };
  /** AI shell hook. Registers a synchronous transformer that rewrites
   *  commands before `bash_run`, `bash_background`, `run_in_terminal`, and
   *  `suggest_command` execute. Receives the command and a `kind`
   *  discriminator; return the rewritten string (or the original to pass
   *  through). Transformers compose in insertion order; each call is wrapped
   *  in try/catch. The returned `Disposer` clears this extension's
   *  registration; the host also disposes on `deactivate`.
   *  Requires `shell:transform`. */
  shell: {
    registerCommandTransformer(transformer: ShellCommandTransformer): Disposer;
  };
  /** Mounts a right-panel renderer. Pair with a `panels[]` manifest entry
   *  whose `surface` is `"right"`. The renderer gets a fresh `<div>`; return
   *  a cleanup callback. Requires `panels:register`. Auto-disposed on
   *  `deactivate`. */
  registerPanelRenderer(panelId: string, renderer: PanelRenderer): Disposer;
  /** Imperative right-panel controls scoped to this extension.
   *  `close()` and `toggle()` only act on a panel this extension owns.
   *  Requires `panels:register`. */
  panel: {
    open(panelId: string): void;
    close(panelId?: string): void;
    toggle(panelId: string): void;
  };
  /** Contribution helpers. Each call replaces the previous declaration for
   *  that category; pass `[]` to clear. */
  contribute: {
    settings(items: ContributedSetting[]): void;
    commands(items: ContributedCommand[]): void;
    keybindings(items: ContributedKeybinding[]): void;
    slashCommands(items: ContributedSlashCommand[]): void;
    themes(items: ContributedTheme[]): void;
    editorThemes(items: ContributedEditorTheme[]): void;
    panels(items: ContributedPanel[]): void;
    aiTools(items: ContributedAiTool[]): void;
  };
  /** Binds a JS handler to a contributed command id. The command must be
   *  declared in `contribute.commands` first. */
  registerCommandHandler(commandId: string, handler: (...args: unknown[]) => unknown): void;
  /** Binds a handler to a contributed AI tool. The host packages the result
   *  for the AI SDK. */
  registerAiToolHandler(
    toolName: string,
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ): void;
  /** Logger that prefixes the extension id. */
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** Registers a disposer to run on deactivate. The wrappers above already
   *  call this; most callers don't need it. */
  addDisposer(d: Disposer): void;
};

const STORAGE_FILE = (id: string) => `tedi-ext-${id}.json`;

/**
 * Builds the per-extension storage facade. Lazy-imports `tauri-plugin-store`
 * so the LazyStore is only created on first use.
 */
async function buildStorage(id: string): Promise<ExtensionContext["storage"]> {
  const { LazyStore } = await import("@tauri-apps/plugin-store");
  const store = new LazyStore(STORAGE_FILE(id), { defaults: {}, autoSave: 200 });
  return {
    async get<T>(key: string): Promise<T | null> {
      const v = await store.get<T>(key);
      return v ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await store.set(key, value);
      await store.save();
    },
    async delete(key: string): Promise<void> {
      await store.delete(key);
      await store.save();
    },
  };
}

export async function buildContext(ext: ExtensionRuntime): Promise<{
  context: ExtensionContext;
  dispose: () => Promise<void>;
}> {
  const disposers: Disposer[] = [];
  const storage = await buildStorage(ext.id);
  const declared = ext.manifest.permissions;
  const log = (level: "info" | "warn" | "error", args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console[level](`[ext:${ext.id}]`, ...args);
  };

  const addDisposer = (d: Disposer): void => {
    disposers.push(d);
  };

  const { getAppContext, subscribeAppContext } = await import("./appBridge");
  const os = await detectOs();

  const context: ExtensionContext = {
    id: ext.id,
    installPath: ext.root,
    os,
    storage,
    app: {
      getContext: () => getAppContext(),
      onContextChange: (cb) => {
        const dispose = subscribeAppContext(cb);
        disposers.push(dispose);
        return dispose;
      },
    },
    settings: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        requirePermission(ext.id, declared, "settings:read");
        const mod = await import("@/modules/settings/store");
        // Namespaced under the extension id. Built-in settings are off-limits
        // here; a future `settings:read-builtin` permission could open them.
        const ns = `ext:${ext.id}:${key}`;
        return (await mod._readAny<T>(ns)) ?? undefined;
      },
      async set<T>(key: string, value: T): Promise<void> {
        requirePermission(ext.id, declared, "settings:write");
        const mod = await import("@/modules/settings/store");
        const ns = `ext:${ext.id}:${key}`;
        await mod._writeAny(ns, value);
      },
      onChange(key: string, cb: (value: unknown) => void) {
        requirePermission(ext.id, declared, "settings:read");
        const ns = `ext:${ext.id}:${key}`;
        let unsub: (() => void) | null = null;
        let disposed = false;
        // Async subscribe. If the caller disposes before the unlisten fn
        // lands, drop it on resolve so nothing leaks past `deactivate`.
        void import("@/modules/settings/store").then(({ _onAnyChange }) =>
          _onAnyChange((k, v) => {
            if (disposed || k !== ns) return;
            cb(v);
          }).then((fn) => {
            if (disposed) {
              fn();
            } else {
              unsub = fn;
            }
          }),
        );
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          unsub?.();
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    async invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (!isInvokeAllowed(declared, command)) {
        throw new PermissionDeniedError(ext.id, `invoke:${command}`);
      }
      return tauriInvoke<T>(command, args);
    },
    secrets: {
      async get(name: string) {
        requirePermission(ext.id, declared, "secrets:read");
        // Namespaced so extensions can't guess each other's keys.
        const ns = `ext:${ext.id}:${name}`;
        return tauriInvoke<string | null>("secrets_get", { name: ns });
      },
      async set(name: string, value: string) {
        requirePermission(ext.id, declared, "secrets:write");
        const ns = `ext:${ext.id}:${name}`;
        await tauriInvoke("secrets_set", { name: ns, value });
      },
    },
    events: {
      async emit(name: string, payload?: unknown) {
        requirePermission(ext.id, declared, "events:emit");
        await tauriEmit(`ext://${ext.id}/${name}`, payload);
      },
      async on(name: string, cb: (payload: unknown) => void): Promise<Disposer> {
        requirePermission(ext.id, declared, "events:listen");
        let unsub: UnlistenFn | null = null;
        let disposed = false;
        // Per-extension channel prevents event-name collisions.
        void tauriListen(`ext://${ext.id}/${name}`, (event) => cb(event.payload)).then(
          (fn) => {
            if (disposed) {
              fn();
            } else {
              unsub = fn;
            }
          },
        );
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          unsub?.();
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    ui: {
      toast(
        message: string,
        opts?: { variant?: "default" | "success" | "info" | "warning" | "error" },
      ) {
        requirePermission(ext.id, declared, "ui:toast");
        toast(message, { variant: opts?.variant ?? "default" });
      },
      mountFolderTree(container: HTMLElement, options: MountFolderTreeOptions): MountedFolderTree {
        const mounted = mountFolderTree(container, options);
        // Auto-dispose on deactivate so React roots don't leak.
        disposers.push(() => mounted.dispose());
        return mounted;
      },
    },
    statusBar: {
      setItem(item: StatusItem) {
        requirePermission(ext.id, declared, "statusbar:write");
        statusItemsRegistry.setItem(ext.id, item);
      },
      removeItem(itemId: string) {
        // No permission check: an extension can always remove its own item,
        // even after a revoke.
        statusItemsRegistry.removeItem(ext.id, itemId);
      },
    },
    shell: {
      registerCommandTransformer(transformer: ShellCommandTransformer): Disposer {
        requirePermission(ext.id, declared, "shell:transform");
        shellTransformersRegistry.set(ext.id, transformer);
        const dispose = (): void => shellTransformersRegistry.clear(ext.id);
        // Host disposes on disable/uninstall so the chain falls back to passthrough.
        disposers.push(dispose);
        return dispose;
      },
    },
    registerPanelRenderer(panelId: string, renderer: PanelRenderer): Disposer {
      requirePermission(ext.id, declared, "panels:register");
      panelRenderersRegistry.set(ext.id, panelId, renderer);
      const dispose = (): void => panelRenderersRegistry.remove(ext.id, panelId);
      disposers.push(dispose);
      return dispose;
    },
    panel: {
      open(panelId: string) {
        requirePermission(ext.id, declared, "panels:register");
        useRightPanelStore.getState().open(ext.id, panelId);
      },
      close(panelId?: string) {
        const store = useRightPanelStore.getState();
        const active = store.active;
        if (!active || active.extensionId !== ext.id) return;
        if (panelId !== undefined && active.panelId !== panelId) return;
        store.close();
      },
      toggle(panelId: string) {
        requirePermission(ext.id, declared, "panels:register");
        useRightPanelStore.getState().toggle(ext.id, panelId);
      },
    },
    contribute: {
      settings(items) {
        settingsRegistry.set(ext.id, items);
      },
      commands(items) {
        commandsRegistry.set(ext.id, items);
      },
      keybindings(items) {
        keybindingsRegistry.set(ext.id, items);
      },
      slashCommands(items) {
        slashCommandsRegistry.set(ext.id, items);
      },
      themes(items) {
        themesRegistry.set(ext.id, items);
      },
      editorThemes(items) {
        editorThemesRegistry.set(ext.id, items);
      },
      panels(items) {
        requirePermission(ext.id, declared, "panels:register");
        panelsRegistry.set(ext.id, items);
      },
      aiTools(items) {
        aiToolsRegistry.set(ext.id, items);
      },
    },
    registerCommandHandler(commandId, handler) {
      commandsRegistry.setRuntime(ext.id, commandId, handler);
    },
    registerAiToolHandler(toolName, handler) {
      aiToolsRegistry.setRuntime(ext.id, toolName, handler);
    },
    logger: {
      info: (...args) => log("info", args),
      warn: (...args) => log("warn", args),
      error: (...args) => log("error", args),
    },
    addDisposer,
  };

  const dispose = async (): Promise<void> => {
    // Reverse order: release last-acquired first.
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch (err) {
        log("error", ["disposer threw", err]);
      }
    }
  };

  return { context, dispose };
}
