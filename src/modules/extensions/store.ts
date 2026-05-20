/**
 * Zustand store fronting the extension subsystem. The settings UI reads
 * from here; mutations (install, enable/disable, uninstall) are funneled
 * through these actions so the in-memory list and the activated set stay
 * consistent with the Rust state file.
 *
 * Window split: only the "main" window activates extensions. The
 * settings window just lists/installs/uninstalls them and emits a
 * `tedi:ext-changed` Tauri event so main can `loader.reload(id)`.
 * Without this gate, two webviews each call `activate()` and any
 * singleton-ish extension (presence integrations, sidecars, ...)
 * double-fires.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { evictExtensionIcon } from "./icon";
import * as loader from "./loader";
import type { InstalledExtension, UpdateCheckResult } from "./loader";

const EXT_CHANGED_EVENT = "tedi://ext-changed";

type ExtChangedPayload =
  | { kind: "installed" | "reloaded"; id: string }
  | { kind: "removed"; id: string };

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    // Outside Tauri (storybook, vitest) - behave like main.
    return true;
  }
}

async function announce(payload: ExtChangedPayload): Promise<void> {
  try {
    await emit(EXT_CHANGED_EVENT, payload);
  } catch {
    // Tauri may not be available in some test contexts.
  }
}

type State = {
  hydrated: boolean;
  list: InstalledExtension[];
  /** Most-recent error from an install/enable/uninstall attempt - cleared
   *  on next attempt. The UI surfaces these in the dialog. */
  lastError: string | null;
  /** IDs currently mid-update so the card can show a spinner overlay.
   *  Multiple updates may be in flight (bulk Check + Update) so a Set
   *  is the right shape, not a single boolean. */
  updatingIds: Set<string>;
};

