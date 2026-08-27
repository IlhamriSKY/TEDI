/**
 * Guards the left/right docking routing table (`src/app/lib/sectionDock.ts`).
 *
 * The bug this exists to catch is drift between the two ways a section changes
 * column - the move button on its header, and dragging its grip across. Before
 * the table existed each was wired separately, so Source Control and Remote had
 * buttons that worked and a drag that silently did nothing, and the AI panel had
 * neither. The invariant is simply: anything the table says MAY move must have a
 * route in BOTH directions.
 *
 * `sectionDock.ts` itself cannot be imported here - it reaches
 * `@/modules/settings/store`, which pulls the Tauri layer - so the switch arms
 * are read out of the source. `undockTarget` has no such dependency (only
 * zustand), so that half is exercised for real.
 *
 * Run: `npx tsx scripts/workspace/section-dock-verify.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_SECTION_EXT,
  sectionPanelId,
  sidebarSectionKey,
  undockTarget,
} from "../../src/modules/extensions/sidebarPlacementStore";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(repoRoot, "src/app/lib/sectionDock.ts"), "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
}

/** The `case "x":` labels inside one exported function of sectionDock.ts. */
function switchCases(fnName: string): string[] {
  const start = src.indexOf(`export function ${fnName}(`);
  if (start < 0) return [];
  // Up to the next top-level `export function`, or the end of the file.
  const after = src.indexOf("\nexport function ", start + 1);
  const body = src.slice(start, after < 0 ? src.length : after);
  return [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
}

const listed = /DUAL_COLUMN_BUILTINS = \[([^\]]+)\]/.exec(src);
const dualColumn = listed ? [...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

console.log("\n[routing table] every dual-column section moves BOTH ways");
check("DUAL_COLUMN_BUILTINS is not empty", dualColumn.length > 0, "regex found nothing");

const right = switchCases("dockRight");
const left = switchCases("dockLeft");
for (const key of dualColumn) {
  check(`"${key}" has a dockRight route`, right.includes(key), `dockRight cases: ${right.join()}`);
  // Files / Workspaces reach the left through `undockTarget` rather than a case
  // of their own, which the next block proves; everything else needs an arm.
  const viaUndock = undockTarget(key) !== null;
  check(
    `"${key}" has a dockLeft route`,
    left.includes(key) || viaUndock,
    `dockLeft cases: ${left.join()}`,
  );
}

console.log("\n[undockTarget] the right column's own keys resolve to a sidebar home");
// A built-in docked right is keyed by its PLAIN id there (AppRightSlot renders
// Files / Workspaces as React panels, not `xp:` extension hosts). Getting this
// wrong once made the drag work left-to-right and not back.
for (const key of ["files", "workspaces"]) {
  const t = undockTarget(key);
  check(
    `"${key}" undocks to the builtin sentinel`,
    t?.extensionId === BUILTIN_SECTION_EXT &&
      t.panelId === sectionPanelId(key) &&
      t.placement === key,
    JSON.stringify(t),
  );
}
{
  const t = undockTarget("xp:acme:__section__:notes");
  check(
    "a docked extension SECTION undocks to its sidebar key",
    t?.extensionId === "acme" &&
      t.panelId === sectionPanelId("notes") &&
      t.placement === sidebarSectionKey("acme", "notes"),
    JSON.stringify(t),
  );
}
check(
  "a manifest right-panel has no sidebar home and stays put",
  undockTarget("xp:acme:apiClient") === null,
);

// ---------------------------------------------------------------------------
// The two columns must stay SYMMETRIC. Each of these has been asked for, and
// each is a one-line edit away from silently regressing on one side only.
console.log("\n[columns] left and right are wired the same way");

const SIDEBAR = readFileSync(join(repoRoot, "src/app/components/AppSidebar.tsx"), "utf8");
const RIGHT = readFileSync(join(repoRoot, "src/app/components/AppRightSlot.tsx"), "utf8");
const COLUMNS: Array<[string, string, "left" | "right"]> = [
  ["AppSidebar", SIDEBAR, "left"],
  ["AppRightSlot", RIGHT, "right"],
];

for (const [name, src, column] of COLUMNS) {
  // Both columns close fully, not just the sidebar.
  check(`${name} panel is collapsible`, /\bcollapsible\b/.test(src));
  check(`${name} collapses to zero`, /collapsedSize=\{0\}/.test(src));

  // A px minSize on a COLLAPSIBLE panel is re-derived against the live
  // container, so a window minimize/restore ramp can make `size < minSize` true
  // and force the panel shut for good. That bug cost three failed fixes on the
  // sidebar; a percentage is container-invariant.
  const minSize = /minSize="([^"]+)"/.exec(src)?.[1];
  check(
    `${name} minSize is a PERCENTAGE, never px`,
    !!minSize && minSize.endsWith("%"),
    `minSize=${minSize ?? "absent"}`,
  );

  // A column that is empty or minimized shut has no box for a drag to aim at.
  check(
    `${name} puts up a drop rail for its own side`,
    src.includes(`<SectionDropRail column="${column}" />`),
  );
  // ...and opens itself when a section actually lands there.
  check(
    `${name} expands when a section lands in it`,
    src.includes(`useExpandOnSectionArrival("${column}"`),
  );
}

