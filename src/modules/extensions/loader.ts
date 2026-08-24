/**
 * Boot loader. Scans installed extensions, dynamic-imports each enabled one,
 * calls `activate(ctx)`, and tracks disposers for `deactivate(id)`. Runs once
 * during App boot.
 * Extensions ship an ES module; the JS text is read via `ext_read_asset` and
 * instantiated via Blob URL `import()`. Declarative-only packs (no `main`)
 * skip activation.
 */

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

import { toast } from "@/components/ui/toast";
import { buildContext, type ExtensionContext } from "./host";
import { safeParseManifest, type Manifest } from "./manifest";
import { satisfies } from "./semver";
import {
  aiToolsRegistry,
  clearExtensionContributions,
  commandsRegistry,
  keybindingsRegistry,
  panelsRegistry,
  settingsRegistry,
} from "./registries";

/**
 * Seeds contribution registries from the manifest's `contributes.*` block.
 * Runs before `activate(ctx)` so the UI surface stays visible even if
 * activate throws. Runtime `ctx.contribute.*` calls overwrite this slice.
 * Exported because the settings webview is a separate Tauri window and
 * doesn't run the loader; its store calls this from `init()`.
 */
export function seedManifestContributions(ext: InstalledExtension): void {
  // Typed via the Zod manifest schema; no casting needed.
  const c = ext.manifest.contributes;
  if (c.settings) settingsRegistry.set(ext.id, c.settings);
  if (c.commands) commandsRegistry.set(ext.id, c.commands);
  if (c.keybindings) keybindingsRegistry.set(ext.id, c.keybindings);
  if (c.panels) panelsRegistry.set(ext.id, c.panels);
  if (c.aiTools) aiToolsRegistry.set(ext.id, c.aiTools);
}

export type InstalledExtension = {
  id: string;
  manifest: Manifest;
  enabled: boolean;
  source: string;
  installed_at_ms: number;
  version: string;
  fingerprint: string;
  approved_permissions: string[];
  root: string;
  /** Last upstream version from `ext_check_update`. `null` until the first check. */
  latest_version: string | null;
  last_checked_at_ms: number | null;
};

type RawListEntry = {
  id: string;
  manifest: unknown;
  enabled: boolean;
  source: string;
  installed_at_ms: number;
  version: string;
  fingerprint: string;
  approved_permissions: string[];
  root: string;
  latest_version: string | null;
  last_checked_at_ms: number | null;
};

export type UpdateCheckResult = {
  id: string;
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  last_checked_at_ms: number;
  source: string;
};

/** How long an extension took to come up, split the way VS Code splits it.
 *  `load` scales with bundle size, `activate` with what the extension does in
 *  `activate()`; blaming the wrong one sends an author optimising the wrong
 *  thing. */
export type ActivationTiming = {
  id: string;
  name: string;
  /** ms to read `manifest.main` off disk and instantiate the Blob module. */
  loadMs: number;
  /** ms inside the extension's own `activate(ctx)`. */
  activateMs: number;
};

type ActiveRecord = {
  context: ExtensionContext;
  dispose: () => Promise<void>;
  /** Keeps the Blob URL alive until deactivate. */
  scriptUrl: string | null;
  /** Optional `deactivate` export from the extension module. */
  userDeactivate: (() => void | Promise<void>) | null;
  timing: ActivationTiming;
};

const active = new Map<string, ActiveRecord>();

/** An `activate()` slower than this is worth naming out loud. Extensions
 *  activate in parallel, so this is not additive launch cost - but it IS the
 *  extension's own contribution to time-to-interactive, and the only way to
 *  attribute it today is a bisect. */
const SLOW_ACTIVATE_MS = 500;

/** Timings for every currently-active extension, slowest first. Exported for
 *  diagnostics; the Settings window runs in a separate webview and does not
 *  share this module's state, which is why the summary is logged rather than
 *  rendered on the extension cards. */
export function activationTimings(): ActivationTiming[] {
  return [...active.values()]
    .map((r) => r.timing)
    .sort((a, b) => b.loadMs + b.activateMs - (a.loadMs + a.activateMs));
}

/** Cached host version. Resolved once on first need so the loader's hot
 *  path stays sync after boot. `Promise<string>` is stored so concurrent
 *  callers all await the same fetch. */
let hostVersionPromise: Promise<string> | null = null;
function getHostVersion(): Promise<string> {
  if (!hostVersionPromise) hostVersionPromise = getVersion();
  return hostVersionPromise;
}