type Actions = {
  init(): Promise<void>;
  refresh(): Promise<void>;
  install(
    source:
      | { kind: "zip"; path: string }
      | { kind: "github"; repo: string },
    /** Manifest id learned from a prior `ext_peek_*` call. When set, the
     *  store deactivates any existing extension with this id before the
     *  Rust install pipeline runs - on Windows this releases the file
     *  handles a running sidecar would otherwise hold on the old folder,
     *  preventing "Access is denied" during the replace step. */
    expectedId?: string,
  ): Promise<InstalledExtension>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  uninstall(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  /** Hit GitHub for the latest tag of a single extension. No-op for
   *  non-github sources (still bumps `last_checked_at_ms` so the UI
   *  reflects the attempt). */
  checkUpdate(id: string): Promise<UpdateCheckResult>;
  /** Run `checkUpdate` for every github-sourced extension in parallel.
   *  Resolves once all checks settle (errors are logged, not thrown). */
  checkAllUpdates(): Promise<void>;
  /** Re-install the github-sourced extension at its newest release. The
   *  upstream zip is fetched anew via `ext_install_from_github` so the
   *  install pipeline (manifest validation, permission diff, etc.) runs
   *  end-to-end - mirrors the manual install path. */
  updateExtension(id: string): Promise<InstalledExtension>;
};

let booting: Promise<void> | null = null;

export const useExtensionsStore = create<State & Actions>((set, get) => ({
  hydrated: false,
  list: [],
  lastError: null,
  updatingIds: new Set<string>(),
  init: async () => {
    if (booting) return booting;
    booting = (async () => {
      try {
        // Only the main window activates extensions. Non-main windows
        // (settings) just refresh the list. Cross-window sync happens
        // via the `tedi://ext-changed` event below.
        const list = isMainWindow() ? await loader.bootAll() : await loader.listInstalled();
        // Settings webview is a separate JS context; its registries
        // start empty because the loader's activate path never runs
        // there. Seed manifest contributions so the Extensions tab
        // can render toggles / themes / etc. for every installed ext.
        if (!isMainWindow()) {
          for (const ext of list) loader.seedManifestContributions(ext);
        }
        set({ list, hydrated: true });
        // Listen for changes triggered by other windows (e.g. user
        // installs an extension in the settings window -> main reloads).
        const unlisten = await listen<ExtChangedPayload>(EXT_CHANGED_EVENT, async (e) => {
          const payload = e.payload;
          if (isMainWindow()) {
            try {
              if (payload.kind === "removed") {
                await loader.deactivate(payload.id);
              } else {
                await loader.reload(payload.id);
              }
            } catch (err) {
              console.error(`[extensions] sync ${payload.kind} ${payload.id} failed`, err);
            }
          }
          // Refresh local list view in every window.
          const list = await loader.listInstalled();
          // Re-seed manifest contributions on non-main windows so
          // newly installed / updated extensions render their toggles
          // in the Extensions tab without needing a webview reload.
          if (!isMainWindow()) {
            for (const ext of list) loader.seedManifestContributions(ext);
          }
          set({ list });
        });
        // Stash the unlisten on a non-stateful global so HMR cleans up.
        if (typeof window !== "undefined") {
          const w = window as unknown as { __tediExtUnlisten?: () => void };
          w.__tediExtUnlisten?.();
          w.__tediExtUnlisten = unlisten;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[extensions] init failed", err);
        set({ hydrated: true, lastError: msg });
      }
    })();
    return booting;
  },
  refresh: async () => {
    const list = await loader.listInstalled();
    set({ list });
  },
  install: async (source, expectedId) => {
    set({ lastError: null });
    try {
      // Belt and suspenders: tear down the prior copy of this
      // extension (if any) before the Rust install runs. Rust has a
      // rename-to-trash fallback for the "files in use" case, but
      // deactivating first means the helper process releases its
      // handles cleanly and the trash gets removed immediately
      // rather than waiting for the sweep.
      if (expectedId && isMainWindow()) {
        await loader.deactivate(expectedId);
      }
      let entry: InstalledExtension;
      if (source.kind === "zip") {
        entry = (await invoke("ext_install_from_zip", {
          zipPath: source.path,
        })) as InstalledExtension;
      } else {
        entry = (await invoke("ext_install_from_github", {
          repo: source.repo,
        })) as InstalledExtension;
      }
      // In the main window we activate immediately; in others we let
      // the broadcast wake the main window's loader. Either way refresh
      // the local list so the settings card shows up right away.
      if (isMainWindow()) {
        await loader.reload(entry.id, entry);
      }
      // Re-install may have shipped a different icon; clear the cache so
      // the card re-fetches.
      evictExtensionIcon(entry.id);
      await announce({ kind: "installed", id: entry.id });
      const list = await loader.listInstalled();
      set({ list });
      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ lastError: msg });
      throw err;
    }
  },
  setEnabled: async (id, enabled) => {
    if (enabled) {
      await invoke("ext_enable", { id });
      const list = await loader.listInstalled();
      set({ list });
      if (isMainWindow()) {
        const fresh = list.find((e) => e.id === id);
        if (fresh) await loader.activate(fresh).catch((e) => console.error(e));
      }
      await announce({ kind: "installed", id });
    } else {
      await invoke("ext_disable", { id });
      if (isMainWindow()) {
        await loader.deactivate(id);
      }
      const list = await loader.listInstalled();
      set({ list });
      await announce({ kind: "removed", id });
    }
  },
  uninstall: async (id) => {
    if (isMainWindow()) {
      await loader.deactivate(id);
    }
    await invoke("ext_uninstall", { id });
    evictExtensionIcon(id);
    const list = await loader.listInstalled();
    set({ list });
    await announce({ kind: "removed", id });
  },
  reload: async (id) => {
    if (isMainWindow()) {
      await loader.reload(id);
    }
    const list = await loader.listInstalled();
    set({ list });
    await announce({ kind: "reloaded", id });
  },
  checkUpdate: async (id) => {
    const result = (await invoke("ext_check_update", { id })) as UpdateCheckResult;
    // Refresh local list to pull the new `latest_version` /
    // `last_checked_at_ms` Rust just persisted.
    const list = await loader.listInstalled();
    set({ list });
    return result;
  },
  checkAllUpdates: async () => {
    const list = get().list;
    const candidates = list.filter((e) => e.source.startsWith("github:"));
    await Promise.allSettled(
      candidates.map((e) =>
        invoke("ext_check_update", { id: e.id }).catch((err) => {
          console.error(`[extensions] check update for ${e.id} failed`, err);
        }),
      ),
    );
    const fresh = await loader.listInstalled();
    set({ list: fresh });
  },
  updateExtension: async (id) => {
    set({ lastError: null });
    // Mark this id as "currently updating" so the card can render a
    // spinner overlay. Cleared in the `finally` below regardless of
    // success / failure.
    const updating = new Set(get().updatingIds);
    updating.add(id);
    set({ updatingIds: updating });
    try {
      const entry = list_find(get().list, id);
      if (!entry) throw new Error(`extension not installed: ${id}`);
      const repo = entry.source.startsWith("github:")
        ? entry.source.slice("github:".length)
        : null;
      if (!repo) {
        throw new Error(
          "Extensions installed from a local .zip can't auto-update — re-install with the new .zip from Settings → Extensions → From file.",
        );
      }
      // Deactivate the current copy before the Rust install replaces
      // its folder. See `install()` above for the Windows file-lock
      // rationale; updates always hit the same id so the deactivate
      // target is always known up front.
      if (isMainWindow()) {
        await loader.deactivate(id);
      }
      const next = (await invoke("ext_install_from_github", { repo })) as InstalledExtension;
      if (isMainWindow()) {
        await loader.reload(next.id, next);
      }
      evictExtensionIcon(next.id);
      await announce({ kind: "reloaded", id: next.id });
      const fresh = await loader.listInstalled();
      set({ list: fresh });
      return next;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ lastError: msg });
      throw err;
    } finally {
      const next = new Set(get().updatingIds);
      next.delete(id);
      set({ updatingIds: next });
    }
  },
}));

function list_find(list: InstalledExtension[], id: string): InstalledExtension | undefined {
  return list.find((e) => e.id === id);
}

export type { InstalledExtension };
