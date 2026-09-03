/**
 * Workspace serialization audit. Four properties, all silent when broken:
 *
 * 1. A remote (SFTP) editor leaf must never round-trip through its SESSION.
 *    `sshSessionId` is a live russh number: dead after a restart, and since the
 *    counter restarts at 1, liable to name a different host. Restoring a leaf
 *    that keeps it is wrong; restoring one WITHOUT anything remote is worse,
 *    because `useDocument` then reads - and on the next save writes - the
 *    remote path against the LOCAL disk.
 * 2. A leaf carrying a saved `sshConnectionId` must round-trip, since that id
 *    survives a restart and the pane re-resolves it to a live session. An
 *    AD-HOC one (no profile) has nothing to come back as and is still pruned;
 *    its siblings, the split shape, and the active-leaf index have to survive
 *    that prune.
 * 3. `savedActiveTabIndex` must count exactly the tabs `serializeTabs` emits.
 *    Any drift silently focuses the wrong tab on restore.
 * 4. A tab renamed from its right-click menu must round-trip. The serializer
 *    whitelists leaf fields one by one, so a new one is dropped unless it is
 *    added in BOTH directions - and the failure is a name that quietly reverts
 *    to the folder basename on the next launch. Clearing a name must remove the
 *    key rather than persist `""`, which would restore as a blank tab.
 *
 * Run: `npx tsx scripts/workspace/workspace-serialize-verify.ts`.
 *
 * serialize.ts pulls in panes.ts (type-only imports) and the zustand title
 * store, so this runs under plain node with hand-built pane trees.
 */
import {
  serializeTabs,
  savedActiveTabIndex,
  savedToTab,
  restoreTabs,
} from "../../src/modules/workspaces/serialize";
import {
  foldSshBinding,
  type SshConnectionBinding,
  type SshStatus,
} from "../../src/modules/ssh/status";
import type { SavedPaneNode, SavedTab } from "../../src/modules/workspaces/store";
import { findAiPane } from "../../src/modules/tabs/lib/tabHelpers";
import {
  editorPaneSession,
  type CanvasRect,
  type PaneLeaf,
  type PaneNode,
} from "../../src/modules/terminal/lib/panes";
import type { Tab } from "../../src/modules/tabs";

let nextId = 1;
const id = () => nextId++;

function term(leafId: number, cwd = "/w"): PaneNode {
  return { kind: "leaf", id: leafId, leafKind: "terminal", cwd };
}
function editor(leafId: number, path: string): PaneNode {
  return { kind: "leaf", id: leafId, leafKind: "editor", path, dirty: false, preview: false };
}
/** Ad-hoc remote file: opened over a session with no saved profile behind it,
 *  so there is nothing stable to restore and the leaf must be pruned. */
function adHocRemoteEditor(leafId: number, path: string): PaneNode {
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
/** Remote file opened through a SAVED connection: carries both the live session
 *  and the profile id, and must round-trip on the profile alone. */
function savedRemoteEditor(leafId: number, path: string): PaneNode {
  return {
    kind: "leaf",
    id: leafId,
    leafKind: "editor",
    path,
    dirty: false,
    preview: false,
    sshConnectionId: "c-prod",
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
    tab(split("row", [term(201), adHocRemoteEditor(202, "/srv/a.ts")], [30, 70]), 201),
  ]);
  check("remote editor pruned, sibling kept", shape(s[0]), "terminal");
  check("collapsed split drops stale sizes", sizes(s[0]), null);
  check("surviving terminal is still the active leaf", activeIdx(s[0]), 0);
}

// The active leaf itself was pruned: fall back to the first survivor, never -1.
{
  const s = serializeTabs([
    tab(split("row", [term(301), adHocRemoteEditor(302, "/srv/a.ts")]), 302),
  ]);
  check("pruned active leaf falls back to index 0", activeIdx(s[0]), 0);
}

// A pruned leaf BEFORE the active one used to shift every later index.
{
  const s = serializeTabs([
    tab(
      split("row", [adHocRemoteEditor(401, "/srv/a.ts"), term(402), term(403)], [20, 40, 40]),
      403,
    ),
  ]);
  check("index is taken over SAVED leaves, not live ones", activeIdx(s[0]), 1);
  check("both terminals survive", shape(s[0]), "split(terminal,terminal)");
  check("sizes dropped after a prune", sizes(s[0]), null);
}