/** Ids already reported by `listInstalled` as unparseable, so the toast fires
 *  once per session instead of on every enable/disable/install/refresh (this
 *  function is called from ~12 places in `store.ts`). */
const warnedBadManifest = new Set<string>();

export async function listInstalled(): Promise<InstalledExtension[]> {
  const raw = await invoke<RawListEntry[]>("ext_list");
  const out: InstalledExtension[] = [];
  for (const entry of raw) {
    const parsed = safeParseManifest(entry.manifest);
    if (!parsed.ok) {
      // Rust installed it, this side cannot parse it: the entry is dropped
      // here, so it never reaches Settings and cannot be uninstalled from the
      // UI. Silence made that a ghost. See the INVARIANT in `manifest.ts`.
      console.warn(`[extensions] skipping ${entry.id}: ${parsed.error}`);
      if (!warnedBadManifest.has(entry.id)) {
        warnedBadManifest.add(entry.id);
        toast(`Extension "${entry.id}" has an invalid manifest: ${parsed.error}`, {
          variant: "error",
        });
      }
      continue;
    }
    out.push({ ...entry, manifest: parsed.manifest });
  }
  return out;
}

export async function activate(ext: InstalledExtension): Promise<void> {
  if (active.has(ext.id)) return;
  // Skip disabled extensions even if a stale entry slips through.
  if (!ext.enabled) {
    console.warn(`[extensions] activate called on disabled ext ${ext.id} - ignoring`);
    return;
  }
  // Engine-compat gate. Refuse to activate when the manifest asks for a
  // newer host than the running app. A stricter version of the same gate
  // already runs at install time on the Rust side, but extensions that
  // were installed before the constraint was tightened (or sideloaded
  // outside the install pipeline) still need to be caught here.
  const required = ext.manifest.engines?.tedi;
  if (required) {
    const host = await getHostVersion();
    if (!satisfies(required, host)) {
      const msg = `${ext.manifest.name} needs TEDI ${required} (you have ${host}).`;
      console.warn(`[extensions] skipping ${ext.id}: host ${host} does not satisfy ${required}`);
      toast(msg, { variant: "warning" });
      return;
    }
  }
  // Seed declarative contributions first. If activate() throws, they stay
  // so the user can still disable/uninstall from Settings.
  seedManifestContributions(ext);

  const { context, dispose } = await buildContext({
    id: ext.id,
    root: ext.root,
    manifest: { permissions: ext.approved_permissions ?? ext.manifest.permissions },
  });

  let scriptUrl: string | null = null;
  let userDeactivate: ActiveRecord["userDeactivate"] = null;
  const timing: ActivationTiming = {
    id: ext.id,
    name: ext.manifest.name,
    loadMs: 0,
    activateMs: 0,
  };

  if (ext.manifest.main) {
    try {
      const loadStart = performance.now();
      const text = await invoke<string>("ext_read_asset", {
        id: ext.id,
        relPath: ext.manifest.main,
      });
      const blob = new Blob([text], { type: "text/javascript" });
      scriptUrl = URL.createObjectURL(blob);
      const module: unknown = await import(/* @vite-ignore */ scriptUrl);
      timing.loadMs = Math.round(performance.now() - loadStart);
      const mod = module as {
        activate?: (ctx: ExtensionContext) => unknown;
        deactivate?: () => unknown;
        default?: { activate?: (ctx: ExtensionContext) => unknown; deactivate?: () => unknown };
      };
      const activateFn = mod.activate ?? mod.default?.activate;
      const deactivateFn = mod.deactivate ?? mod.default?.deactivate;
      if (typeof deactivateFn === "function") {
        userDeactivate = deactivateFn as () => void | Promise<void>;
      }
      if (typeof activateFn === "function") {
        const activateStart = performance.now();
        await Promise.resolve(activateFn(context));
        timing.activateMs = Math.round(performance.now() - activateStart);
        // Warns in release too, not just dev: a slow activate is the kind of
        // thing that only shows up on a user's machine, and `warn` survives
        // the build while `info` does not.
        if (timing.activateMs >= SLOW_ACTIVATE_MS) {
          console.warn(
            `[extensions] ${ext.id} spent ${timing.activateMs}ms in activate() (+${timing.loadMs}ms loading). Move slow work off the activate path.`,
          );
        }
      } else {
        console.warn(
          `[extensions] ${ext.id} has manifest.main but no activate() export. Declarative contributions still applied.`,
        );
      }
    } catch (err) {
      // Activate failure: tear down disposers but keep manifest
      // contributions so the user still sees a working settings card.
      console.error(`[extensions] failed to activate ${ext.id}`, err);
      if (scriptUrl) URL.revokeObjectURL(scriptUrl);
      await dispose();
      // `dispose()` only runs the disposers the context handed out. A partial
      // activate can also have called `contribute.*` / `registerAiToolHandler`,
      // which write straight into the registries with no disposer, so clear the
      // whole slice first and then restore the declarative half. Without the
      // clear, a half-registered AI tool or command survives with no handler
      // behind it.
      clearExtensionContributions(ext.id);
      seedManifestContributions(ext);
      throw err;
    }
  }

  active.set(ext.id, { context, dispose, scriptUrl, userDeactivate, timing });
}