// A panel group must fill 100% of its container, so with only real sections in
// it the library keeps one of them open to absorb what N collapsed headers leave
// over - which is why the last section could not be minimized. Both halves of
// the fix have to stay: the filler that takes the leftover, and the re-assert
// loop (collapsing one section pushes its space onto the next panel and pops a
// collapsed neighbour back open, so the desired set has to be re-applied).
{
  const stack = readFileSync(join(repoRoot, "src/app/components/SectionStack.tsx"), "utf8");
  check(
    "SectionStack renders a filler panel",
    /-filler`}\s*defaultSize=\{0\}\s*minSize=\{0\}/.test(stack),
  );
  check(
    "no ResizableHandle immediately before the filler",
    !/<ResizableHandle[^>]*\/>\s*\{\s*\/\*[\s\S]{0,900}?-filler/.test(stack),
    "a handle there would let the user drag against the filler",
  );
  check(
    "toggleCollapse re-asserts the whole collapsed set",
    /const desired = visible\.filter/.test(stack) && /for \(let pass = 0/.test(stack),
  );
}

// The library snaps a collapsible panel shut at the MIDPOINT between
// collapsedSize and minSize, so a column with a larger minimum has to be dragged
// relatively further before it closes, and springs back out anywhere short of
// that. Different minimums therefore read as "the right column refuses to close
// the way the left one does" - the complaint that started this.
{
  const leftMin = /minSize="([^"]+)"/.exec(SIDEBAR)?.[1];
  const rightMin = /minSize="([^"]+)"/.exec(RIGHT)?.[1];
  check(
    "both columns snap shut at the same drag threshold (equal minSize)",
    !!leftMin && leftMin === rightMin,
    `left=${leftMin ?? "absent"} right=${rightMin ?? "absent"}`,
  );
}

// Which column renders Source Control / Remote is a PERSISTED preference, and
// the write goes over IPC while the right column's open flag is set
// synchronously. Flipping the raw setter leaves several ticks where the app sees
// "open on the right" plus "not docked right", which is exactly the state
// `useRightPanelExclusion` closes - and once the echo lands the sidebar has
// dropped the section too, so it ends up in NEITHER column.
// `setColumnPlacement` writes the local store first and closes that window.
check(
  "sectionDock flips SCM/Remote placement through setColumnPlacement",
  src.includes("setColumnPlacement(") &&
    !/\bsetSourceControlInRightPanel\(|\bsetSshInRightPanel\(/.test(src),
  "found a raw placement setter - use setColumnPlacement",
);

console.log(
  failures === 0
    ? "\nsection-dock-verify: OK\n"
    : `\nsection-dock-verify: ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
