/**
 * Hot reload for extensions: save `extension.js` (or `manifest.json`) and the
 * running extension restarts by itself, no window reload.
 *
 * ## Why a poll and not a filesystem watcher
 *
 * A real watcher means the `notify` crate, which is not in the dependency tree,
 * plus an event plumbed from Rust into the webview. `ext_stamps` stats two
 * files per extension and returns one integer each - for a nine-extension
 * install that is eighteen `fs::metadata` calls and a couple of hundred bytes
 * of IPC, roughly once a second, and only while the window is visible. That is
 * far below what the app already does every second for terminals and git
 * decorations, and it cost one small Rust command instead of a dependency.
 *
 * ## Why the change has to be stable before reloading
 *
 * A bundler writes its output in one or more chunks, so a poll can easily
 * catch `extension.js` half-written - and importing a truncated module throws
 * from `activate`, which the user sees as a failure toast for code they just
 * wrote correctly. So a changed stamp is not enough: it has to be the SAME
 * changed stamp on the next tick too. That costs one extra tick of latency and
 * removes the entire class of mid-write failures.
 *
 * ## Interaction with install / update / enable
 *
 * Those already reload the extension themselves and announce it on
 * `tedi://ext-changed`. This module listens to the same event and drops its
 * baseline for that id, so the next tick re-seeds instead of reloading a
 * second time. One listener covers install, update, uninstall, enable, disable
 * and manual reload, because every one of them announces.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The store is imported lazily, inside the tick. Two reasons, both real:
 * `store.ts` imports THIS module, so a static import either way is a cycle;
 * and its module graph reaches `modules/settings/store.ts`, which calls
 * `getCurrentWebviewWindow()` at module scope and therefore throws the instant
 * anything outside a webview loads it - a verify script, for instance. Keeping
 * the import inside the tick leaves `classifyStamp` testable on plain node.
 */
type StoreModule = typeof import("./store");
let storeModule: StoreModule | null = null;
async function extensionsStore(): Promise<StoreModule["useExtensionsStore"]> {
  storeModule ??= await import("./store");
  return storeModule.useExtensionsStore;
}

/** One tick. Fast enough that a save feels immediate once the stability check
 *  has passed (~1-2s), slow enough to be invisible in a profile. */
const POLL_MS = 1000;

type ExtStamp = { id: string; stamp: number };

/** Last stamp we consider "current" per extension. An id missing from here is
 *  seeded on the next tick WITHOUT reloading - that is how first run, and
 *  every externally-driven reload, avoid a spurious restart. */
const baseline = new Map<string, number>();

/** A changed stamp seen once, waiting to be seen identical again. */
const pending = new Map<string, number>();

/**
 * Every extension seen this session, and the files to watch for it.
 *
 * Deliberately NOT rebuilt from the store's list each tick. A manifest with a
 * JSON typo fails to parse, so `ext_list` drops the extension entirely - and if
 * the watch set were derived from that list, the extension would fall out of it
 * at exactly the moment the author needs watching most. Fixing the typo would
 * then change nothing until a restart, which is a worse trap than having no hot
 * reload at all: the author sees their correct manifest doing nothing.
 *
 * So an id stays watched once seen. `loader.reload` re-lists and activates from
 * disk, so the repaired extension comes straight back. Entries are dropped only
 * on a real uninstall (the `removed` announce).
 */
const watched = new Map<string, string[]>();

let timer: ReturnType<typeof setInterval> | null = null;
let unlistenChanged: UnlistenFn | null = null;
/** Guards against overlapping ticks: a reload can outlast POLL_MS, and a
 *  second tick landing mid-reload would read a stamp for a half-torn-down
 *  extension. */
let ticking = false;

/** Files whose change should restart the extension. `manifest.json` matters as
 *  much as the bundle: adding a command, a panel or a permission is a manifest
 *  edit, and re-seeding contributions is exactly what a reload does. */
function watchedFiles(main: string | null | undefined): string[] {
  return main ? ["manifest.json", main] : ["manifest.json"];
}

/**
 * What to do about one extension this tick. Pulled out of the loop because it
 * is the only part with real logic in it, and a debounce is easy to get subtly
 * wrong in a way no compiler catches: reload one tick too early and you import
 * a half-written bundle, one tick too late and nothing ever fires.
 *
 * - `seed`   we have no baseline yet (first run, or an external reload cleared
 *            it). Record and do nothing - reloading here would restart every
 *            extension at startup.
 * - `idle`   unchanged, or changed back to the baseline.
 * - `wait`   changed, but this is the first tick that has seen this value. The
 *            writer may still be mid-write.
 * - `reload` the same new value twice running: the file has settled.
 *
 * Exercised by `scripts/ext-hot-reload-verify.ts`.
 */
