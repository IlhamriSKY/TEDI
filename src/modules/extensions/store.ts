/**
 * Zustand store for the extension subsystem. Settings UI reads from here;
 * mutations route through actions so the in-memory list and activated set
 * stay consistent with the Rust state file.
 * Only the "main" window activates extensions. The settings window
 * lists/installs/uninstalls and emits `tedi://ext-changed` so main can
 * `loader.reload(id)`. Without the gate, both webviews call `activate()`
 * and singleton extensions double-fire.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { toast } from "@/components/ui/toast";
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
    // Outside Tauri (storybook, vitest): behave like main.
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
  /** Most-recent install/enable/uninstall error. Cleared on next attempt;
   *  surfaced in the dialog. */
  lastError: string | null;
  /** Ids currently mid-update; the card shows a spinner overlay. Bulk
   *  Check + Update can run several in parallel. */
  updatingIds: Set<string>;
};

type Actions = {
  init(): Promise<void>;
  refresh(): Promise<void>;
  install(
    source:
      | { kind: "zip"; path: string }
      | { kind: "github"; repo: string },
    /** Manifest id from a prior `ext_peek_*` call. When set, deactivates any
     *  existing extension with this id before Rust runs the install pipeline,
     *  releasing Windows file handles so the replace step doesn't hit
     *  "Access is denied". */
    expectedId?: string,
    /** Permissions the user approved in the review dialog (the peeked
     *  manifest's `permissions`). Rust refuses the install if the real package
     *  requests anything beyond this set, so the GitHub fast-peek (which reads
     *  the manifest from raw.githubusercontent.com) can't be used to slip an
     *  escalated permission past the dialog. */
    approvedPermissions?: readonly string[],
  ): Promise<InstalledExtension>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  uninstall(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  /** Fetches the latest GitHub tag for one extension. No-op for non-github
   *  sources; still bumps `last_checked_at_ms`. */
  checkUpdate(id: string): Promise<UpdateCheckResult>;
  /** Runs `checkUpdate` for every github-sourced extension in parallel.
   *  Per-extension errors are logged, not thrown; the count of failed checks
   *  is returned so the caller can warn instead of falsely reporting
   *  "up to date" when a rate limit or network error blocked the check. */
  checkAllUpdates(): Promise<{ failed: number }>;
  /** Re-installs the github-sourced extension at its newest release. Runs
   *  the full install pipeline (manifest validation, permission diff). */
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
        // Only main activates. Other windows refresh the list and sync
        // via `tedi://ext-changed`.
        const list = isMainWindow() ? await loader.bootAll() : await loader.listInstalled();
        // Settings webview is a separate JS context with empty registries;
        // seed manifest contributions so the Extensions tab can render.
        if (!isMainWindow()) {
          for (const ext of list) loader.seedManifestContributions(ext);
        }
        set({ list, hydrated: true });
        // Cross-window sync: settings installs an ext, main reloads.
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
          // Refresh list in every window.
          const list = await loader.listInstalled();
          // Re-seed on non-main so the Extensions tab renders toggles
          // for newly installed/updated extensions without a webview reload.
          if (!isMainWindow()) {
            for (const ext of list) loader.seedManifestContributions(ext);
          }
          set({ list });
        });
        // Stash unlisten on a global for HMR cleanup.
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
  install: async (source, expectedId, approvedPermissions) => {
    set({ lastError: null });
    try {
      // Tear down the prior copy before Rust installs. Rust has a
      // rename-to-trash fallback for files-in-use, but deactivating first
      // releases handles cleanly and removes the trash immediately.
      if (expectedId && isMainWindow()) {
        await loader.deactivate(expectedId);
      }
      // Pass the approved permission set (when the install came from the
      // review dialog) so Rust can reject a package that requests more than
      // the user saw. Spread to a plain array for the IPC boundary.
      const approved = approvedPermissions ? [...approvedPermissions] : undefined;
      let entry: InstalledExtension;
      if (source.kind === "zip") {
        entry = (await invoke("ext_install_from_zip", {
          zipPath: source.path,
          approvedPermissions: approved,
        })) as InstalledExtension;
      } else {
        entry = (await invoke("ext_install_from_github", {
          repo: source.repo,
          approvedPermissions: approved,
        })) as InstalledExtension;
      }
      // Main activates immediately; others wait for the broadcast.
      // Refresh the local list so the settings card appears now.
      if (isMainWindow()) {
        await loader.reload(entry.id, entry);
      }
      // Clear icon cache so the card re-fetches if the icon changed.
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
        if (fresh) {
          await loader.activate(fresh).catch((e) => {
            console.error(e);
            // Surface enable-time activation failures the same way boot does,
            // so toggling an extension on gives immediate feedback.
            const msg = e instanceof Error ? e.message : String(e);
            toast(`Extension "${fresh.manifest.name}" failed to activate: ${msg}`, {
              variant: "error",
            });
          });
        }
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
    // Refresh list to pull the new `latest_version` and `last_checked_at_ms`.
    const list = await loader.listInstalled();
    set({ list });
    return result;
  },
  checkAllUpdates: async () => {
    const list = get().list;
    const candidates = list.filter((e) => e.source.startsWith("github:"));
    const results = await Promise.allSettled(
      candidates.map((e) => invoke("ext_check_update", { id: e.id })),
    );
    let failed = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        failed += 1;
        console.error("[extensions] check update failed", r.reason);
      }
    }
    const fresh = await loader.listInstalled();
    set({ list: fresh });
    return { failed };
  },
  updateExtension: async (id) => {
    set({ lastError: null });
    // Mark id as updating so the card shows a spinner. Cleared in finally.
    const updating = new Set(get().updatingIds);
    updating.add(id);
    set({ updatingIds: updating });
    try {
      const entry = get().list.find((e) => e.id === id);
      if (!entry) throw new Error(`extension not installed: ${id}`);
      const repo = entry.source.startsWith("github:")
        ? entry.source.slice("github:".length)
        : null;
      if (!repo) {
        throw new Error(
          "Extensions installed from a local .zip can't auto-update. Re-install via Settings, Extensions, From file.",
        );
      }
      // Deactivate before Rust replaces the folder. See `install()` for
      // the Windows file-lock rationale.
      if (isMainWindow()) {
        await loader.deactivate(id);
      }
      // Bound the grant to what was already approved: this path runs only when
      // the pre-update peek found no new permissions, so the new release must
      // not request more than the current grant. If it does, Rust rejects the
      // install and the user is told to re-review (rather than silently
      // widening the grant).
      const next = (await invoke("ext_install_from_github", {
        repo,
        approvedPermissions: [...entry.approved_permissions],
      })) as InstalledExtension;
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

export type { InstalledExtension };
