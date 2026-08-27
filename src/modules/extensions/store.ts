import { registerBridge } from "@/modules/automation/bridge";
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
import { aiToolsRegistry, commandsRegistry } from "./registries";

const EXT_CHANGED_EVENT = "tedi://ext-changed";

type ExtChangedPayload = {
  kind: "installed" | "reloaded" | "removed";
  id: string;
  /** Label of the webview that made the change. Tauri v2 self-delivers
   *  emit(), so without this the announcing window ran the whole
   *  deactivate/activate cycle a SECOND time on top of the one it had just
   *  performed directly. Harmless-looking when it happened once per
   *  install; very visible now that saving a file can trigger it. Same
   *  dedupe convention as SELF_LABEL in modules/settings/store.ts. */
  source?: string;
};

/** This webview's label, stamped onto every announce so it can ignore its own. */
function selfLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

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
    await emit(EXT_CHANGED_EVENT, { ...payload, source: selfLabel() });
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
    source: { kind: "zip"; path: string } | { kind: "github"; repo: string },
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
          // Our own announce: whichever action emitted it has already run
          // the activate/deactivate and set the list. Handling it again
          // here is a second full reload of the same extension.
          if (payload.source === selfLabel()) return;
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
        // Watch the files of every enabled extension and reload the ones that
        // change. Main only: it is the window that activates extensions, and
        // two watchers would race each other over the same reload. Imported
        // dynamically because autoReload imports THIS module - a static import
        // either way would be a cycle.
        if (isMainWindow()) {
          void import("./autoReload").then((m) => m.startExtensionAutoReload());
        }
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
      const repo = entry.source.startsWith("github:") ? entry.source.slice("github:".length) : null;
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

/**
 * Automation surface for a driving agent (`scripts/mcp/`, and the MCP
 * server Claude Code talks to). Gated on `TEDI_DEBUG_PORT` like the rest of
 * `window.__tedi`, and merged into it - four files contribute to that object and
 * none may clobber the others (see `shortcuts/lib/commandRegistry.ts`).
 *
 * Extensions were the blind spot. Their panel buttons are clickable like any
 * other, but an extension command lives in a SEPARATE registry from the
 * shortcut one, so `listCommands()` never saw it and `runCommand()` could never
 * reach it - the whole extension command surface was undrivable. And with no
 * list of what is installed, a missing button was indistinguishable from a
 * disabled extension.
 *
 * `extControl` covers the reversible half of the lifecycle - enable, disable,
 * reload, update, uninstall. INSTALL IS DELIBERATELY ABSENT and refuses with the
 * route instead: installing runs third-party code in TEDI's own realm under a
 * permission set the user has to see, and that review dialog lives in the
 * Settings webview. An agent may drive the user to it (`run_command
 * settings.open`); it may not skip it. Every other action only ever turns off,
 * re-reads or removes code the user already approved.
 */
/** Installed extensions and, for each, what it ADDS - the part an agent needs:
 *  a command it can run, a panel it can open, and the AI tools it lends the
 *  built-in agent. */
export function listExtensions() {
  // AI tools come from the REGISTRY, never the manifest. An extension declares
  // them at runtime from `activate()` (`ctx.contributes.aiTools` +
  // `registerAiToolHandler`), so `manifest.contributes.aiTools` is absent for
  // every extension that actually ships any - reading it reported `aiTools: []`
  // for API Client, which contributes five. That is a WRONG answer, not a
  // missing one: an agent reads "this extension lends the AI nothing" and stops
  // looking. Grouped by extension id in one pass so this stays O(n).
  const byExt = new Map<string, { name: string; description?: string }[]>();
  for (const { extensionId, item } of aiToolsRegistry.list()) {
    const list = byExt.get(extensionId) ?? [];
    list.push({ name: item.name, description: item.description });
    byExt.set(extensionId, list);
  }
  return useExtensionsStore.getState().list.map((e) => ({
    id: e.id,
    name: e.manifest.name,
    version: e.version,
    enabled: e.enabled,
    commands: (e.manifest.contributes.commands ?? []).map((c) => ({ id: c.id, title: c.title })),
    panels: (e.manifest.contributes.panels ?? []).map((x) => ({
      id: x.id,
      title: x.title,
      surface: x.surface,
    })),
    // Name AND description: an agent choosing between `api_client_send` and
    // `api_client_save_request` cannot do it from the names alone, and these are
    // the only place those descriptions exist outside the extension's source.
    aiTools: byExt.get(e.id) ?? [],
  }));
}

/** False rather than a throw when nothing answers: a command declared in the
 *  manifest but never given a runtime handler, and one belonging to a DISABLED
 *  extension (deactivation clears the runtime entry), are both ordinary states
 *  an agent should be told about plainly. */
export async function runExtensionCommand(
  extensionId: string,
  id: string,
  args?: Record<string, unknown>,
): Promise<false | { kind: "command" } | { kind: "aiTool"; result: unknown }> {
  const command = commandsRegistry.getRuntime(extensionId, id);
  if (typeof command === "function") {
    (command as (...a: unknown[]) => unknown)();
    return { kind: "command" };
  }
  // Then the AI tools. A command is a button press and returns nothing; an AI
  // tool takes arguments and RETURNS DATA, which is the difference between
  // "open the API Client" and "send this request and tell me what came back".
  // Without this an outside agent could see `api_client_send` in the listing
  // and had no way to call it - the panel opened, and composing the request was
  // left to synthetic clicks.
  //
  // No approval prompt here, unlike ai-native's copy of this call. That is not
  // an oversight: this path only exists while the automation channel is open,
  // and that channel already carries `sh` and `eval_js`. The boundary is the
  // channel, not the tool (see SECURITY.md).
  const tool = aiToolsRegistry.getRuntime(extensionId, id);
  if (typeof tool === "function") {
    const result = await (tool as (a: Record<string, unknown>) => unknown)(args ?? {});
    return { kind: "aiTool", result };
  }
  return false;
}

/**
 * The reversible half of the extension lifecycle. Resolves to `true` or to an
 * ERROR SENTENCE, never a rejection - these all reach Rust, and neither consumer
 * gets anything useful out of a rejected promise.
 *
 * INSTALL IS NOT HERE for either of them. See the note above `extControl`'s
 * registration: new third-party code goes through the permission review.
 */
export async function controlExtension(action: string, id: string): Promise<true | string> {
  const s = useExtensionsStore.getState();
  if (!s.list.some((e) => e.id === id)) {
    return `No extension "${id}" is installed. Installed: ${s.list.map((e) => e.id).join(", ") || "(none)"}`;
  }
  try {
    switch (action) {
      case "enable":
        await s.setEnabled(id, true);
        return true;
      case "disable":
        await s.setEnabled(id, false);
        return true;
      case "uninstall":
        await s.uninstall(id);
        return true;
      case "reload":
        await s.reload(id);
        return true;
      case "update":
        await s.updateExtension(id);
        return true;
      default:
        return `Unknown action "${action}". Have: enable, disable, reload, update, uninstall.`;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

registerBridge({
  extensions: listExtensions,
  runExtensionCommand,
  extControl: controlExtension,
});
