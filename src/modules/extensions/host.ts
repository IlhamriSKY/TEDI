/**
 * Host API factory.
 *
 * `buildContext(extension)` returns the `ExtensionContext` object that we
 * pass to each extension's `activate(ctx)`. Everything here is
 * permission-gated against the manifest's `permissions` array. The raw
 * Tauri `invoke`/event APIs remain reachable via globals - we cannot
 * sandbox a full JS environment from itself - but the extension code is
 * loaded into a Function scope that we control, so well-behaved
 * extensions stick to the host API. Hostile extensions are the trust
 * model's problem (see `permissions.ts` + the install-review dialog).
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
import {
  aiToolsRegistry,
  commandsRegistry,
  editorThemesRegistry,
  keybindingsRegistry,
  panelsRegistry,
  settingsRegistry,
  slashCommandsRegistry,
  statusItemsRegistry,
  themesRegistry,
  type StatusItem,
} from "./registries";

export type ExtensionRuntime = {
  id: string;
  /** Absolute filesystem path of the extension's install folder. Used by
   *  extensions that ship platform-specific sidecar binaries: they
   *  build the binary path via `ctx.installPath` + a relative path, then
   *  spawn through `shell_bg_spawn` (with the matching permission). */
  root: string;
  manifest: { permissions: string[] };
};

/** OS detection snapshot exposed to extensions via `ctx.os`. Resolved
 *  once at module load through `@tauri-apps/plugin-os` so individual
 *  extensions don't each pay the plugin-init cost. */
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

/** Snapshot of app state exposed to extensions. Kept intentionally small -
 *  add fields here when a new extension needs them, not preemptively. */
export type AppContextSnapshot = {
  workspaceCwd: string | null;
  activeFileName: string | null;
  terminalCount: number;
};

export type ExtensionContext = {
  id: string;
  /** Absolute path of the extension's install folder. Extensions ship a
   *  sidecar binary under `sidecar/<platform>/...` should join this with
   *  the binary path before calling `shell_bg_spawn`. */
  installPath: string;
  /** Static OS info (platform + arch) snapshot. Resolved once at module
   *  load - cheaper than calling the os plugin on every read. */
  os: ExtensionOs;
  /** Read/write extension-scoped storage via `tauri-plugin-store`. Backed by
   *  a single JSON file `tedi-ext-<id>.json`. */
  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Read-only view of app state (workspace folder, active file name, open
   *  terminal count). Presence/integration extensions consume this to
   *  derive their own payloads. The host is the single source of truth -
   *  see `appBridge.ts`. */
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
  /** Invoke a Rust command. Each command id must be allowed by an
   *  `invoke:` permission entry. */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** OS-keychain bridge. Both branches gated. */
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
  };
  /** Event bus, automatically namespaced as `ext://<id>/<name>` so two
   *  extensions can't collide on event names. */
  events: {
    emit(name: string, payload?: unknown): Promise<void>;
    on(name: string, cb: (payload: unknown) => void): Promise<Disposer>;
  };
  /** Toast / open tab / log. */
  ui: {
    toast(
      message: string,
      opts?: { variant?: "default" | "success" | "info" | "warning" | "error" },
    ): void;
  };
  /** Runtime status-bar icons shown in the bottom-right. Multiple items
   *  per extension allowed; each is keyed by `id` within the extension's
   *  namespace. Items disappear automatically on `deactivate`. */
  statusBar: {
    setItem(item: StatusItem): void;
    removeItem(itemId: string): void;
  };
  /** Contribution helpers. Each call replaces the previous declaration for
   *  that category; pass `[]` to clear. The activate function would
   *  normally call these once. */
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
  /** Bind a JS handler to a contributed command id. The command must
   *  appear in the contributed-commands list first. */
  registerCommandHandler(commandId: string, handler: (...args: unknown[]) => unknown): void;
  /** Bind a handler to a contributed AI tool name. The host packages the
   *  result so the AI SDK can consume it. */
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
  /** Tracker for disposers the host should run on deactivate. Most callers
   *  don't touch this directly - the wrappers above register themselves
   *  automatically. */
  addDisposer(d: Disposer): void;
};

const STORAGE_FILE = (id: string) => `tedi-ext-${id}.json`;

/**
 * Build the per-extension storage facade. Lazy-imported so the
 * `tauri-plugin-store` LazyStore isn't constructed until the extension
 * actually touches storage.
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
        // Auto-namespace under the extension id. Extensions reading
        // built-in settings is intentionally not supported via this API -
        // those are off-limits to keep blast-radius small. If a future
        // extension needs to read the system theme it should request a
        // dedicated permission like `settings:read-builtin`.
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
        // Subscribe asynchronously - the promise resolves to the
        // unlisten fn. If the caller disposes before we land, swallow
        // the unlisten immediately on resolve so we never leak a
        // listener past `deactivate`.
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
        // Namespace under the extension id so two extensions can't read
        // each other's keys via a guessed name.
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
        // Namespaced channel - per-extension scoping prevents two
        // extensions colliding on the same logical event name.
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
    },
    statusBar: {
      setItem(item: StatusItem) {
        requirePermission(ext.id, declared, "statusbar:write");
        statusItemsRegistry.setItem(ext.id, item);
      },
      removeItem(itemId: string) {
        // No permission check on remove: an extension can always tear
        // down its own item, even if the user has revoked permission
        // post-install (e.g. via a future permission-revoke UI).
        statusItemsRegistry.removeItem(ext.id, itemId);
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
    // Run in reverse so resources released last-acquired-first.
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
