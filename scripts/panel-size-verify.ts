/**
 * The side columns must survive a panel that exists but has no layout yet.
 *
 * `react-resizable-panels` throws `Layout not found for Panel <id>` from
 * `getSize()`, `expand()` AND `collapse()` whenever the panel element is in the
 * tree but the group has not registered a layout for it. That is the normal
 * frame right after a column mounts: the side columns render no panel while
 * they hold nothing, so the first section to arrive both mounts the panel and
 * bumps the section count, and the effect that reacts to the count reads a ref
 * that is already set. The throw escaped the effect, reached the ErrorBoundary
 * and blanked the pane stack - which is what "opening the right pane errors"
 * looked like from the outside.
 *
 * A `panel &&` null check does not catch it, which is why this is a guard and
 * not a comment: the ref is non-null by then.
 *
 * Run: `npx tsx scripts/panel-size-verify.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expandIfShut,
  isPanelOpen,
  panelCollapsed,
  panelSizePct,
  setPanelCollapsed,
  setPanelOpen,
  togglePanelOpen,
} from "../src/app/lib/panelSize";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}: ${label} = ${String(actual)}, want ${String(expected)}`);
}

/** A handle whose every accessor throws, exactly as the library's does. */
function unlaidOut() {
  const boom = (): never => {
    throw new Error("Layout not found for Panel right-slot");
  };
  return {
    calls: [] as string[],
    getSize: boom,
    expand: boom,
    collapse: boom,
    isCollapsed: boom,
  };
}

/** A handle that is laid out at `pct` and records what was called on it. */
function laidOut(pct: number) {
  const calls: string[] = [];
  return {
    calls,
    getSize: () => ({ asPercentage: pct, inPixels: pct * 10 }),
    expand: () => void calls.push("expand"),
    collapse: () => void calls.push("collapse"),
    isCollapsed: () => pct <= 0,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const as = (h: unknown) => h as any;

console.log("\n[A] a panel with no layout never throws through the helpers");
check("panelSizePct -> null", panelSizePct(as(unlaidOut())), null);
// Unknown counts as hidden: a panel nobody can measure is not on screen.
check("isPanelOpen -> false", isPanelOpen(as(unlaidOut())), false);
for (const [name, fn] of [
  ["expandIfShut", expandIfShut],
  ["togglePanelOpen", togglePanelOpen],
] as const) {
  let threw = false;
  try {
    fn(as(unlaidOut()));
  } catch {
    threw = true;
  }
  check(`${name} does not throw`, threw, false);
}

console.log("\n[A2] and it must not act on a panel it cannot measure");
{
  // Acting blind is the other half of the bug: expand()/collapse() throw from
  // the same lookups, so "unknown means closed, therefore expand" crashes too.
  const h1 = unlaidOut();
  try {
    expandIfShut(as(h1));
  } catch {
    /* covered above */
  }
  check("expandIfShut called nothing", h1.calls.length, 0);
  const h2 = unlaidOut();
  try {
    togglePanelOpen(as(h2));
  } catch {
    /* covered above */
  }
  check("togglePanelOpen called nothing", h2.calls.length, 0);
}

console.log("\n[B] a laid-out panel still behaves");
check("panelSizePct reads the percentage", panelSizePct(as(laidOut(37))), 37);
check("isPanelOpen at 37%", isPanelOpen(as(laidOut(37))), true);
check("isPanelOpen at 0%", isPanelOpen(as(laidOut(0))), false);
{
  const shut = laidOut(0);
  expandIfShut(as(shut));
  check("expandIfShut expands a collapsed panel", shut.calls.join(","), "expand");
  const open = laidOut(25);
  expandIfShut(as(open));
  check("expandIfShut leaves an open panel alone", open.calls.length, 0);
  const t1 = laidOut(25);
  togglePanelOpen(as(t1));
  check("toggle collapses an open panel", t1.calls.join(","), "collapse");
  const t2 = laidOut(0);
  togglePanelOpen(as(t2));
  check("toggle expands a shut panel", t2.calls.join(","), "expand");
}
check("a null handle is inert", panelSizePct(null), null);

console.log("\n[B2] the collapse pair, which is NOT the same question as width");
// A section collapses to its header height, not to zero, so only the library
// can answer. Reading width there would report every minimized section as open.
check("panelCollapsed with no layout -> null", panelCollapsed(as(unlaidOut())), null);
check("panelCollapsed reads the library", panelCollapsed(as(laidOut(0))), true);
check("panelCollapsed when open", panelCollapsed(as(laidOut(30))), false);
{
  let threw = false;
  const h = unlaidOut();
  try {
    setPanelCollapsed(as(h), true);
  } catch {
    threw = true;
  }
  check("setPanelCollapsed does not throw", threw, false);
  check("setPanelCollapsed called nothing", h.calls.length, 0);

  const open = laidOut(30);
  setPanelCollapsed(as(open), true);
  check("setPanelCollapsed collapses an open section", open.calls.join(","), "collapse");
  const shut = laidOut(0);
  setPanelCollapsed(as(shut), true);
  check("setPanelCollapsed is a no-op when already there", shut.calls.length, 0);

  const s1 = unlaidOut();
  let threw2 = false;
  try {
    setPanelOpen(as(s1), true);
  } catch {
    threw2 = true;
  }
  check("setPanelOpen does not throw", threw2, false);
  check("setPanelOpen called nothing", s1.calls.length, 0);
  const s2 = laidOut(0);
  setPanelOpen(as(s2), true);
  check("setPanelOpen expands a shut column", s2.calls.join(","), "expand");
  const s3 = laidOut(20);
  setPanelOpen(as(s3), true);
  check("setPanelOpen is a no-op when already open", s3.calls.length, 0);
}

console.log("\n[C] nothing under src/app touches a panel handle directly any more");
// The whole point is that ONE file knows these throw. A new direct call is a
// new crash site, so fail on it here rather than discovering it from a blanked
// pane stack.
//
// All four are checked, not just getSize: expand(), collapse() and
// isCollapsed() resolve the panel through the same two lookups, so reading
// safely and then acting blind crashes just the same. That is exactly how the
// second half of this bug survived the first fix.
const offenders: string[] = [];
const walk = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.tsx?$/.test(e.name)) continue;
    const rel = p.slice(repoRoot.length + 1).replace(/\\/g, "/");
    if (rel === "src/app/lib/panelSize.ts") continue;
    for (const [i, line] of readFileSync(p, "utf8").split("\n").entries()) {
      // Skip prose: these files explain the hazard in comments.
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      // `tree.expand(...)` in the explorers is a different API and takes an
      // argument; a panel handle's expand/collapse take none.
      if (/\.(getSize|isCollapsed)\s*\(|\.(expand|collapse)\s*\(\s*\)/.test(code)) {
        offenders.push(`${rel}:${i + 1}`);
      }
    }
  }
};
walk(join(repoRoot, "src", "app"));
check("direct getSize() call sites", offenders.length === 0 ? "none" : offenders.join(" "), "none");

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: panel-size-verify`);
process.exit(failed === 0 ? 0 : 1);