// Nested: the inner split loses a child, collapses, and flattens into the outer.
{
  const inner = split("col", [adHocRemoteEditor(501, "/srv/a.ts"), term(502)]);
  const s = serializeTabs([tab(split("row", [inner, term(503)]), 503)]);
  check("nested collapse flattens", shape(s[0]), "split(terminal,terminal)");
}

// Nothing left to save: the whole tab goes, exactly like an extension-panel tab.
{
  const s = serializeTabs([tab(adHocRemoteEditor(601, "/srv/a.ts"), 601)]);
  check("remote-editor-only tab is dropped", s.length, 0);
}
{
  const s = serializeTabs([
    tab(split("row", [adHocRemoteEditor(701, "/a"), adHocRemoteEditor(702, "/b")]), 701),
  ]);
  check("all-remote split tab is dropped", s.length, 0);
}

console.log("\n[rebind] a profile-bound remote editor must round-trip, minus its session");

/** The single saved leaf of a one-leaf tab. */
function onlyLeaf(t: SavedTab): Extract<SavedPaneNode, { kind: "leaf" }> {
  const n = pane(t).paneTree;
  if (n.kind !== "leaf") throw new Error("expected a single-leaf saved tab");
  return n;
}

// The whole point of the feature: the tab survives a restart.
{
  const s = serializeTabs([tab(savedRemoteEditor(1101, "/srv/a.ts"), 1101)]);
  check("profile-bound remote editor tab is kept", s.length, 1);
  const leaf = onlyLeaf(s[0]);
  check("saved as an editor leaf", leaf.leafKind, "editor");
  check("remote path is preserved", leaf.leafKind === "editor" && leaf.path, "/srv/a.ts");
  check(
    "the reconnectable profile is persisted",
    leaf.leafKind === "editor" && leaf.sshConnectionId,
    "c-prod",
  );
  check(
    "the host label rides along for the waiting pane",
    leaf.leafKind === "editor" && leaf.sshHostLabel,
    "u@h:22",
  );
  // The one thing that must NEVER be written: a live session number is dead on
  // the next launch and the counter restarts, so it can name a different host.
  check(
    "the live session id is NOT persisted",
    "sshSessionId" in leaf ? (leaf as { sshSessionId?: number }).sshSessionId : undefined,
    undefined,
  );
}

// Restore: the leaf comes back remote-but-unbound, never as a local file.
{
  const s = serializeTabs([tab(savedRemoteEditor(1201, "/srv/a.ts"), 1201)]);
  let next = 1;
  const restored = savedToTab(s[0], () => next++);
  if (restored.kind !== "pane" || restored.paneTree.kind !== "leaf") {
    throw new Error("expected a restored single-leaf pane tab");
  }
  const leaf = restored.paneTree;
  check(
    "restored leaf keeps the profile",
    leaf.leafKind === "editor" && leaf.sshConnectionId,
    "c-prod",
  );
  check(
    "restored leaf has no session to read through yet",
    leaf.leafKind === "editor" && leaf.sshSessionId,
    undefined,
  );
  check(
    "restored leaf still knows its host",
    leaf.leafKind === "editor" && leaf.sshHostLabel,
    "u@h:22",
  );
}

// A local editor is untouched by any of this: no remote fields appear.
{
  const s = serializeTabs([tab(editor(1301, "/w/a.ts"), 1301)]);
  const leaf = onlyLeaf(s[0]);
  check(
    "local editor gains no connection id",
    leaf.leafKind === "editor" && leaf.sshConnectionId,
    undefined,
  );
}

// Mixed split: the profile-bound leaf is no longer pruned, so ratios survive.
{
  const s = serializeTabs([
    tab(split("row", [term(1401), savedRemoteEditor(1402, "/srv/a.ts")], [30, 70]), 1402),
  ]);
  check("nothing is pruned", shape(s[0]), "split(terminal,editor)");
  check("divider ratios survive", sizes(s[0]), [30, 70]);
  check("the remote editor is still the active leaf", activeIdx(s[0]), 1);
}

