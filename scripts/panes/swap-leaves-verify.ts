/**
 * `swapLeaves` exchanges two panes and changes nothing else.
 * Run: `npx tsx scripts/panes/swap-leaves-verify.ts`.
 *
 * Backs `pane.swapNext` / `pane.swapPrev`. Splits, directions and sizes stay
 * put (only the leaves trade places), and a no-op answers with the SAME tree by
 * reference: `updateLeafTree` compares identity, and a fresh root on a no-op
 * would re-serialize the whole workspaces file (see
 * ext-panel-leaf-identity-verify.ts for the time that cost real writes).
 */
import {
  leafIds,
  nextLeafId,
  swapLeaves,
  type PaneNode,
} from "../../src/modules/terminal/lib/panes";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

const leaf = (id: number): PaneNode => ({ kind: "leaf", id, leafKind: "terminal" }) as PaneNode;

// row[ 1 | col[ 2 / 3 ] ] with explicit sizes on both splits.
const tree = {
  kind: "split",
  id: 10,
  dir: "row",
  sizes: [40, 60],
  children: [
    leaf(1),
    { kind: "split", id: 11, dir: "col", sizes: [30, 70], children: [leaf(2), leaf(3)] },
  ],
} as PaneNode;

console.log("\nswapLeaves trades two panes and keeps the layout\n");

const swapped = swapLeaves(tree, 1, 3);
check("leaves trade places across splits", leafIds(swapped).join() === "3,2,1", leafIds(swapped));
check(
  "splits, directions and sizes are untouched",
  JSON.stringify(swapped).replace(/"id":[13],/g, "") ===
    JSON.stringify(tree).replace(/"id":[13],/g, ""),
);
check(
  "swapping back restores the original",
  JSON.stringify(swapLeaves(swapped, 1, 3)) === JSON.stringify(tree),
);
check("a leaf with itself is a no-op by reference", swapLeaves(tree, 2, 2) === tree);
check("an unknown id is a no-op by reference", swapLeaves(tree, 1, 99) === tree);
const single = leaf(5);
check(
  "a lone pane swapping with its next (itself) is a no-op by reference",
  swapLeaves(single, 5, nextLeafId(single, 5, 1)) === single,
);

if (failed > 0) throw new Error(`swap-leaves-verify: ${failed} check(s) failed`);
console.log("\nswap-leaves-verify: all checks passed");
