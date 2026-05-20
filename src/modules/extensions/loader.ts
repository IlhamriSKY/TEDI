/**
 * Boot loader: scan installed extensions, dynamic-import each enabled one,
 * call `activate(ctx)`, and track disposers so `deactivate(id)` can clean
 * up. Triggered once from the main webview during App boot.
 *
 * Module-loading strategy: extensions ship an ES module. We read the JS
 * text via the Rust `ext_read_asset` command (avoids needing webview
 * filesystem access) and instantiate via Blob URL `import()`. This works
 * inside Tauri's webview without exposing arbitrary disk paths to the JS
 * side. For pure-declarative packs (no `main`), activation is a no-op.
 */

import { invoke } from "@tauri-apps/api/core";

import { buildContext, type ExtensionContext } from "./host";
import { safeParseManifest, type Manifest } from "./manifest";
import {
  aiToolsRegistry,
  clearExtensionContributions,
  commandsRegistry,
  editorThemesRegistry,
  keybindingsRegistry,
  panelsRegistry,
  settingsRegistry,
  slashCommandsRegistry,
  themesRegistry,
} from "./registries";

/**
 * Seed every contribution registry from the manifest's declarative
 * `contributes.*` block. This runs **before** the extension's
 * `activate(ctx)` so the UI surface (settings toggles, slash-commands,
 * themes, panels, ...) is present even if the extension's JS throws
 * later. The runtime `ctx.contribute.*` calls inside activate() simply
 * overwrite the manifest's slice for that extension.
 *
 * Exported because the settings webview lives in a separate JS context
 * (each Tauri window is its own module instance) and never runs the
 * loader's activate path. The settings store calls this from its
 * own `init()` so the Extensions tab sees the same declarative
 * contributions main does.
 */
export function seedManifestContributions(ext: InstalledExtension): void {
  // `contributes` is already typed via the Zod manifest schema, so the
  // optional category arrays line up with each registry's expected
  // element type. No casting needed.
  const c = ext.manifest.contributes;
  if (c.settings) settingsRegistry.set(ext.id, c.settings);
  if (c.commands) commandsRegistry.set(ext.id, c.commands);
  if (c.keybindings) keybindingsRegistry.set(ext.id, c.keybindings);
  if (c.slashCommands) slashCommandsRegistry.set(ext.id, c.slashCommands);
  if (c.themes) themesRegistry.set(ext.id, c.themes);
  if (c.editorThemes) editorThemesRegistry.set(ext.id, c.editorThemes);
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
  /** Last upstream version observed via `ext_check_update`. `null` until
   *  the user has run an update check at least once. */
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

type ActiveRecord = {
  context: ExtensionContext;
  dispose: () => Promise<void>;
  /** Reference held only so the Blob URL stays alive until deactivate. */
  scriptUrl: string | null;
  /** Optional deactivate hook supplied by the extension's module. */
  userDeactivate: (() => void | Promise<void>) | null;
};

const active = new Map<string, ActiveRecord>();

export async function listInstalled(): Promise<InstalledExtension[]> {
  const raw = await invoke<RawListEntry[]>("ext_list");
  const out: InstalledExtension[] = [];
  for (const entry of raw) {
    const parsed = safeParseManifest(entry.manifest);
    if (!parsed.ok) {
      console.warn(`[extensions] skipping ${entry.id}: ${parsed.error}`);
      continue;
    }
    out.push({
      id: entry.id,
      manifest: parsed.manifest,
      enabled: entry.enabled,
      source: entry.source,
      installed_at_ms: entry.installed_at_ms,
      version: entry.version,
      fingerprint: entry.fingerprint,
      approved_permissions: entry.approved_permissions,
      root: entry.root,
      latest_version: entry.latest_version,
      last_checked_at_ms: entry.last_checked_at_ms,
    });
  }
  return out;
}

export async function activate(ext: InstalledExtension): Promise<void> {
  if (active.has(ext.id)) return;
  // Defensive: never activate a disabled extension even if a caller
  // accidentally hands us a stale entry. The store flips `enabled` in
  // Rust state before calling this, but a future caller might race.
  if (!ext.enabled) {
    console.warn(`[extensions] activate called on disabled ext ${ext.id} - ignoring`);
    return;
  }
  // Seed declarative contributions before JS runs. If activate() throws
  // we keep them so the user still sees the extension's controls in
  // Settings -> Extensions and can disable / uninstall cleanly.
  seedManifestContributions(ext);

  const { context, dispose } = await buildContext({
    id: ext.id,
    root: ext.root,
    manifest: { permissions: ext.approved_permissions ?? ext.manifest.permissions },
  });

  let scriptUrl: string | null = null;
  let userDeactivate: ActiveRecord["userDeactivate"] = null;

  if (ext.manifest.main) {
    try {
      const text = await invoke<string>("ext_read_asset", {
        id: ext.id,
        relPath: ext.manifest.main,
      });
      const blob = new Blob([text], { type: "text/javascript" });
      scriptUrl = URL.createObjectURL(blob);
      const module: unknown = await import(/* @vite-ignore */ scriptUrl);
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
        await Promise.resolve(activateFn(context));
      } else {
        console.warn(
          `[extensions] ${ext.id} has manifest.main but no activate() export - declarative-only contributions still applied`,
        );
      }
    } catch (err) {
      // Activate failure path: tear down disposers (event listeners,
      // app-context subscription, ...) but **keep** the manifest's
      // declarative contributions intact. That way the user still has
      // a working settings toggle / remove button instead of an empty
      // card. The dynamic side (`registerCommandHandler`,
      // `setItem`, ...) is gone because dispose() ran.
      console.error(`[extensions] failed to activate ${ext.id}`, err);
      if (scriptUrl) URL.revokeObjectURL(scriptUrl);
      await dispose();
      // Re-seed in case the JS partially called contribute.* and then
      // threw - the partial state shouldn't override the manifest's
      // canonical declaration.
      seedManifestContributions(ext);
      throw err;
    }
  }

  active.set(ext.id, { context, dispose, scriptUrl, userDeactivate });
}

export async function deactivate(id: string): Promise<void> {
  const rec = active.get(id);
  if (!rec) return;
  active.delete(id);
  try {
    if (rec.userDeactivate) await Promise.resolve(rec.userDeactivate());
  } catch (err) {
    console.error(`[extensions] ${id} deactivate() threw`, err);
  }
  await rec.dispose();
  clearExtensionContributions(id);
  if (rec.scriptUrl) URL.revokeObjectURL(rec.scriptUrl);
}

/** Boot pipeline: list, then activate all enabled. Tolerant of per-ext
 *  failures - one broken extension shouldn't tank the entire app. */
export async function bootAll(): Promise<InstalledExtension[]> {
  const installed = await listInstalled();
  for (const ext of installed) {
    if (!ext.enabled) continue;
    try {
      await activate(ext);
    } catch (err) {
      console.error(`[extensions] activate ${ext.id} failed`, err);
    }
  }
  return installed;
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