// Ad-hoc and profile-bound leaves in one tab: only the ad-hoc one goes.
{
  const s = serializeTabs([
    tab(
      split("row", [adHocRemoteEditor(1501, "/srv/a.ts"), savedRemoteEditor(1502, "/srv/b.ts")]),
      1502,
    ),
  ]);
  check("only the ad-hoc leaf is pruned", shape(s[0]), "editor");
  check("the surviving leaf is the active one", activeIdx(s[0]), 0);
  check(
    "and it is the profile-bound file",
    onlyLeaf(s[0]).leafKind === "editor" && (onlyLeaf(s[0]) as { path: string }).path,
    "/srv/b.ts",
  );
}

console.log("\n[bind] a restored leaf must resolve its host across every terminal for it");

// How the per-leaf statuses collapse into the one binding a remote editor pane
// reads. Getting this wrong either strands a restored file behind a Reconnect
// button that never clears, or flashes that button on every launch.
{
  const connected = (sessionId: number): SshStatus => ({
    kind: "connected",
    fingerprint: "fp",
    since: 0,
    sessionId,
  });
  const fold = (...statuses: (SshStatus | undefined)[]) =>
    statuses.reduce<SshConnectionBinding | undefined>(
      (acc, s) => foldSshBinding(acc, s),
      undefined,
    );

  check("a connected leaf binds its session", fold(connected(3)), {
    sessionId: 3,
    connecting: false,
  });
  check("no status yet reads as connecting, not as failed", fold(undefined), { connecting: true });
  check("a handshaking leaf reads as connecting", fold({ kind: "connecting", attempt: 1 }), {
    connecting: true,
  });
  check(
    "a failed leaf leaves the connection promptable",
    fold({ kind: "error", message: "x", canRetry: true }),
    { connecting: false },
  );
  check(
    "a disconnected leaf leaves the connection promptable",
    fold({ kind: "disconnected", reason: "x", canRetry: true }),
    { connecting: false },
  );
  // Order independence: whichever leaf is walked first, a live session wins and
  // is never displaced by a dead sibling on the same host.
  check("connected wins over a later failure", fold(connected(4), { kind: "idle" }), {
    sessionId: 4,
    connecting: false,
  });
  check(
    "connected wins over an earlier failure",
    fold({ kind: "error", message: "x", canRetry: true }, connected(5)),
    { sessionId: 5, connecting: false },
  );
  check("two dead leaves stay promptable", fold({ kind: "idle" }, { kind: "idle" }), {
    connecting: true,
  });
}

console.log("\n[mount] a remote pane must never open an editor without a session");

// The invariant that keeps a restored remote file off the local disk. If this
// ever returns a session (or undefined, which means "local") for an unbound
// remote leaf, the pane mounts an editor that reads and then WRITES the remote
// path against this machine.
{
  const leaf = (n: PaneNode) => n as Parameters<typeof editorPaneSession>[0];
  const local = leaf(editor(1601, "/w/a.ts"));
  const remote = leaf(savedRemoteEditor(1602, "/srv/a.ts"));
  const adHoc = leaf(adHocRemoteEditor(1603, "/srv/a.ts"));

  check(
    "a local file reads the local disk",
    editorPaneSession(local, undefined, undefined),
    undefined,
  );
  check("a local file ignores a stray session", editorPaneSession(local, 5, 5), undefined);
  check("a bound remote file reads its session", editorPaneSession(remote, 5, undefined), 5);
  check(
    "an UNBOUND remote file is blocked",
    editorPaneSession(remote, undefined, undefined),
    "blocked",
  );
  check(
    "an unbound ad-hoc remote file is blocked too",
    editorPaneSession(adHoc, undefined, undefined),
    "blocked",
  );
  // Losing the session keeps the editor (and its unsaved buffer) on the dead one.
  check("a dropped session keeps the last binding", editorPaneSession(remote, undefined, 5), 5);
  // A reconnect mints a new session; the pane must follow it, not the old one.
  check("a reconnect adopts the fresh session", editorPaneSession(remote, 9, 5), 9);
}

console.log("\n[ai] a chat pane round-trips on its session, and only one may hold it");