export function classifyStamp(
  known: number | undefined,
  now: number,
  pendingStamp: number | undefined,
): "seed" | "idle" | "wait" | "reload" {
  if (known === undefined) return "seed";
  if (now === known) return "idle";
  return pendingStamp === now ? "reload" : "wait";
}

async function tick(): Promise<void> {
  if (ticking) return;
  // A hidden window is a window nobody is testing an extension in. Skipping
  // also keeps this away from the throttled-background-timer behaviour that
  // has bitten other pollers in this app.
  if (typeof document !== "undefined" && document.hidden) return;

  const useExtensionsStore = await extensionsStore();
  const store = useExtensionsStore.getState();

  // Learn about anything new or newly-enabled, but never forget: see `watched`.
  for (const ext of store.list) {
    if (ext.enabled) watched.set(ext.id, watchedFiles(ext.manifest.main));
  }
  if (watched.size === 0) return;

  ticking = true;
  try {
    const requests = [...watched].map(([id, files]) => ({ id, files }));
    const stamps = await invoke<ExtStamp[]>("ext_stamps", { requests });

    for (const { id, stamp } of stamps) {
      const action = classifyStamp(baseline.get(id), stamp, pending.get(id));
      if (action === "seed") {
        baseline.set(id, stamp);
        continue;
      }
      if (action === "idle") {
        pending.delete(id);
        continue;
      }
      if (action === "wait") {
        pending.set(id, stamp);
        continue;
      }
      pending.delete(id);
      baseline.set(id, stamp);
      const name = store.list.find((e) => e.id === id)?.manifest.name ?? id;
      // eslint-disable-next-line no-console
      console.info(`[extensions] ${id} changed on disk - reloading`);
      try {
        await useExtensionsStore.getState().reload(id);
      } catch (err) {
        // `loader.activate` already toasts its own failure and keeps the
        // manifest contributions, so this is only for the unexpected rest.
        console.error(`[extensions] hot reload of ${name} failed`, err);
      }
      // A reload re-lists from disk, so `manifest.main` may have moved (or the
      // extension may have just come back from an unparseable manifest). Track
      // the new value, then re-stamp: the reload does not touch the files, but
      // a watch-mode bundler may well have written again while we were busy,
      // and keeping the pre-reload stamp as baseline would miss that write.
      const after = useExtensionsStore.getState().list.find((e) => e.id === id);
      const files = watchedFiles(after?.manifest.main);
      watched.set(id, files);
      try {
        const [fresh] = await invoke<ExtStamp[]>("ext_stamps", {
          requests: [{ id, files }],
        });
        if (fresh) baseline.set(id, fresh.stamp);
      } catch {
        // Leave the baseline as-is; the next tick sorts it out.
      }
    }
  } catch (err) {
    // A failing poll must never become a failing app. Most likely cause is the
    // command being unavailable on an older host during a dev rebuild.
    console.warn("[extensions] stamp poll failed", err);
  } finally {
    ticking = false;
  }
}

/**
 * Starts the watcher. Idempotent; returns a stop function.
 *
 * Call this only from the window that actually activates extensions (main).
 * The settings window has no activated extensions to reload, and running it
 * there would fight the main window over the same files.
 */
export function startExtensionAutoReload(): () => void {
  if (timer) return stopExtensionAutoReload;
  timer = setInterval(() => void tick(), POLL_MS);

  // Every store mutation (install, update, uninstall, enable, disable, manual
  // reload) announces here, and every one of them changes the files on disk or
  // has already reloaded. Dropping the baseline makes the next tick re-seed
  // rather than reload again on top of it.
  void listen<{ id?: string; kind?: string }>("tedi://ext-changed", (e) => {
    const id = e.payload?.id;
    if (!id) return;
    baseline.delete(id);
    pending.delete(id);
    // An uninstall is the one case where forgetting is right: the folder is
    // gone, so there is nothing left to watch and nothing that can come back.
    if (e.payload?.kind === "removed") watched.delete(id);
  }).then((fn) => {
    if (timer) unlistenChanged = fn;
    else fn(); // stopped before the listener landed
  });

  return stopExtensionAutoReload;
}

export function stopExtensionAutoReload(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unlistenChanged?.();
  unlistenChanged = null;
  baseline.clear();
  pending.clear();
  watched.clear();
}
