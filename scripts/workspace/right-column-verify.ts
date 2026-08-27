/**
 * Self-check for the stacked right column.
 * Run: `npx tsx scripts/workspace/right-column-verify.ts`.
 *
 * Two invariants, both of which used to be enforced by the fact that the column
 * could only ever hold ONE thing:
 *
 *  1. The right-panel store is a SET of open panels. Opening a second one must
 *     not evict the first (that was the whole point of the change), opening the
 *     same one twice must not duplicate it, and closing one must leave its
 *     neighbours alone. A bare `close()` still clears the column, because that
 *     is what an extension's "hide the right sidebar" means.
 *  2. The persisted drag order is reconciled, not trusted: sections come and go
 *     (an extension is disabled, a panel is closed, a section is docked from the
 *     other side), so a stale key must be dropped and an unknown one appended
 *     without disturbing the arrangement the user dragged into place.
 */
import { isRightPanelOpen, useRightPanelStore } from "../../src/modules/extensions/rightPanelStore";
import {
  sectionPanelId,
  undockTarget,
  useSidebarPlacementStore,
} from "../../src/modules/extensions/sidebarPlacementStore";
import { reconcileSectionOrder } from "../../src/app/lib/sectionOrder";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const store = useRightPanelStore;
const ids = () => store.getState().panels.map((p) => `${p.extensionId}:${p.panelId}`);

console.log("[store] several panels share the column");
store.getState().close();
store.getState().open("ext.a", "one");
store.getState().open("ext.b", "two");
check("opening a second panel keeps the first", ids().length === 2, ids());
check("order is open-order", ids().join(",") === "ext.a:one,ext.b:two", ids());
store.getState().open("ext.a", "one");
check("opening an already-open panel is a no-op", ids().length === 2, ids());
check("isRightPanelOpen finds a member", isRightPanelOpen(store.getState().panels, "ext.b", "two"));
check(
  "isRightPanelOpen rejects a non-member",
  !isRightPanelOpen(store.getState().panels, "ext.b", "nope"),
);

console.log("\n[store] closing is per-panel");
store.getState().close("ext.a", "one");
check("the named panel closes", !isRightPanelOpen(store.getState().panels, "ext.a", "one"));
check("its neighbour survives", isRightPanelOpen(store.getState().panels, "ext.b", "two"), ids());
store.getState().close("ext.a", "one");
check("closing an already-closed panel is a no-op", ids().length === 1, ids());

console.log("\n[store] toggle round-trips, bare close clears the column");
store.getState().toggle("ext.c", "three");
check("toggle opens", isRightPanelOpen(store.getState().panels, "ext.c", "three"));
store.getState().toggle("ext.c", "three");
check("toggle closes", !isRightPanelOpen(store.getState().panels, "ext.c", "three"));
check("and only that one", ids().join(",") === "ext.b:two", ids());
store.getState().open("ext.d", "four");
store.getState().close();
check("bare close() empties the column", ids().length === 0, ids());

console.log("\n[order] a persisted arrangement survives sections coming and going");
check(
  "persisted order wins over the caller's order",
  reconcileSectionOrder(["scm", "files"], ["files", "scm"]).join(",") === "scm,files",
);
check(
  "a key that no longer exists is dropped, not rendered as a hole",
  reconcileSectionOrder(["scm", "gone", "files"], ["files", "scm"]).join(",") === "scm,files",
);
check(
  "a new key is APPENDED, so opening a panel never reshuffles the rest",
  reconcileSectionOrder(["scm", "files"], ["files", "scm", "ai"]).join(",") === "scm,files,ai",
);
check(
  "no persisted order yet -> the caller's order verbatim",
  reconcileSectionOrder([], ["ai", "scm"]).join(",") === "ai,scm",
);
check(
  // A repeat would be a duplicate React key, two dnd-kit items on one id, and
  // two resizable panels on one id.
  "a repeated key in a corrupt persisted value renders once",
  reconcileSectionOrder(["ai", "ai"], ["ai", "scm"]).join(",") === "ai,scm",
  reconcileSectionOrder(["ai", "ai"], ["ai", "scm"]),
);

console.log("\n[placement] a built-in section docks right and comes back");
for (const key of ["files", "workspaces"]) {
  const placement = useSidebarPlacementStore;
  placement.getState().moveRight(key);
  check(`${key}: moveRight marks it right`, placement.getState().placement[key] === "right");
  check(`${key}: docking starts it open`, placement.getState().rightOpen[key] === true);
  // The drag back is keyed by the PLAIN built-in id (the right column renders
  // built-ins directly, not under the `xp:` shape) - miss this and the section
  // drags left-to-right but not back.
  const back = undockTarget(key);
  check(`${key}: undockTarget resolves`, back?.placement === key, back);
  check(`${key}: undocks the same panel it docked`, back?.panelId === sectionPanelId(key), back);
  placement.getState().moveLeft(key);
  check(`${key}: moveLeft marks it left`, placement.getState().placement[key] === "left");
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
