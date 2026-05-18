// Minimal Tauri runtime stub for vanilla-browser preview (vite dev).
// When the real Tauri runtime injects __TAURI_INTERNALS__ first, this no-ops.
// Backs @tauri-apps/plugin-store with localStorage so settings persist across reloads;
// every other native command resolves to undefined/empty — UI renders but native
// features (terminal, fs, scm, ssh, dialog, updater, opener) stay inert.

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

type InvokeArgs = Record<string, unknown> | undefined;
type Listener = (event: { event: string; id: number; payload: unknown }) => void;

interface TauriInternals {
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string; windowLabel: string };
  };
  invoke: (cmd: string, args?: InvokeArgs, opts?: unknown) => Promise<unknown>;
  transformCallback: (cb?: (payload: unknown) => void, once?: boolean) => number;
  unregisterCallback?: (id: number) => void;
  convertFileSrc?: (path: string, protocol?: string) => string;
  plugins?: Record<string, unknown>;
}

if (typeof window !== "undefined" && !window.__TAURI_INTERNALS__) {

  console.warn(
    "[tauri-browser-shim] No Tauri runtime detected — installing stub APIs. " +
      "UI renders for preview only; native commands return empty results.",
  );

  const ua = navigator.userAgent.toLowerCase();
  const detectedPlatform: "windows" | "macos" | "linux" | "android" | "ios" = ua.includes("win")
    ? "windows"
    : ua.includes("mac")
      ? "macos"
      : ua.includes("android")
        ? "android"
        : ua.includes("iphone") || ua.includes("ipad")
          ? "ios"
          : "linux";

  // Backing storage for @tauri-apps/plugin-store. One bucket per store path,
  // serialized as JSON in localStorage.
  const STORE_PREFIX = "tedi:shim:store:";
  type StoreData = Record<string, unknown>;
  const loadStore = (path: string): StoreData => {
    try {
      return JSON.parse(localStorage.getItem(STORE_PREFIX + path) || "{}");
    } catch {
      return {};
    }
  };
  const saveStore = (path: string, data: StoreData): void => {
    try {
      localStorage.setItem(STORE_PREFIX + path, JSON.stringify(data));
    } catch {
      // quota / private mode — ignore
    }
  };

  // transformCallback assigns unique IDs to async-result callbacks the Tauri
  // bindings register for invoke completions and event subscriptions.
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextId = 1;
  const transformCallback = (cb?: (payload: unknown) => void, once = false): number => {
    const id = ++nextId;
    if (cb) {
      const wrapped = once
        ? (payload: unknown) => {
            callbacks.delete(id);
            cb(payload);
          }
        : cb;
      callbacks.set(id, wrapped);
    }
    return id;
  };
  const unregisterCallback = (id: number): void => {
    callbacks.delete(id);
  };

  // Event bus for plugin:event|listen / emit so React effects that subscribe
  // to internal events don't immediately reject. Events are in-process only —
  // nothing crosses to Rust because Rust isn't running.
  const listeners = new Map<string, Set<{ id: number; cb: Listener }>>();

  const isPluginEvent = (cmd: string, op: string): boolean => cmd === `plugin:event|${op}`;

  const handleStore = (op: string, args: InvokeArgs): unknown => {
    const a = (args ?? {}) as Record<string, unknown>;
    const rid = String(a.rid ?? a.path ?? "");
    const key = String(a.key ?? "");

    switch (op) {
      case "load":
        return rid;
      case "get": {
        const data = loadStore(rid);
        const has = Object.prototype.hasOwnProperty.call(data, key);
        return has ? [data[key], true] : [null, false];
      }
      case "set": {
        const data = loadStore(rid);
        data[key] = a.value;
        saveStore(rid, data);
        return null;
      }
      case "has":
        return Object.prototype.hasOwnProperty.call(loadStore(rid), key);
      case "delete": {
        const data = loadStore(rid);
        const had = Object.prototype.hasOwnProperty.call(data, key);
        delete data[key];
        saveStore(rid, data);
        return had;
      }
      case "clear":
      case "reset":
        saveStore(rid, {});
        return null;
      case "keys":
        return Object.keys(loadStore(rid));
      case "values":
        return Object.values(loadStore(rid));
      case "entries":
        return Object.entries(loadStore(rid));
      case "length":
        return Object.keys(loadStore(rid)).length;
      case "save":
      case "close":
      case "reload":
        return null;
      default:
        return null;
    }
  };

  const handleEvent = (op: string, args: InvokeArgs): unknown => {
    const a = (args ?? {}) as Record<string, unknown>;
    const event = String(a.event ?? "");
    const handler = Number(a.handler ?? 0);

    if (op === "listen") {
      const cb = callbacks.get(handler);
      const id = ++nextId;
      if (cb) {
        const wrapped: Listener = (ev) => cb(ev);
        const set = listeners.get(event) ?? new Set();
        set.add({ id, cb: wrapped });
        listeners.set(event, set);
      }
      return id;
    }
    if (op === "unlisten") {
      const eventId = Number(a.eventId ?? 0);
      for (const [evt, set] of listeners) {
        for (const entry of set) {
          if (entry.id === eventId) {
            set.delete(entry);
            if (set.size === 0) listeners.delete(evt);
            return null;
          }
        }
      }
      return null;
    }
    if (op === "emit" || op === "emit_to") {
      const set = listeners.get(event);
      if (set) {
        for (const { id, cb } of set) {
          try {
            cb({ event, id, payload: a.payload });
          } catch {
            // listener threw — keep dispatching
          }
        }
      }
      return null;
    }
    return null;
  };

  const handleOs = (op: string): unknown => {
    switch (op) {
      case "platform":
        return detectedPlatform;
      case "version":
        return "0.0.0";
      case "family":
        return detectedPlatform === "windows" ? "windows" : "unix";
      case "arch":
        return "x86_64";
      case "locale":
        return navigator.language || "en-US";
      case "hostname":
        return location.hostname || "browser";
      case "eol":
        return detectedPlatform === "windows" ? "\r\n" : "\n";
      case "exe_extension":
        return detectedPlatform === "windows" ? "exe" : "";
      default:
        return null;
    }
  };

  const invoke = async (cmd: string, args?: InvokeArgs): Promise<unknown> => {
    // Tauri uses cmd format "plugin:<name>|<op>" for plugin commands and
    // bare command names for app-defined IPC. Stub the plugins we know are
    // imported during startup so React effects don't reject; everything else
    // resolves to null and lets the caller fall back gracefully (or fail at
    // the call site, where the warning above tells the dev what's missing).
    if (cmd.startsWith("plugin:store|")) {
      return handleStore(cmd.slice("plugin:store|".length), args);
    }
    if (cmd.startsWith("plugin:event|") || isPluginEvent(cmd, "listen")) {
      return handleEvent(cmd.slice("plugin:event|".length), args);
    }
    if (cmd.startsWith("plugin:os|")) {
      return handleOs(cmd.slice("plugin:os|".length));
    }
    if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) {
      // show/hide/focus/setSize/etc. on the (nonexistent) Tauri window
      return null;
    }
    if (cmd.startsWith("plugin:process|")) {
      return null;
    }
    if (cmd.startsWith("plugin:log|")) {
      return null;
    }
    if (cmd.startsWith("plugin:dialog|")) {
      // open() / save() / message() / ask() — return null so callers treat as cancelled
      return null;
    }
    if (cmd.startsWith("plugin:opener|")) {
      return null;
    }
    if (cmd.startsWith("plugin:autostart|")) {
      return cmd.endsWith("|is_enabled") ? false : null;
    }
    if (cmd.startsWith("plugin:updater|")) {
      return null;
    }
    if (cmd.startsWith("plugin:window-state|")) {
      return null;
    }
    // App-defined IPC commands (Rust #[tauri::command]) — no Rust to call.
    return null;
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    invoke,
    transformCallback,
    unregisterCallback,
    convertFileSrc: (path: string) => path,
    plugins: {},
  };
}

export {};
