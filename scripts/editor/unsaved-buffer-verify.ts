/**
 * Unsaved editor text must survive a REMOUNT of its leaf and die with a CLOSE.
 * Run: `npx tsx scripts/editor/unsaved-buffer-verify.ts`.
 *
 * Splitting a single-pane tab turns the leaf node into a split node, so React
 * unmounts the editor and mounts a fresh one for the same leaf (so do unsplit,
 * workspace switch and the canvas/tabs flip). Before the stash, `useDocument`
 * held the buffer only in component state: Ctrl+D on a dirty editor reloaded
 * the file from disk and the edits were gone, dirty dot and all.
 *
 * Three things have to hold, and each is silent when it breaks:
 * - the stash is per LEAF and per FILE, so a recycled leaf never shows another
 *   file's text;
 * - taking it is one-shot, so a later reload reads disk again;
 * - the pane-tree reconciler drops closed leaves, or a "discard" on close would
 *   come back the next time that leaf id appears.
 */
import { readFileSync } from "node:fs";
import {
  dropUnsavedBuffersExcept,
  stashUnsavedBuffer,
  takeUnsavedBuffer,
} from "../../src/modules/editor/lib/unsavedBuffers";

let failed = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

const entry = { path: "C:/p/a.ts", saved: "old", buffer: "old + typed" };

console.log("[stash] a remount of the same leaf gets its edits back");
stashUnsavedBuffer(7, entry);
ok(
  "same leaf, same file restores the buffer",
  takeUnsavedBuffer(7, entry.path)?.buffer === entry.buffer,
);
ok("and only once", takeUnsavedBuffer(7, entry.path) === null);

stashUnsavedBuffer(7, entry);
ok("a different file on that leaf restores nothing", takeUnsavedBuffer(7, "C:/p/b.ts") === null);
ok("and the stale entry is gone", takeUnsavedBuffer(7, entry.path) === null);

console.log("\n[close] a leaf that left every pane tree loses its stash");
stashUnsavedBuffer(1, entry);
stashUnsavedBuffer(2, entry);
dropUnsavedBuffersExcept(new Set([2]));
ok("closed leaf dropped", takeUnsavedBuffer(1, entry.path) === null);
ok("live leaf kept", takeUnsavedBuffer(2, entry.path) !== null);

console.log("\n[wiring] the three sites that make it work");
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
ok(
  "useDocument stashes on unmount and takes on load",
  /stashUnsavedBuffer\(/.test(src("src/modules/editor/lib/useDocument.ts")) &&
    /takeUnsavedBuffer\(/.test(src("src/modules/editor/lib/useDocument.ts")),
);
ok(
  "the pane tree passes the leaf id",
  /leafId=\{node\.id\}/.test(src("src/modules/panes/PaneTreeView.tsx")),
);
ok(
  "the reconciler drops closed leaves",
  /dropUnsavedBuffersExcept\(liveEditor\)/.test(src("src/app/hooks/useSessionDisposal.ts")),
);
ok(
  "a save keeps keys typed during the write dirty",
  /setDirty\(bufferRef\.current !== content\)/.test(src("src/modules/editor/lib/useDocument.ts")),
);

if (failed > 0) throw new Error(`unsaved-buffer-verify: ${failed} FAILED`);
console.log("\nunsaved-buffer-verify: OK");
