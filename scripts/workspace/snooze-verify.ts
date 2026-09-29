/**
 * Snoozed tabs: off the tab strip, listed only in the Workspaces panel.
 * Run: `npx tsx scripts/workspace/snooze-verify.ts` (or `pnpm verify`).
 *
 *   1. `stripTabs` drops snoozed tabs but KEEPS the active one, so opening a
 *      snoozed tab from the Workspaces panel still has a chip to highlight.
 *   2. It returns the SAME array when nothing is snoozed, so the strip's memo
 *      does not churn for the common case.
 *   3. The flag survives a restart, and the menu names its subject the way the
 *      pin item does ("Snooze Group" on a split).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripTabs } from "../../src/modules/tabs/lib/tabHelpers";
import type { Tab } from "../../src/modules/tabs/lib/tabTypes";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (got === want) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const mk = (spec: string): Tab[] =>
  spec.split(",").map(
    (s) =>
      ({
        id: Number(s.replace("z", "")),
        kind: "scm",
        title: s,
        ...(s.endsWith("z") ? { snoozed: true } : {}),
      }) as unknown as Tab,
  );
const ids = (list: Tab[]): string => list.map((t) => t.id).join(",");

const none = mk("1,2,3");
check("nothing snoozed returns the same array", stripTabs(none, 1), none);
check("snoozed tabs leave the strip", ids(stripTabs(mk("1,2z,3"), 1)), "1,3");
check("the ACTIVE snoozed tab stays visible", ids(stripTabs(mk("1,2z,3"), 2)), "1,2,3");
check("all snoozed but the active", ids(stripTabs(mk("1z,2z"), 2)), "2");

const serialize = read("src/modules/workspaces/serialize.ts");
check("saved on write", serialize.includes("...(tab.snoozed ? { snoozed: true } : {})"), true);
check("restored on read", serialize.includes("...(saved.snoozed ? { snoozed: true } : {})"), true);

const menu = read("src/modules/tabs/components/renderEntryBody.tsx");
check("menu says Snooze Tab / Snooze Group", menu.includes('"Snooze"} ${pinLabel}'), true);

const bar = read("src/modules/tabs/TabBar.tsx");
check("strip renders through stripTabs", bar.includes("stripTabs(allTabs, activeId)"), true);

console.log(failed === 0 ? "\nAll snooze checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
