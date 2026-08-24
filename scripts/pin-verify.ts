/**
 * Pinned tabs and pinned workspaces.
 *
 * Three properties, none of which any type checker can catch:
 *
 *   A. The ordering invariant. Pinned first, stable within each half, and the
 *      SAME array back when nothing needs to move (React state setters bail out
 *      on reference equality, so returning a fresh array every drag frame would
 *      re-render the whole strip).
 *   B. The move-then-partition rule. A drag across the pinned boundary must
 *      LAND at the boundary, not be ignored. Reject it instead and the tab
 *      snaps back to where it started, which reads as a broken drag.
 *   C. The disambiguation the whole feature turns on: pinning is a property of
 *      the TAB, so a split group pins as a unit and says so ("Pin Group"), and
 *      a pinned tab loses its label and its close button. Those are structural
 *      claims about the source, checked textually because there is no DOM here.
 *
 * Run: `npx tsx scripts/pin-verify.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinnedBoundary, sortPinnedFirst } from "../src/lib/pinned";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}: ${label} = ${String(actual)}, want ${String(expected)}`);
}

type T = { id: string; pinned?: boolean };
const ids = (list: T[]): string => list.map((t) => t.id).join(",");
const mk = (spec: string): T[] =>
  spec.split(",").map((s) => (s.endsWith("*") ? { id: s.slice(0, -1), pinned: true } : { id: s }));

console.log("\n[A] pinned-first is a STABLE partition");
check("already correct is untouched", ids(sortPinnedFirst(mk("a*,b*,c,d"))), "a,b,c,d");
check("pinned pulled to the front", ids(sortPinnedFirst(mk("a,b*,c,d*"))), "b,d,a,c");
// Stability is what makes pin/unpin land the tab next to its new neighbours
// instead of at an extreme of the strip.
check("relative order kept in both halves", ids(sortPinnedFirst(mk("x,a*,y,b*,z"))), "a,b,x,y,z");
check("all pinned", ids(sortPinnedFirst(mk("a*,b*"))), "a,b");
check("none pinned", ids(sortPinnedFirst(mk("a,b"))), "a,b");
check("empty", ids(sortPinnedFirst([])), "");

console.log("\n[A2] an already-ordered list comes back by REFERENCE");
{
  const ordered = mk("a*,b,c");
  check("same reference when no move is needed", sortPinnedFirst(ordered) === ordered, true);
  const unordered = mk("a,b*");
  check("new reference only when it moved", sortPinnedFirst(unordered) === unordered, false);
}

console.log("\n[B] a drag across the boundary LANDS at the boundary");
{
  // "c" is unpinned and dropped between the two pinned tabs. Applying the move
  // and then partitioning must leave it first among the unpinned, not bounce it
  // back to where it came from and not leave it wedged between pinned tabs.
  const after = mk("a*,c,b*");
  const settled = sortPinnedFirst(after);
  check("unpinned cannot sit inside the pinned run", ids(settled), "a,b,c");
  // And the reverse: a pinned tab dragged into the unpinned run.
  check("pinned cannot sit inside the unpinned run", ids(sortPinnedFirst(mk("x,y,p*"))), "p,x,y");
}

console.log("\n[B2] the pinned/unpinned boundary");
check("boundary of a mixed list", pinnedBoundary(mk("a*,b*,c,d")), 2);
check("boundary when all pinned", pinnedBoundary(mk("a*,b*")), 2);
check("boundary when none pinned", pinnedBoundary(mk("a,b")), 0);

console.log("\n[C] pinning is a property of the TAB, not of a pane leaf");
const types = read("src/modules/tabs/lib/tabTypes.ts");
check("pinned lives on the Tab union", /export type Tab = \([^)]*\) & \{/.test(types), true);
const entries = read("src/modules/tabs/lib/entries.ts");
// Every entry of a split group must carry the OWNING TAB's flag, so the whole
// cluster compacts together instead of one pane shrinking on its own.
check("leaf entries inherit the tab's flag", entries.includes("pinned: t.pinned === true"), true);

const render = read("src/modules/tabs/components/renderEntryBody.tsx");
// A split group is several chips but one tab. Saying "Tab" there would promise
// that one pane flies out to the front of the strip on its own.
check(
  'a split group offers "Pin Group", not "Pin Tab"',
  render.includes('const pinLabel = isSplit ? "Group" : "Tab";'),
  true,
);
check("the pin action targets the tab id", render.includes("onSetTabPinned!(e.tabId"), true);

console.log("\n[C2] a pinned tab swaps its title for a pin and keeps its sizing");
check("the title is replaced by a pin", render.includes("pinInsteadOfTitle ? ("), true);
// The tab must NOT get a compact padding rule of its own. It narrows because a
// glyph is narrower than a name, which is a consequence of losing the title
// rather than a second, competing sizing decision.
check("no compact padding override", /justify-center px-1\.5!/.test(render), false);
check(
  "padding is the same expression every tab uses",
  render.includes('compact ? "px-2!" : totalEntries === 1 ? "px-2.5!" : "ps-2.5! pe-1.5!"'),
  true,
);
// Only the title was meant to go, so a pinned tab can still be closed.
check("close button still renders", render.includes("{canClose && !renaming && ("), true);
// Losing the title removes the only on-screen identification, so the hover has
// to put it back or two pinned terminals become indistinguishable.
check("a pinned tab gets a label tooltip", render.includes('? "pinned"'), true);
// TabsTrigger forces `size-4` on any svg without a size- CLASS, so the pin must
// set one or it renders as large as the identity icon.
check(
  "the pin sizes itself by CLASS, not attribute",
  /<Pin aria-label="Pinned" strokeWidth=\{2\.25\} className="size-3/.test(render),
  true,
);
// Renaming needs the title's place back.
check("the swap pauses while renaming", render.includes("isPinned && !renaming"), true);

console.log("\n[D] both surfaces re-impose the invariant where order comes from outside");
const useTabs = read("src/modules/tabs/lib/useTabs.ts");
check("tab reorder partitions", useTabs.includes("sortPinnedFirst(result)"), true);
check("tab restore partitions", useTabs.includes("setTabs(sortPinnedFirst(stamped))"), true);
const wsStore = read("src/modules/workspaces/store.ts");
check("workspace reorder partitions", wsStore.includes("sortPinnedFirst(next)"), true);
check("workspace hydrate partitions", wsStore.includes("sortPinnedFirst(list)"), true);

console.log("\n[E] a pin survives a restart");
const serialize = read("src/modules/workspaces/serialize.ts");
check("written on save", serialize.includes("...(tab.pinned ? { pinned: true } : {})"), true);
check(
  "read back on restore",
  serialize.includes("...(saved.pinned ? { pinned: true } : {})"),
  true,
);

console.log("\n[F] the two pin axes name their own subject");
const panel = read("src/modules/workspaces/WorkspacesPanel.tsx");
check('workspace menu says "Pin Workspace"', panel.includes('"Pin Workspace"'), true);
check("workspace menu is reachable by right-click", panel.includes("<ContextMenuTrigger"), true);

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: pin-verify`);
process.exit(failed === 0 ? 0 : 1);
