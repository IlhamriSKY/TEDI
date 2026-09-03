#!/usr/bin/env node
/**
 * Dev helper: link the repo's working-copy extensions (`extensions/<id>/`) into
 * the DEV build's app-data extensions folder so `pnpm tauri:dev` loads them
 * live — no `.zip` packaging and no GitHub publish required.
 *
 * How it works (no host code changes needed):
 *   - The Rust `ext_list` enumerates `<appData>/<devId>/extensions/<id>/` with
 *     `path.is_dir()`, which FOLLOWS a directory junction / symlink. For an id
 *     with no `state.json` entry it defaults to `enabled: true` with every
 *     manifest permission auto-approved.
 *   - `ext_read_asset` / `ctx.installPath` resolve `<root>/<rel>` through the
 *     junction, so `extension.js`, assets, and the sidecar binary all come from
 *     the repo working copy. Edit the file and the host reloads the extension on
 *     its own (it polls each extension's manifest + bundle while the window is
 *     visible); Ctrl+R still works as a hard reset.
 *
 * A junction/symlink (not a copy) is used on purpose: copying would duplicate
 * heavy build artifacts (e.g. the SQL Explorer's `sidecar-src/target/`) and go
 * stale on every edit.
 *
 * Usage:
 *   node scripts/ext/link-dev-extensions.mjs                 # link every extensions/<id>
 *   node scripts/ext/link-dev-extensions.mjs tedi.sql-explorer …   # link only these ids
 *   node scripts/ext/link-dev-extensions.mjs --force         # replace a previously-installed dev copy
 *   node scripts/ext/link-dev-extensions.mjs --unlink        # remove the dev links (never the source)
 *   TEDI_DEV_EXT_IDS=tedi.sql-explorer node scripts/…    # select ids via env
 *
 * Wired as `pnpm tauri:dev:ext` (link all → run the dev app), plus
 * `pnpm link:ext` / `pnpm relink:ext` (--force) / `pnpm unlink:ext`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TWO levels up, not one: this file lives at `scripts/ext/`, so a single `..`
// resolves to `scripts/` and every path built from it lands somewhere that does
// not exist - `scripts/extensions`, `scripts/src-tauri/tauri.dev.conf.json`. The
// failure is silent in the worst way: `discoverIds` finds no directory, reports
// "no extensions found", and exits 0, so `pnpm tauri:dev:ext` looks like it
// linked and simply did nothing.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extSrcDir = path.join(repoRoot, "extensions");
const devConfPath = path.join(repoRoot, "src-tauri", "tauri.dev.conf.json");

/** The dev bundle identifier (read from tauri.dev.conf.json, so it stays in
 *  sync if the identifier ever changes). */
function devIdentifier() {
  try {
    const conf = JSON.parse(fs.readFileSync(devConfPath, "utf8"));
    if (typeof conf.identifier === "string" && conf.identifier) return conf.identifier;
  } catch {
    /* fall through to the default below */
  }
  return "id.ilhamrisky.tedi.dev";
}

/** Mirrors Tauri 2's `app_data_dir()` = `dirs::data_dir()/<identifier>`. */
function dataDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

const devId = devIdentifier();
const devExtRoot = path.join(dataDir(), devId, "extensions");

const args = process.argv.slice(2);
const unlink = args.includes("--unlink");
// Replace a real (previously-installed) copy in the dev app data with the link.
// Only ever touches the DEV profile's extension copy — never the repo source.
const force = args.includes("--force");
const idArgs = args.filter((a) => !a.startsWith("--"));
const envIds = (process.env.TEDI_DEV_EXT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Which extension ids to act on: CLI args > env var > every `extensions/<id>/`
 *  that has a manifest.json. */
function discoverIds() {
  if (idArgs.length) return idArgs;
  if (envIds.length) return envIds;
  if (!fs.existsSync(extSrcDir)) return [];
  return fs
    .readdirSync(extSrcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(extSrcDir, d.name, "manifest.json")))
    .map((d) => d.name)
    .sort();
}

/** Junction (Windows) / symlink (Unix) target if `link` is a link, else null. */
function readLinkTarget(link) {
  try {
    return fs.readlinkSync(link).replace(/^\\\\\?\\/, "");
  } catch {
    return null; // not a link (real dir / file) or missing
  }
}

function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Remove ONLY the link, never its target. Junctions need `rmdir` on Windows;
 *  symlinks need `unlink` elsewhere. */
function removeLink(link) {
  if (process.platform === "win32") fs.rmdirSync(link);
  else fs.unlinkSync(link);
}

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const rel = (p) => path.relative(repoRoot, p) || ".";

/**
 * Drop the given ids from the dev profile's `state.json` so each dev-linked
 * extension loads like a fresh sideload: `ext_list` finds no entry and defaults
 * it to enabled with ALL its CURRENT manifest permissions approved. Without
 * this, a stale entry from a prior install pins the OLD approved-permission set
 * and the host denies any permission the manifest gained since (e.g. a newly
 * added `sidebar:write`). Only touches the ids we linked; other installs and
 * the running app's writes are left alone.
 */
