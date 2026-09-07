/**
 * Status-bar zones: the merge, the drag, the lock, what a folded bar keeps, and
 * the one CSS rule the bar's spacing rhythm hangs on.
 *
 * All four are invisible to the type checker and to any rendered test: the
 * failure modes are an item that quietly moves house when an extension is
 * installed, an arrangement that resets itself, an AI button that a stray drag
 * carried off the bar, and a fold that hides the one control the user wanted
 * kept. Each is a pure function, so each is checked here.
 *
 * Run: `npx tsx scripts/ui/statusbar-zones-verify.ts`.
 */
import { readFileSync } from "node:fs";

import {
  LOCKED_ZONE,
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

const item = (id: string, defaultZone: StatusZone): ZoneItem => ({ id, defaultZone });

/** A realistic bar: two usage meters and a memory meter kept when folded, two
 *  indicator lights and a row of buttons that fold away, and TEDI's own AI
 *  locked at the right. */
const ITEMS: ZoneItem[] = [
  item("updater", 0),
  item("zoom", 0),
  item("ext:tedi.ai-usage:claude", 0),
  item("ext:tedi.ai-usage:codex", 0),
  item("ext:tedi.process-monitor:procs", 0),
  item("ext:tedi.discord-rich-presence:discord", 1),
  item("ext:tedi.remote-access:remote", 1),
  item("scheduler", 1),
  item("panel:tedi.browser:browser", 1),
  item("panel:tedi.sql-explorer:sql-explorer", 1),
  item("scm", 1),
  item("ai:agent", 2),
  item("ai:panel", 2),
];
const EMPTY: string[][] = [[], [], []];
const ids = (zones: ZoneItem[][]) => zones.map((z) => z.map((i) => i.id));

// A. With nothing saved, every item follows its own default, in declaration
//    order. This is the bar a fresh install draws.
check("defaults", ids(resolveZones(ITEMS, EMPTY)), [
  [
    "updater",
    "zoom",
    "ext:tedi.ai-usage:claude",
    "ext:tedi.ai-usage:codex",
    "ext:tedi.process-monitor:procs",
  ],
  [
    "ext:tedi.discord-rich-presence:discord",
    "ext:tedi.remote-access:remote",
    "scheduler",
    "panel:tedi.browser:browser",
    "panel:tedi.sql-explorer:sql-explorer",
    "scm",
  ],
  ["ai:agent", "ai:panel"],
]);

// B. A saved placement wins, and an item nobody placed still follows its
//    default - appended AFTER the placed ones, so installing an extension can
//    never reshuffle an arrangement somebody made.
const partial = [["ext:tedi.process-monitor:procs", "zoom"], ["scm"], []];
check("a partial layout keeps its order and appends the rest", ids(resolveZones(ITEMS, partial)), [
  [
    "ext:tedi.process-monitor:procs",
    "zoom",
    "updater",
    "ext:tedi.ai-usage:claude",
    "ext:tedi.ai-usage:codex",
  ],
  [
    "scm",
    "ext:tedi.discord-rich-presence:discord",
    "ext:tedi.remote-access:remote",
    "scheduler",
    "panel:tedi.browser:browser",
    "panel:tedi.sql-explorer:sql-explorer",
  ],
  ["ai:agent", "ai:panel"],
]);

// C. An id from an extension that is gone is ignored, and an id saved into two
//    zones (a hand-edited settings file) keeps its first placement rather than
//    rendering the same item twice.
const dirty = [["ext:tedi.uninstalled:gone", "scm"], ["scm"], []];
const dirtyZones = ids(resolveZones(ITEMS, dirty));
check("a stale id is dropped", dirtyZones[0][0], "scm");
check("a duplicated id lands once", dirtyZones.flat().filter((x) => x === "scm").length, 1);

// D. A drag writes a DENSE layout: after one move the whole arrangement is
//    explicit, so a later change to any default cannot reshuffle it. The locked
//    zone is not part of that - it is never read back, so it is never written.
const moved = moveItem(ITEMS, EMPTY, "ext:tedi.remote-access:remote", 0, 1);
check(
  "a move writes every live UNLOCKED item",
  moved.flat().length,
  ITEMS.filter((i) => i.defaultZone !== LOCKED_ZONE).length,
);
check("...and nothing into the locked zone", moved[LOCKED_ZONE], []);
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
check("dropping on empty space appends", moveItem(ITEMS, EMPTY, "zoom", 1, -1)[1].at(-1), "zoom");

// F. An extension that is disabled right now is still in the saved layout, and
//    a drag must not silently forget where it lived.
const withAbsent = [["ext:tedi.disabled:thing"], [], []];
const afterMove = moveItem(ITEMS, withAbsent, "scm", 1, 0);
check(
  "a saved-but-absent id survives a drag",
  afterMove[0].includes("ext:tedi.disabled:thing"),
  true,
);

// G. The lock, in both directions. TEDI's own AI cannot be dragged out, nothing
//    can be dropped on it, and a layout saved before the zone was locked (or
//    hand-edited since) cannot smuggle anything past either rule. The refused
//    move must also leave the layout byte-identical: a drag that should not
//    have started must not persist a rewrite as a side effect.
check("a locked item cannot be dragged out", moveItem(ITEMS, EMPTY, "ai:panel", 0, 0), EMPTY);
check("nothing can be dropped into the locked zone", moveItem(ITEMS, EMPTY, "scm", 2, 0), EMPTY);
check(
  "a refused move leaves a NON-empty layout untouched",
  moveItem(ITEMS, partial, "ai:agent", 1, 0),
  partial,
);
const smuggled = [["ai:panel"], [], ["scm", "zoom"]];
const smuggledZones = ids(resolveZones(ITEMS, smuggled));
check("a locked item saved elsewhere stays locked", smuggledZones[LOCKED_ZONE], [
  "ai:agent",
  "ai:panel",
]);
check("...and does not appear twice", smuggledZones[0].includes("ai:panel"), false);
check("...while an unlocked item saved in the locked zone falls back", smuggledZones[1], [
  "ext:tedi.discord-rich-presence:discord",
  "ext:tedi.remote-access:remote",
  "scheduler",
  "panel:tedi.browser:browser",
  "panel:tedi.sql-explorer:sql-explorer",
  "scm",
]);

// H. The compact rule. Only the middle zone folds - so dragging something out
//    of it is how you say "keep this when I fold the bar", and the locked AI
//    never folds at all.
const zones = resolveZones(ITEMS, EMPTY);
check(
  "compact keeps all of zone 0",
  zones[0].every((i) => visibleInCompact(i, 0)),
  true,
);
check("compact folds the middle zone", visibleInCompact(item("scheduler", 1), 1), false);
check(
  "compact keeps the locked AI",
  zones[LOCKED_ZONE].every((i) => visibleInCompact(i, LOCKED_ZONE)),
  true,
);
check(
  "compact keeps anything dragged out of the middle",
  visibleInCompact(item("scheduler", 1), 0),
  true,
);

// I. The group hairline must stay POSITIONED, not laid out.
//
//    As a flex child it costs 1px of content plus a second 6px `gap`, so two
//    icons either side of a group boundary sit 37px apart where two icons in
//    one group sit 30px - and, because a `::before` paints inside its own
//    group's box, that 7px lands INSIDE a zone's drag tint and indents the
//    first icon of every zone but the first. Both are invisible to every other
//    check here, and the tempting "tidy-up" is to put `flex: none` back.
const CSS = readFileSync(new URL("../../src/styles/globals.css", import.meta.url), "utf8");
const divider = CSS.slice(
  CSS.indexOf(".sb-group:has(> .sb-item:not(:empty)) ~ .sb-group:has(> .sb-item:not(:empty))"),
).slice(0, 400);
check("the hairline is absolutely positioned", divider.includes("position: absolute"), true);
check("...and so takes no space in the row", divider.includes("flex: none"), false);
check("...against a positioned group", /\.sb-group \{\s*position: relative;/.test(CSS), true);

// `throw` rather than `process.exit`, like every sibling check: it fails the
// run without pulling node's globals into a browser-typed project.
if (failures > 0) throw new Error(`${failures} check(s) FAILED`);
console.log("statusbar-zones-verify: ok (22 checks)");
