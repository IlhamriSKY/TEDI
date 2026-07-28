/**
 * Workspace serialization audit. Two properties, both silent when broken:
 *
 * 1. A remote (SFTP) editor leaf must NOT round-trip. `sshSessionId` is a live
 *    russh session number, so restoring the leaf without it makes `useDocument`
 *    read, and on the next save WRITE, the remote path against the LOCAL disk.
 *    The leaf is pruned; its siblings, the split shape, and the active-leaf
 *    index all have to survive that prune.
 * 2. `savedActiveTabIndex` must count exactly the tabs `serializeTabs` emits.
 *    Any drift silently focuses the wrong tab on restore.
 *
 * Run: `npx tsx scripts/workspace-serialize-verify.ts`.
 *
 * serialize.ts pulls in panes.ts (type-only imports) and the zustand title
 * store, so this runs under plain node with hand-built pane trees.
 */
import { serializeTabs, savedActiveTabIndex } from "../src/modules/workspaces/serialize";
import type { SavedPaneNode, SavedTab } from "../src/modules/workspaces/store";
import type { PaneNode } from "../src/modules/terminal/lib/panes";
import type { Tab } from "../src/modules/tabs";

let nextId = 1;
const id = () => nextId++;

function term(leafId: number, cwd = "/w"): PaneNode {
  return { kind: "leaf", id: leafId, leafKind: "terminal", cwd };
}
function editor(leafId: number, path: string): PaneNode {
  return { kind: "leaf", id: leafId, leafKind: "editor", path, dirty: false, preview: false };
}
function remoteEditor(leafId: number, path: string): PaneNode {
  return {
    kind: "leaf",
    id: leafId,
    leafKind: "editor",
    path,
    dirty: false,
    preview: false,
    sshSessionId: 7,
    sshHostLabel: "u@h:22",
  };
}
function extPanel(leafId: number): PaneNode {
  return {
    kind: "leaf",
    id: leafId,
    leafKind: "extension-panel",
    extensionId: "tedi.sql-explorer",
    panelId: "main",
  };
}
function split(dir: "row" | "col", children: PaneNode[], sizes?: number[]): PaneNode {
  return { kind: "split", id: id(), dir, children, ...(sizes ? { sizes } : {}) };
}
function tab(paneTree: PaneNode, activeLeafId: number, tabId = id()): Tab {
  return { id: tabId, kind: "pane", title: "t", paneTree, activeLeafId };
}

/** Narrow to the pane variant. `SavedTab` still carries the legacy `preview`
 *  kind, which `serializeTabs` never emits. */
function pane(t: SavedTab): { paneTree: SavedPaneNode; activeLeafIndex: number } {
  if (t.kind !== "pane") throw new Error(`expected a saved pane tab, got "${t.kind}"`);
  return t;
}

/** Leaf kinds of a saved tree, in order. `split(...)` for a split node. */
function shape(t: SavedTab): string {
  const walk = (n: SavedPaneNode): string =>
    n.kind === "leaf" ? n.leafKind : `split(${n.children.map(walk).join(",")})`;
  return walk(pane(t).paneTree);
}

/** Persisted divider ratios, or null when the root is a leaf / carries none. */
function sizes(t: SavedTab): number[] | null {
  const n = pane(t).paneTree;
  return n.kind === "split" ? (n.sizes ?? null) : null;
}

const activeIdx = (t: SavedTab): number => pane(t).activeLeafIndex;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
    failures++;
  }
}

console.log("\n[prune] a remote editor leaf must not round-trip");

// Nothing to prune: the ordinary case must come through unchanged.
{
  const s = serializeTabs([tab(split("row", [term(101), editor(102, "/w/a.ts")], [30, 70]), 102)]);
  check("local editor + terminal: both saved", shape(s[0]), "split(terminal,editor)");
  check("local editor + terminal: divider ratios preserved", sizes(s[0]), [30, 70]);
  check("local editor + terminal: active index", activeIdx(s[0]), 1);
}

// The defect: the remote leaf is dropped and the split collapses to its sibling.
{
  const s = serializeTabs([
    tab(split("row", [term(201), remoteEditor(202, "/srv/a.ts")], [30, 70]), 201),
  ]);
  check("remote editor pruned, sibling kept", shape(s[0]), "terminal");
  check("collapsed split drops stale sizes", sizes(s[0]), null);
  check("surviving terminal is still the active leaf", activeIdx(s[0]), 0);
}

// The active leaf itself was pruned: fall back to the first survivor, never -1.
{
  const s = serializeTabs([tab(split("row", [term(301), remoteEditor(302, "/srv/a.ts")]), 302)]);
  check("pruned active leaf falls back to index 0", activeIdx(s[0]), 0);
}

// A pruned leaf BEFORE the active one used to shift every later index.
{
  const s = serializeTabs([
    tab(split("row", [remoteEditor(401, "/srv/a.ts"), term(402), term(403)], [20, 40, 40]), 403),
  ]);
  check("index is taken over SAVED leaves, not live ones", activeIdx(s[0]), 1);
  check("both terminals survive", shape(s[0]), "split(terminal,terminal)");
  check("sizes dropped after a prune", sizes(s[0]), null);
}

// Nested: the inner split loses a child, collapses, and flattens into the outer.
{
  const inner = split("col", [remoteEditor(501, "/srv/a.ts"), term(502)]);
  const s = serializeTabs([tab(split("row", [inner, term(503)]), 503)]);
  check("nested collapse flattens", shape(s[0]), "split(terminal,terminal)");
}

// Nothing left to save: the whole tab goes, exactly like an extension-panel tab.
{
  const s = serializeTabs([tab(remoteEditor(601, "/srv/a.ts"), 601)]);
  check("remote-editor-only tab is dropped", s.length, 0);
}
{
  const s = serializeTabs([
    tab(split("row", [remoteEditor(701, "/a"), remoteEditor(702, "/b")]), 701),
  ]);
  check("all-remote split tab is dropped", s.length, 0);
}

console.log("\n[active index] savedActiveTabIndex must match what serializeTabs emits");

// The pre-existing drift: an extension-panel tab was counted but never emitted.
{
  const extTab = tab(extPanel(801), 801);
  const paneTab = tab(term(802), 802);
  const tabs = [extTab, paneTab];
  check("extension-panel tab is not emitted", serializeTabs(tabs).length, 1);
  check("index skips the dropped extension-panel tab", savedActiveTabIndex(tabs, paneTab.id), 0);
}

// Same drift via a dropped remote-editor-only tab.
{
  const remoteTab = tab(remoteEditor(901, "/srv/a.ts"), 901);
  const paneTab = tab(term(902), 902);
  const tabs = [remoteTab, paneTab];
  check("only the pane tab is emitted", serializeTabs(tabs).length, 1);
  check("index skips the dropped remote-editor tab", savedActiveTabIndex(tabs, paneTab.id), 0);
}

// Session-only tab kinds were already skipped; guard against a regression.
{
  const scmTab = { id: id(), kind: "scm", title: "scm" } as unknown as Tab;
  const paneTab = tab(term(1002), 1002);
  const tabs = [scmTab, paneTab];
  check("scm tab is not emitted", serializeTabs(tabs).length, 1);
  check("index skips a session-only scm tab", savedActiveTabIndex(tabs, paneTab.id), 0);
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failures > 0) throw new Error(`workspace-serialize-verify: ${failures} FAILED`);
console.log("\nworkspace-serialize-verify: OK\n");
