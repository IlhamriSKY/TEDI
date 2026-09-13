/**
 * The one VS Code-style preview slot that editor and git-diff tabs share.
 * Run: `npx tsx scripts/workspace/preview-slot-verify.ts` (or `pnpm verify`).
 *
 * A preview open replaces whatever `isPreviewTab` matches, so a false positive
 * here silently CLOSES a tab the user meant to keep. The cases that must never
 * match: a pinned tab, an edited (kept) editor, a split pane, a kept diff.
 */
import { isPreviewTab } from "../../src/modules/tabs/lib/tabHelpers";
import type { Tab } from "../../src/modules/tabs/lib/tabTypes";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (got === want) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const editor = (id: number, preview: boolean): Tab => ({
  id,
  kind: "pane",
  title: "a.ts",
  activeLeafId: id + 1,
  paneTree: { kind: "leaf", id: id + 1, leafKind: "editor", path: "/a.ts", dirty: false, preview },
});
const diff = (id: number, preview?: boolean): Tab => ({
  id,
  kind: "git-diff",
  title: "a.ts (diff)",
  path: "/r/a.ts",
  relative: "a.ts",
  repoPath: "/r",
  changeStatus: "modified",
  reloadKey: 0,
  preview,
});

console.log("[preview-slot] what a preview open may replace");
check("preview editor", isPreviewTab(editor(1, true)), true);
check("kept editor", isPreviewTab(editor(1, false)), false);
check("preview diff", isPreviewTab(diff(1, true)), true);
check("kept diff", isPreviewTab(diff(1, false)), false);
check("diff with no flag", isPreviewTab(diff(1)), false);
check("strip-pinned preview editor", isPreviewTab({ ...editor(1, true), pinned: true }), false);
check("strip-pinned preview diff", isPreviewTab({ ...diff(1, true), pinned: true }), false);
check(
  "split pane holding a preview editor",
  isPreviewTab({
    id: 1,
    kind: "pane",
    title: "a.ts",
    activeLeafId: 2,
    paneTree: {
      kind: "split",
      id: 9,
      dir: "row",
      children: [
        { kind: "leaf", id: 2, leafKind: "editor", path: "/a.ts", dirty: false, preview: true },
        { kind: "leaf", id: 3, leafKind: "terminal" },
      ],
    } as never,
  }),
  false,
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall preview-slot checks passed");