// An AI pane carries the SESSION id, never the conversation: the chat lives in
// the global chat store. Restore therefore has to bring the id back untouched,
// or the pane rebinds to the wrong chat - or to none.
{
  const aiLeaf = (leafId: number, sessionId: string): PaneNode => ({
    kind: "leaf",
    id: leafId,
    leafKind: "ai",
    sessionId,
  });
  const saved = serializeTabs([tab(split("row", [aiLeaf(1401, "s-abc"), term(1402)]), 1401)])[0];
  check("an ai pane is saved", shape(saved), "split(ai,terminal)");
  const back = savedToTab(saved, id);
  const first =
    back.kind === "pane" && back.paneTree.kind === "split" ? back.paneTree.children[0] : null;
  check(
    "and comes back bound to the same session",
    first?.kind === "leaf" && first.leafKind === "ai" ? first.sessionId : null,
    "s-abc",
  );
}

// The rule the whole feature rests on: a chat may appear in exactly ONE pane.
// `openAiPane` asks this before adding, and focuses the hit instead.
{
  const aiLeaf = (leafId: number, sessionId: string): PaneNode => ({
    kind: "leaf",
    id: leafId,
    leafKind: "ai",
    sessionId,
  });
  const t1 = tab(aiLeaf(1501, "s-one"), 1501);
  const t2 = tab(split("row", [term(1502), aiLeaf(1503, "s-two")]), 1502);
  const tabs = [t1, t2];
  check("finds a chat open in a single-leaf tab", findAiPane(tabs, "s-one"), {
    tabId: t1.id,
    leafId: 1501,
  });
  check("finds one nested in a split", findAiPane(tabs, "s-two"), {
    tabId: t2.id,
    leafId: 1503,
  });
  check("and reports nothing for a chat that is not open", findAiPane(tabs, "s-three"), null);
}

console.log("\n[canvas] window geometry must round-trip on the LEAF");

// A canvas rectangle lives on the leaf, so it round-trips with the pane, moves
// with it between tabs, and needs no positional side-table keyed by ids a saved
// tree does not carry. Every leaf kind may hold one, and the serializer
// whitelists leaf fields one at a time - so it is appended in ONE place per
// direction, and this is what proves both places are wired.
{
  const withRect = (n: PaneNode, r: CanvasRect): PaneNode => ({
    ...(n as PaneLeaf),
    canvasRect: r,
  });
  const a = withRect(term(1101), { x: 10, y: 20, w: 30, h: 40, z: 1 });
  const b = withRect(editor(1102, "/w/a.ts"), { x: 50, y: 5, w: 45, h: 60, z: 2 });
  const saved = serializeTabs([tab(split("row", [a, b]), 1101)])[0];
  const savedTree = pane(saved).paneTree;
  check(
    "rects persist on both leaf kinds",
    savedTree.kind === "split"
      ? savedTree.children.map((c) => (c as { canvasRect?: CanvasRect }).canvasRect?.x)
      : null,
    [10, 50],
  );
  const back = savedToTab(saved, id);
  const tree = back.kind === "pane" ? back.paneTree : null;
  check(
    "and come back on the fresh leaves",
    tree?.kind === "split" ? tree.children.map((c) => (c as PaneLeaf).canvasRect?.z) : null,
    [1, 2],
  );
}

// A pane never placed on a canvas must not grow the key: `CanvasView` seeds one
// on first render, and a persisted zero-rect would restore as a 0x0 window.
{
  const saved = serializeTabs([tab(split("row", [term(1201), term(1202)]), 1201)])[0];
  const savedTree = pane(saved).paneTree;
  check(
    "an unplaced pane saves no rect",
    savedTree.kind === "split" ? savedTree.children.map((c) => "canvasRect" in c) : null,
    [false, false],
  );
}

console.log("\n[active index] savedActiveTabIndex must match what serializeTabs emits");

// An extension panel now ROUND-TRIPS on its ids. It used to take its whole pane
// tab out of the snapshot, which meant a canvas holding a database or API
// window vanished on restart along with the terminals beside it.
{
  const extTab = tab(extPanel(801), 801);
  const paneTab = tab(term(802), 802);
  const tabs = [extTab, paneTab];
  check("extension-panel tab IS emitted", serializeTabs(tabs).length, 2);
  check("index counts the extension-panel tab", savedActiveTabIndex(tabs, paneTab.id), 1);
  check("extension panel keeps its kind", shape(serializeTabs(tabs)[0]), "extension-panel");
  const back = savedToTab(serializeTabs(tabs)[0], id);
  const leaf = back.kind === "pane" ? back.paneTree : null;
  check(
    "and comes back bound to its extension",
    leaf?.kind === "leaf" && leaf.leafKind === "extension-panel"
      ? [leaf.extensionId, leaf.panelId]
      : null,
    ["tedi.sql-explorer", "main"],
  );
}