export async function deactivate(id: string): Promise<void> {
  const rec = active.get(id);
  if (!rec) {
    // Not active, but not necessarily contribution-free: an extension whose
    // activate() threw never enters `active` while its declarative
    // contributions stay seeded (see `activate`'s catch), and a declarative-only
    // pack has no `main` to activate at all. Returning early left both on screen
    // after disable/uninstall until the next restart.
    clearExtensionContributions(id);
    return;
  }
  active.delete(id);
  try {
    if (rec.userDeactivate) await Promise.resolve(rec.userDeactivate());
  } catch (err) {
    console.error(`[extensions] ${id} deactivate() threw`, err);
  }
  await rec.dispose();
  // After `userDeactivate`, so an extension's own deactivate() still sees its
  // registry slice while it runs.
  clearExtensionContributions(id);
  if (rec.scriptUrl) URL.revokeObjectURL(rec.scriptUrl);
}

/** Lists installed extensions and activates the enabled ones. Per-ext
 *  failures are logged, not thrown. */
export async function bootAll(): Promise<InstalledExtension[]> {
  const installed = await listInstalled();
  // Parallel activation. Serial activation summed every extension's activate()
  // latency into one chain: a single ext that awaits the network or a subprocess
  // inside activate() (a usage meter curling an endpoint, a relay handshake, a
  // `--version` probe) delayed every LATER extension's contributions from
  // appearing. Activations are order-independent - no bundled extension reads
  // another's runtime registry slice, and each seeds its own declarative
  // contributions from its own manifest. allSettled keeps per-ext error
  // isolation so one slow/failed activate can't reject or stall the batch.
  await Promise.allSettled(
    installed
      .filter((ext) => ext.enabled)
      .map((ext) =>
        activate(ext).catch((err) => {
          console.error(`[extensions] activate ${ext.id} failed`, err);
          // Surface the failure so a developer iterating on their extension sees
          // it without opening DevTools. Manifest contributions stay applied (see
          // `activate`'s catch), so the settings card still renders for
          // disable/uninstall.
          const msg = err instanceof Error ? err.message : String(err);
          toast(`Extension "${ext.manifest.name}" failed to activate: ${msg}`, {
            variant: "error",
          });
        }),
      ),
  );
  logActivationSummary();
  return installed;
}

/**
 * One line per extension after boot, slowest first. `console.info` so it stops
 * at the dev build - this is developer chatter, and the release-build signal is
 * the `SLOW_ACTIVATE_MS` warning inside `activate`.
 *
 * The Settings window is a separate webview that never runs this module, so
 * there is no extension card to hang these numbers off; the console is where
 * an author iterating on their own extension is already looking.
 */
function logActivationSummary(): void {
  if (!import.meta.env.DEV) return;
  const rows = activationTimings();
  if (rows.length === 0) return;
  // eslint-disable-next-line no-console
  console.info(
    `[extensions] activated ${rows.length}:\n` +
      rows
        .map(
          (t) =>
            `  ${String(t.loadMs + t.activateMs).padStart(5)}ms  ${t.id}` +
            `  (load ${t.loadMs}ms, activate ${t.activateMs}ms)`,
        )
        .join("\n"),
  );
}

export async function reload(id: string, fresh?: InstalledExtension): Promise<void> {
  await deactivate(id);
  let next = fresh;
  if (!next) {
    const all = await listInstalled();
    next = all.find((e) => e.id === id);
  }
  if (!next || !next.enabled) return;
  await activate(next);
}
