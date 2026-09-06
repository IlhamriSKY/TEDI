/**
 * Status-bar zones: the merge, the drag, and what a folded bar keeps.
 *
 * All three are invisible to the type checker and to any rendered test: the
 * failure modes are an item that quietly moves house when an extension is
 * installed, an arrangement that resets itself, and a fold that hides the one
 * control the user wanted kept. Each is a pure function, so each is checked
 * here.
 *
 * Run: `npx tsx scripts/ui/statusbar-zones-verify.ts`.
 */
import {
  moveItem,
  resolveZones,
  visibleInCompact,
  type StatusZone,
  type ZoneItem,
} from "../../src/modules/statusbar/layout";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  console.error(`  FAIL ${label}\n    expected ${b}\n    got      ${a}`);
  failures++;
}

const item = (id: string, defaultZone: StatusZone, pinned = false): ZoneItem => ({
  id,
  defaultZone,
  ...(pinned ? { pinned: true } : {}),
});

/** A realistic bar: two usage meters and a memory meter, two indicator lights,
 *  a handful of buttons, and TEDI's own AI pinned at both ends of the row. */
const ITEMS: ZoneItem[] = [
  item("updater", 0),
  item("zoom", 0),
  item("ai:agent", 0, true),
  item("ext:tedi.ai-usage:claude", 0),
  item("ext:tedi.ai-usage:codex", 0),
  item("ext:tedi.process-monitor:procs", 0),
  item("ext:tedi.discord-rich-presence:discord", 1),
  item("ext:tedi.remote-access:remote", 1),
  item("scheduler", 1),
  item("panel:tedi.browser:browser", 2),
  item("panel:tedi.sql-explorer:sql-explorer", 2),
  item("scm", 2),
  item("ai:panel", 2, true),
];
const EMPTY: string[][] = [[], [], []];
const ids = (zones: ZoneItem[][]) => zones.map((z) => z.map((i) => i.id));

// A. With nothing saved, every item follows its own default, in declaration
//    order. This is the bar a fresh install draws.
check("defaults", ids(resolveZones(ITEMS, EMPTY)), [
  [
    "updater",
    "zoom",
    "ai:agent",
    "ext:tedi.ai-usage:claude",
    "ext:tedi.ai-usage:codex",
    "ext:tedi.process-monitor:procs",
  ],
  ["ext:tedi.discord-rich-presence:discord", "ext:tedi.remote-access:remote", "scheduler"],
  ["panel:tedi.browser:browser", "panel:tedi.sql-explorer:sql-explorer", "scm", "ai:panel"],
]);

// B. A saved placement wins, and an item nobody placed still follows its
//    default - appended AFTER the placed ones, so installing an extension can
//    never reshuffle an arrangement somebody made.
const partial = [["ext:tedi.process-monitor:procs", "zoom"], [], ["ai:panel"]];
check("a partial layout keeps its order and appends the rest", ids(resolveZones(ITEMS, partial)), [
  [
    "ext:tedi.process-monitor:procs",
    "zoom",
    "updater",
    "ai:agent",
    "ext:tedi.ai-usage:claude",
    "ext:tedi.ai-usage:codex",
  ],
  ["ext:tedi.discord-rich-presence:discord", "ext:tedi.remote-access:remote", "scheduler"],
  ["ai:panel", "panel:tedi.browser:browser", "panel:tedi.sql-explorer:sql-explorer", "scm"],
]);

// C. An id from an extension that is gone is ignored, and an id saved into two
//    zones (a hand-edited settings file) keeps its first placement rather than
//    rendering the same item twice.
const dirty = [["ext:tedi.uninstalled:gone", "scm"], ["scm"], []];
const dirtyZones = ids(resolveZones(ITEMS, dirty));
check("a stale id is dropped", dirtyZones[0][0], "scm");
check("a duplicated id lands once", dirtyZones.flat().filter((x) => x === "scm").length, 1);

// D. A drag writes a DENSE layout: after one move the whole arrangement is
//    explicit, so a later change to any default cannot reshuffle it.
const moved = moveItem(ITEMS, EMPTY, "ext:tedi.remote-access:remote", 0, 1);
check("a move writes every live item", moved.flat().length, ITEMS.length);
check("...and lands at the index it was dropped on", moved[0][1], "ext:tedi.remote-access:remote");
check(
  "...leaving the zone it came from",
  moved[1].includes("ext:tedi.remote-access:remote"),
  false,
);
check(
  "...and resolving back to what was dropped",
  ids(resolveZones(ITEMS, moved))[0][1],
  "ext:tedi.remote-access:remote",
);

// E. An index past the end (dropped on a zone's empty space) appends.
check("dropping on empty space appends", moveItem(ITEMS, EMPTY, "zoom", 2, -1)[2].at(-1), "zoom");

// F. An extension that is disabled right now is still in the saved layout, and
//    a drag must not silently forget where it lived.
const withAbsent = [["ext:tedi.disabled:thing"], [], []];
const afterMove = moveItem(ITEMS, withAbsent, "scm", 1, 0);
check(
  "a saved-but-absent id survives a drag",
  afterMove[0].includes("ext:tedi.disabled:thing"),
  true,
);

// G. The compact rule. Zone 0 is kept whole, the pinned AI is kept wherever it
//    sits, and everything else folds - so dragging something into the readouts
//    is also how you say "keep this when I fold the bar".
const zones = resolveZones(ITEMS, EMPTY);
check(
  "compact keeps all of zone 0",
  zones[0].every((i) => visibleInCompact(i, 0)),
  true,
);
check("compact folds an unpinned indicator", visibleInCompact(item("scheduler", 1), 1), false);
check(
  "compact keeps the pinned AI in the actions zone",
  visibleInCompact(item("ai:panel", 2, true), 2),
  true,
);
check(
  "compact keeps anything dragged into the readouts",
  visibleInCompact(item("scheduler", 1), 0),
  true,
);

// `throw` rather than `process.exit`, like every sibling check: it fails the
// run without pulling node's globals into a browser-typed project.
if (failures > 0) throw new Error(`${failures} check(s) FAILED`);
console.log("statusbar-zones-verify: ok (13 checks)");