// Same drift via a dropped remote-editor-only tab.
{
  const remoteTab = tab(adHocRemoteEditor(901, "/srv/a.ts"), 901);
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

// 4. A tab renamed from its right-click menu must survive a restart, on every
//    leaf kind that is serialised at all, and clearing it must actually clear -
//    an empty string persisted as a name would restore as a blank tab.
{
  const named = (n: PaneNode, name: string): PaneNode =>
    ({ ...(n as object), customTitle: name }) as PaneNode;
  const t = tab(
    split("row", [
      named(term(1200, "/w/api"), "backend"),
      named(editor(1201, "/w/api/main.rs"), "entrypoint"),
      named({ kind: "leaf", id: 1202, leafKind: "board" }, "docs"),
    ]),
    1200,
  );
  const savedTree = pane(serializeTabs([t])[0]).paneTree;
  const savedNames =
    savedTree.kind === "split"
      ? savedTree.children.map((c) => (c.kind === "leaf" ? c.customTitle : undefined))
      : [];
  check("a rename persists on terminal, editor and board leaves", savedNames, [
    "backend",
    "entrypoint",
    "docs",
  ]);

  const restored = savedToTab(pane(serializeTabs([t])[0]), () => id());
  const liveNames =
    restored.paneTree.kind === "split"
      ? restored.paneTree.children.map((c) => (c.kind === "leaf" ? c.customTitle : undefined))
      : [];
  check("and comes back on restore", liveNames, ["backend", "entrypoint", "docs"]);

  // An un-renamed leaf must carry no key at all, so older saved state and a
  // reset name are the same thing on disk rather than an empty string.
  const plain = pane(serializeTabs([tab(term(1203, "/w"), 1203)])[0]).paneTree;
  check(
    "an un-renamed leaf persists no name key",
    plain.kind === "leaf" && "customTitle" in plain,
    false,
  );
}

console.log("\na saved browser leaf is dropped on restore, not restored as something else");
{
  // Built by hand, not by `serializeTabs`: no live leaf kind produces a
  // `browser` leaf, which is exactly why the restore side has to recognise one
  // on its own.
  const savedBrowser = { kind: "leaf", leafKind: "browser", url: "https://x.dev" };

  // 1. A split loses only the browser child; its siblings keep their state.
  const mixed = {
    kind: "pane",
    activeLeafIndex: 0,
    paneTree: {
      kind: "split",
      dir: "row",
      children: [
        { kind: "leaf", leafKind: "terminal", cwd: "/w/api" },
        savedBrowser,
        { kind: "leaf", leafKind: "editor", path: "/w/api/main.rs" },
      ],
    },
  } as unknown as Parameters<typeof savedToTab>[0];
  const restoredMixed = savedToTab(mixed, () => id());
  const kinds =
    restoredMixed && restoredMixed.kind === "pane" && restoredMixed.paneTree.kind === "split"
      ? restoredMixed.paneTree.children.map((c) => (c.kind === "leaf" ? c.leafKind : "split"))
      : [];
  check("its siblings survive without it", kinds, ["terminal", "editor"]);

  // 2. A tab that was ONLY a browser has nothing left, so the tab goes too. A
  //    fabricated replacement would put a surface the user never asked for
  //    where their page used to be.
  const onlyBrowser = {
    kind: "pane",
    activeLeafIndex: 0,
    paneTree: savedBrowser,
  } as unknown as Parameters<typeof savedToTab>[0];
  check("a browser-only tab restores as nothing", savedToTab(onlyBrowser, () => id()), null);

  // 3. The legacy standalone "preview" tab was a browser and nothing else.
  const legacy = { kind: "preview", url: "https://x.dev" } as unknown as Parameters<
    typeof savedToTab
  >[0];
  check("the legacy preview tab goes with it", savedToTab(legacy, () => id()), null);

  // 4. `restoreTabs` is the shape every caller uses: nulls never reach them.
  const kept = restoreTabs([legacy, onlyBrowser, mixed], () => id());
  check("restoreTabs drops them for the caller", kept.length, 1);
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failures > 0) throw new Error(`workspace-serialize-verify: ${failures} FAILED`);
console.log("\nworkspace-serialize-verify: OK\n");
