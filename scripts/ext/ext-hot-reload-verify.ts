/**
 * Extension hot-reload guard.
 *
 * Two properties, both of which fail silently rather than loudly if broken:
 *
 *   A. The debounce. A changed file must be seen with the SAME new stamp twice
 *      before it triggers a reload. A bundler writes its output in chunks, so
 *      reloading on first sight regularly imports a half-written module and
 *      shows the author a failure toast for code they wrote correctly. Reload
 *      one tick too late instead and nothing ever fires at all.
 *   B. The Rust stamp really does change for the edits authors make. Length is
 *      folded in alongside mtime because esbuild rebuilds in milliseconds, and
 *      two saves inside one filesystem timestamp tick would otherwise read as
 *      "unchanged" forever.
 *
 * Run: `npx tsx scripts/ext/ext-hot-reload-verify.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyStamp } from "../../src/modules/extensions/autoReload";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}: ${label} = ${String(actual)}, want ${String(expected)}`);
}

console.log("\n[A] the debounce state machine");
// First tick after start, or after an external reload cleared the baseline.
// Reloading here would restart every extension on launch.
check("no baseline -> seed", classifyStamp(undefined, 100, undefined), "seed");
check("no baseline, stale pending -> seed", classifyStamp(undefined, 100, 100), "seed");
// Steady state.
check("unchanged -> idle", classifyStamp(100, 100, undefined), "idle");
// A write that lands back on the original stamp must not fire.
check("changed back to baseline -> idle", classifyStamp(100, 100, 200), "idle");
// The mid-write case: seen once, not yet trusted.
check("first sight of a change -> wait", classifyStamp(100, 200, undefined), "wait");
// Still moving: a different new value replaces the pending one, so the timer
// effectively restarts rather than firing on the second DIFFERENT value.
check("still moving -> wait", classifyStamp(100, 300, 200), "wait");
// Settled.
check("same new stamp twice -> reload", classifyStamp(100, 200, 200), "reload");
// And after that reload the baseline moves, so it does not fire forever.
check("post-reload baseline -> idle", classifyStamp(200, 200, undefined), "idle");

console.log("\n[A2] a three-chunk write reloads exactly once");
{
  // Simulates a bundler writing in three steps, then going quiet.
  const observed = [100, 210, 220, 230, 230, 230, 230];
  let known: number | undefined = observed[0];
  let pendingStamp: number | undefined;
  let reloads = 0;
  for (const now of observed.slice(1)) {
    const action = classifyStamp(known, now, pendingStamp);
    if (action === "seed") known = now;
    else if (action === "idle") pendingStamp = undefined;
    else if (action === "wait") pendingStamp = now;
    else {
      reloads++;
      pendingStamp = undefined;
      known = now;
    }
  }
  check("reload count over a chunked write", reloads, 1);
  check("baseline ends at the final stamp", known, 230);
}

console.log("\n[B] the Rust stamp folds in length, not just mtime");
const rust = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src-tauri/src/modules/extensions/commands.rs",
  ),
  "utf8",
);
// Anchored on `stamp_files`, the function that does the folding. A textual
// check rather than a behavioural one on purpose: the Rust unit tests write
// their fixtures sequentially, so they would only catch a dropped `meta.len()`
// on the rare run where two writes share a millisecond. This catches it every
// time.
const fnStart = rust.indexOf("pub(crate) fn stamp_files");
const fold = fnStart < 0 ? "" : rust.slice(fnStart, rust.indexOf("\n}", fnStart));
check("stamp_files exists", fnStart > 0, true);
check("stamp uses the file mtime", fold.includes("modified()"), true);
// Without this, two rebuilds inside the same millisecond are invisible.
check("stamp uses the file length", fold.includes("meta.len()"), true);
// Order has to matter, or two files swapping contents reads as unchanged.
check("stamp is order-sensitive", fold.includes("rotate_left"), true);

console.log("\n[C] the watcher only runs where extensions are activated");
const store = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src/modules/extensions/store.ts"),
  "utf8",
);
const startIdx = store.indexOf("startExtensionAutoReload");
check("watcher is started from the store", startIdx > 0, true);
// An id must stay watched after its manifest stops parsing, or fixing a typo
// leaves the extension dead until a restart.
const auto = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src/modules/extensions/autoReload.ts"),
  "utf8",
);
// The watch set must only ever be added to inside the tick. If a future edit
// rebuilds it from `store.list` each pass, an extension whose manifest stops
// parsing drops out of the list and stops being watched, and repairing the
// typo then changes nothing until a restart.
const tickBody = auto.slice(auto.indexOf("async function tick"), auto.indexOf("/**\n * Starts"));
check("the tick adds to the watch set", tickBody.includes("watched.set(ext.id"), true);
check("the tick never empties the watch set", tickBody.includes("watched.clear()"), false);
check("the tick never deletes from the watch set", tickBody.includes("watched.delete("), false);
check(
  "only an uninstall stops watching an id",
  auto.includes(`e.payload?.kind === "removed"`) && auto.includes("watched.delete(id)"),
  true,
);
// A watcher in the settings webview would fight main over the same reload.
check(
  "start is gated on the main window",
  store.slice(Math.max(0, startIdx - 300), startIdx).includes("isMainWindow()"),
  true,
);
// Self-delivered announces must be ignored, or every reload runs twice.
check("announce carries a source label", store.includes("source: selfLabel()"), true);
check(
  "self-delivered announces are dropped",
  store.includes("payload.source === selfLabel()"),
  true,
);

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: ext-hot-reload-verify`);
process.exit(failed === 0 ? 0 : 1);
