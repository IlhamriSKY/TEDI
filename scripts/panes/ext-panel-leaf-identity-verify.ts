/**
 * `updateExtensionPanelLeaf` must return the SAME node when nothing moved.
 * Run: `npx tsx scripts/panes/ext-panel-leaf-identity-verify.ts`.
 *
 * Every tree walk in `terminal/lib/panes.ts` answers with the same node by
 * reference on a no-op, and callers rely on it: `useAuxTabs` compares
 * `paneTree === t.paneTree` to decide whether anything changed, and a new tabs
 * identity re-renders the strip AND re-runs `useWorkspacePersistence`, which
 * serializes the whole tab tree and writes the workspaces file.
 *
 * This function honoured that in its leaf arm and broke it in its SPLIT arm,
 * which rebuilt `{...n, children: n.children.map(...)}` unconditionally. A tab
 * holding a single pane therefore looked correct while any tab with a split
 * answered with a fresh root for every call. That went unnoticed until a browser
 * pane started publishing its title and favicon once a second: an idle pane
 * rewrote the entire workspaces store at 1 Hz, with a base64 favicon on the leaf.
 *
 * So the split case is the one that actually needs guarding, and it is the one a
 * naive test misses.
 */
import { updateExtensionPanelLeaf, type PaneNode } from "../../src/modules/terminal/lib/panes";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

const leaf = (id: number, title?: string, icon?: string): PaneNode =>
  ({
    kind: "leaf",
    id,
    leafKind: "extension-panel",
    extensionId: "tedi.browser",
    panelId: "browser",
    ...(title !== undefined ? { title } : {}),
    ...(icon !== undefined ? { icon } : {}),
  }) as PaneNode;

const split = (...children: PaneNode[]): PaneNode => ({
  kind: "split",
  id: 900,
  dir: "row",
  children,
});

console.log("\nupdateExtensionPanelLeaf keeps identity on a no-op\n");

// --- the leaf arm, which was already correct ------------------------------
{
  const n = leaf(1, "GitHub", "data:image/png;base64,AAA");
  check(
    "a leaf: unchanged title+icon returns the same node",
    updateExtensionPanelLeaf(n, 1, { title: "GitHub", icon: "data:image/png;base64,AAA" }) === n,
  );
  check("a leaf: a different id returns the same node", updateExtensionPanelLeaf(n, 99, { title: "x" }) === n);
  check(
    "a leaf: a real title change returns a NEW node",
    updateExtensionPanelLeaf(n, 1, { title: "Example" }) !== n,
  );
  check(
    "a leaf: a real icon change returns a NEW node",
    updateExtensionPanelLeaf(n, 1, { icon: "" }) !== n,
  );
}

// --- the split arm, which is the regression this file exists for -----------
{
  const a = leaf(1, "GitHub", "data:x");
  const b = leaf(2, "Docs");
  const tree = split(a, b);

  const noop = updateExtensionPanelLeaf(tree, 1, { title: "GitHub", icon: "data:x" });
  check("a split: an unchanged patch returns the same ROOT", noop === tree);

  const missing = updateExtensionPanelLeaf(tree, 98, { title: "x" });
  check("a split: a patch that matches no leaf returns the same ROOT", missing === tree);

  const real = updateExtensionPanelLeaf(tree, 1, { title: "Example" });
  check("a split: a real change returns a NEW root", real !== tree);
  if (real.kind === "split") {
    check("a split: the untouched sibling is still the same node", real.children[1] === b);
    check("a split: the changed child is a new node", real.children[0] !== a);
  } else {
    check("a split: stayed a split", false, real.kind);
  }
}

// --- nested, because a workspace is rarely one level deep ------------------
{
  const a = leaf(1, "GitHub");
  const inner = split(a, leaf(2, "Docs"));
  const outer = split(inner, leaf(3, "Notes"));
  check(
    "nested: an unchanged patch returns the same OUTER root",
    updateExtensionPanelLeaf(outer, 1, { title: "GitHub" }) === outer,
  );
  const changed = updateExtensionPanelLeaf(outer, 1, { title: "Example" });
  check("nested: a real change returns a new outer root", changed !== outer);
}

// --- `state: null` is what the browser pane sends on every tick ------------
{
  const n = leaf(1, "GitHub");
  check(
    "state:null on a leaf that has no state is a no-op",
    updateExtensionPanelLeaf(n, 1, { state: null }) === n,
  );
  const tree = split(n, leaf(2));
  check(
    "state:null inside a split is a no-op at the root too",
    updateExtensionPanelLeaf(tree, 1, { state: null }) === tree,
  );
}

console.log(
  failed === 0
    ? "\next-panel-leaf-identity-verify: OK\n"
    : `\next-panel-leaf-identity-verify: ${failed} FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