function resetDevState(ids) {
  if (ids.length === 0) return 0;
  const statePath = path.join(devExtRoot, "state.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return 0; // no state file yet, or unreadable — nothing to reset
  }
  if (!parsed || typeof parsed !== "object" || !parsed.entries) return 0;
  let count = 0;
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(parsed.entries, id)) {
      delete parsed.entries[id];
      count++;
    }
  }
  if (count > 0) fs.writeFileSync(statePath, JSON.stringify(parsed, null, 2));
  return count;
}

let linked = 0;
let removed = 0;
let upToDate = 0;
let skipped = 0;
/** Ids that are dev-linked after this run (link mode), for the state reset. */
const touched = [];

const ids = discoverIds();

console.log(`[link-dev-extensions] dev id : ${devId}`);
console.log(`[link-dev-extensions] target : ${devExtRoot}`);
console.log(`[link-dev-extensions] source : ${rel(extSrcDir)}/`);

if (ids.length === 0) {
  console.log(
    unlink
      ? "[link-dev-extensions] nothing to unlink."
      : `[link-dev-extensions] no extensions found under ${rel(extSrcDir)}/.`,
  );
  process.exit(0);
}

fs.mkdirSync(devExtRoot, { recursive: true });

for (const id of ids) {
  const src = path.join(extSrcDir, id);
  const link = path.join(devExtRoot, id);
  const current = readLinkTarget(link);

  if (unlink) {
    if (current === null) {
      if (fs.existsSync(link)) {
        console.warn(`  • ${id}: not a dev link (real dir) — left untouched`);
        skipped++;
      }
      continue;
    }
    try {
      removeLink(link);
      console.log(`  ✓ ${id}: unlinked`);
      removed++;
    } catch (err) {
      console.error(`  ✗ ${id}: failed to unlink — ${err?.message ?? err}`);
      skipped++;
    }
    continue;
  }

  // Link mode: validate the source first.
  if (!fs.existsSync(path.join(src, "manifest.json"))) {
    console.warn(`  • ${id}: no ${rel(src)}/manifest.json — skipped`);
    skipped++;
    continue;
  }

  if (current !== null) {
    if (samePath(current, src)) {
      console.log(`  = ${id}: already linked`);
      upToDate++;
      touched.push(id);
      continue;
    }
    // Link points somewhere else — repoint it.
    try {
      removeLink(link);
    } catch (err) {
      console.error(`  ✗ ${id}: could not replace stale link — ${err?.message ?? err}`);
      skipped++;
      continue;
    }
  } else if (fs.existsSync(link)) {
    // A real (installed) copy exists in the dev app data. Replacing it is
    // destructive, so gate behind --force; the copy is regenerable dev state.
    if (!force) {
      console.warn(
        `  • ${id}: a real (installed) copy exists in the dev app data — skipped. ` +
          `Re-run with --force (\`pnpm relink:ext\`) to replace it with the live repo link.`,
      );
      skipped++;
      continue;
    }
    try {
      fs.rmSync(link, { recursive: true, force: true });
    } catch (err) {
      console.error(`  ✗ ${id}: could not remove the installed copy — ${err?.message ?? err}`);
      skipped++;
      continue;
    }
  }

  try {
    fs.symlinkSync(path.resolve(src), link, LINK_TYPE);
    console.log(`  ✓ ${id}: linked → ${rel(src)}/`);
    linked++;
    touched.push(id);
  } catch (err) {
    console.error(
      `  ✗ ${id}: failed to link — ${err?.message ?? err}` +
        (process.platform === "win32"
          ? " (junctions need no admin; check antivirus / the path)"
          : ""),
    );
    skipped++;
  }
}

// Clear stale state.json entries for the dev-linked ids so they load with
// their CURRENT manifest permissions auto-approved (no leftover grant from a
// prior install pinning an older permission set).
const reset = unlink ? 0 : resetDevState(touched);
if (reset > 0) {
  console.log(
    `[link-dev-extensions] reset ${reset} stale state.json entr${reset === 1 ? "y" : "ies"} ` +
      `→ dev links load enabled with current manifest permissions.`,
  );
}

const summary = unlink
  ? `removed ${removed}, skipped ${skipped}`
  : `linked ${linked}, up-to-date ${upToDate}, skipped ${skipped}`;
console.log(`[link-dev-extensions] done — ${summary}.`);
if (!unlink && (linked > 0 || upToDate > 0)) {
  console.log(
    "[link-dev-extensions] edit an extension.js, then reload the window (Ctrl+R) " +
      "or toggle it in Settings → Extensions to pick up changes.",
  );
}
// Per-extension issues are warnings, not failures, so the chained `pnpm
// tauri:dev` still runs.
process.exit(0);
