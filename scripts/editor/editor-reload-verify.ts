/**
 * Self-check for the open-editor live-reload bridge (fsRefresh).
 * Run: `npx tsx scripts/editor/editor-reload-verify.ts`.
 *
 * The AI's file tools write straight to disk, so the ONLY thing that tells an
 * open editor its text went stale is the `file` field on the fs-refresh event.
 * Matching has to survive both ways a Windows path reaches this bridge
 * (`C:\a\b.md` vs `C:/a/b.md`, and either case) or the editor silently keeps
 * showing the old content, which is the bug this replaced. It must equally NOT
 * fire for a sibling in the same directory, or every write in a busy folder
 * re-reads every open editor.
 *
 * The directory contract is asserted too: the explorer reads `detail.path`, and
 * a bare `dispatchFsRefresh()` must carry no detail at all (its "refresh
 * everything" signal). Adding `file` must not have disturbed either.
 */

export {}; // dynamic-import-only file; marks it a module so top-level await is legal.

// fsRefresh talks to `window`; give it a bare EventTarget before importing.
(globalThis as { window?: unknown }).window = new EventTarget();

const { FS_REFRESH_EVENT, dispatchFsRefresh, dispatchFsRefreshForFile, subscribeFileChange } =
  await import("../../src/modules/explorer/lib/fsRefresh");

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

/** Counts reloads an editor showing `openPath` would perform during `run`. */
function reloadsFor(openPath: string, run: () => void): number {
  let hits = 0;
  const off = subscribeFileChange(
    () => openPath,
    () => {
      hits++;
    },
  );
  run();
  off();
  return hits;
}

const OPEN = "D:\\Ilham\\notes\\catatanSMA.md";

console.log("[match] the file the AI wrote is the file the editor is showing");
check(
  "exact same path",
  reloadsFor(OPEN, () => dispatchFsRefreshForFile(OPEN)),
  1,
);
check(
  "AI reports forward slashes, editor holds backslashes",
  reloadsFor(OPEN, () => dispatchFsRefreshForFile("D:/Ilham/notes/catatanSMA.md")),
  1,
);
check(
  "drive letter and name differ only in case",
  reloadsFor(OPEN, () => dispatchFsRefreshForFile("d:/ilham/notes/CATATANSMA.MD")),
  1,
);

console.log("\n[no match] anything that is not this exact file must stay quiet");
check(
  "sibling file in the same directory",
  reloadsFor(OPEN, () => dispatchFsRefreshForFile("D:\\Ilham\\notes\\other.md")),
  0,
);
check(
  "same name in a different directory",
  reloadsFor(OPEN, () => dispatchFsRefreshForFile("D:\\Ilham\\archive\\catatanSMA.md")),
  0,
);
check(
  "prefix of the open path is not the open path",
  reloadsFor(OPEN, () => dispatchFsRefreshForFile("D:\\Ilham\\notes\\catatanSMA.markdown")),
  0,
);
check(
  "directory-only refresh carries no file",
  reloadsFor(OPEN, () => dispatchFsRefresh("D:\\Ilham\\notes")),
  0,
);
check(
  "refresh-everything carries no file",
  reloadsFor(OPEN, () => dispatchFsRefresh()),
  0,
);

console.log("\n[lifecycle] a closed editor stops reloading");
let afterUnsub = 0;
const off = subscribeFileChange(
  () => OPEN,
  () => {
    afterUnsub++;
  },
);
off();
dispatchFsRefreshForFile(OPEN);
check("no reload after unsubscribe", afterUnsub, 0);

console.log("\n[explorer contract] the directory signal the file tree reads is unchanged");
function detailOf(run: () => void): unknown {
  let seen: unknown = "NOTHING DISPATCHED";
  const handler = (ev: Event) => {
    seen = (ev as CustomEvent<unknown>).detail;
  };
  (globalThis.window as EventTarget).addEventListener(FS_REFRESH_EVENT, handler);
  run();
  (globalThis.window as EventTarget).removeEventListener(FS_REFRESH_EVENT, handler);
  return seen;
}
check(
  "a file write still names its parent directory",
  detailOf(() => dispatchFsRefreshForFile(OPEN)),
  {
    path: "D:\\Ilham\\notes",
    file: OPEN,
  },
);
// `null`, not `undefined`: CustomEvent coerces an absent `detail` to null. That
// predates this change and is what the explorer's `detail?.path` already keys
// its "reload every loaded directory" branch off.
check(
  "a bare refresh carries no detail so the tree reloads all",
  detailOf(() => dispatchFsRefresh()),
  null,
);
check(
  "a path with no separator dispatches nothing",
  detailOf(() => dispatchFsRefreshForFile("catatanSMA.md")),
  "NOTHING DISPATCHED",
);

console.log(failed === 0 ? "\nAll editor-reload checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
