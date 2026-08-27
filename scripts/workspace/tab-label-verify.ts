/**
 * Tab / pane / Workspaces-panel label parity. Three properties, all of which
 * fail silently as "the same tab is called two different things in two places":
 *
 * 1. ONE derivation. `leafLabel` is the only place a leaf's name is computed,
 *    and the tab strip (`buildEntries`), the pane header, `tab.title` and the
 *    Workspaces panel all read it. This used to be four separate copies, and a
 *    rename would move the tab strip while the pane header and the workspace
 *    list kept showing the folder basename.
 * 2. A user-set `customTitle` outranks every derived name, on every leaf kind.
 *    An SSH leaf resolves to `ssh:<name>` off the saved connection, falling back
 *    to the host and then to a bare "ssh" - the panel showed a cwd basename here
 *    while the strip showed the host, for the same pane.
 * 3. DEPTH-FIRST ORDER. A workspace never opened this session has no live leaf
 *    ids, so the panel pairs its rows with the persisted OSC titles BY POSITION.
 *    That holds only while `savedToTab` + `buildEntries` emit leaves in the same
 *    depth-first, left-to-right order a plain walk of the snapshot does. Nothing
 *    else pins that down, and a reordering would mislabel every split pane.
 *
 * Run: `npx tsx scripts/workspace/tab-label-verify.ts`.
 */
import { buildEntries } from "../../src/modules/tabs/lib/entries";
import { leafLabel, leafRenameSeed } from "../../src/modules/tabs/lib/tabHelpers";
import { savedToTab } from "../../src/modules/workspaces/serialize";
import type { SavedPaneNode, SavedTab } from "../../src/modules/workspaces/store";
import type { PaneLeaf, PaneNode } from "../../src/modules/terminal/lib/panes";
import type { SshConnection } from "../../src/modules/ssh/connections";
import type { Tab } from "../../src/modules/tabs";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok   " : "FAIL "} ${label}`);
  if (!cond) failures++;
}

const HOST: SshConnection = {
  id: "c1",
  name: "prod-db",
  host: "10.0.0.9",
  port: 22,
  user: "root",
  authMode: "password",
  hasPassword: true,
  hasPrivateKey: false,
  hasKeyPassphrase: false,
};
const hosts = new Map<string, SshConnection>([[HOST.id, HOST]]);

let nextId = 1;
const id = () => nextId++;

function term(cwd?: string, extra: Partial<PaneLeaf> = {}): PaneNode {
  return { kind: "leaf", id: id(), leafKind: "terminal", cwd, ...extra } as PaneNode;
}
function paneTab(tree: PaneNode, activeLeafId: number): Tab {
  return { id: id(), kind: "pane", title: "", paneTree: tree, activeLeafId } as Tab;
}

console.log("\nleaf labels");
{
  const ssh = term(undefined, { sshConnectionId: "c1" }) as PaneLeaf;
  check("an SSH leaf reads ssh:<connection name>", leafLabel(ssh, hosts) === "ssh:prod-db");

  const unnamed = new Map<string, SshConnection>([["c1", { ...HOST, name: "  " }]]);
  check("an unnamed connection falls back to the host", leafLabel(ssh, unnamed) === "ssh:10.0.0.9");
  check("a deleted connection reads a bare ssh", leafLabel(ssh, new Map()) === "ssh");
  // `tab.title` is recomputed before the host map has loaded, so no map at all
  // has to behave exactly like an unresolvable one rather than throw.
  check("no host map at all is the same as unresolved", leafLabel(ssh) === "ssh");

  check("a terminal reads its cwd basename", leafLabel(term("/srv/app") as PaneLeaf) === "app");
  check("a cwd-less terminal reads shell", leafLabel(term() as PaneLeaf) === "shell");
  check(
    "the owning tab's cwd is the fallback",
    leafLabel(term() as PaneLeaf, hosts, "/srv/fallback") === "fallback",
  );

  const editor = { kind: "leaf", id: id(), leafKind: "editor", path: "/a/b/main.rs" } as PaneLeaf;
  check("an editor reads its file name", leafLabel(editor) === "main.rs");
  const browser = {
    kind: "leaf",
    id: id(),
    leafKind: "browser",
    url: "https://x.dev/p",
  } as PaneLeaf;
  check("a browser falls back to the url host", leafLabel(browser) === "x.dev");
}

const extLeaf = (title: string | undefined, customTitle?: string): PaneLeaf =>
  ({
    kind: "leaf",
    id: id(),
    leafKind: "extension-panel",
    extensionId: "e",
    panelId: "p",
    ...(title === undefined ? {} : { title }),
    ...(customTitle ? { customTitle } : {}),
  }) as PaneLeaf;

console.log("\na user-set name outranks every derived one");
{
  const named = [
    term("/srv/app", { customTitle: "build" }),
    { kind: "leaf", id: id(), leafKind: "editor", path: "/a/main.rs", customTitle: "build" },
    { kind: "leaf", id: id(), leafKind: "browser", url: "https://x.dev", customTitle: "build" },
  ] as PaneLeaf[];
  check(
    "on terminal, editor and browser leaves",
    named.every((l) => leafLabel(l, hosts) === "build"),
  );
}

console.log("\nbut the KIND tag is not the user's to rename away");
{
  const ssh = {
    kind: "leaf",
    id: id(),
    leafKind: "terminal",
    sshConnectionId: "c1",
    customTitle: "build",
  } as PaneLeaf;
  check("a renamed SSH pane keeps its ssh tag", leafLabel(ssh, hosts) === "ssh:build");
  check("even with no host map to resolve", leafLabel(ssh) === "ssh:build");

  check(
    "a renamed SQL Explorer panel still says SQL",
    leafLabel(extLeaf("SQL Explorer · sakila", "build")) === "SQL:build",
  );
  check(
    "a renamed API Client panel still says API",
    leafLabel(extLeaf("API Client · checkout", "build")) === "API:build",
  );
  check(
    "a detail-less extension title still yields a tag",
    leafLabel(extLeaf("SQL Explorer", "build")) === "SQL:build",
  );
  // A panel that has not published a title yet has nothing to derive a tag
  // from. It must not invent one, and it must not throw.
  check(
    "a title-less panel is renamed bare",
    leafLabel(extLeaf(undefined, "build")) === "build",
  );
  check("and un-renamed panels are untouched", leafLabel(extLeaf("SQL Explorer · sakila")) === "SQL Explorer · sakila");
}

console.log("\nthe rename field is seeded WITHOUT the tag");
{
  const ssh = term(undefined, { sshConnectionId: "c1" }) as PaneLeaf;
  // The bug this pins: both rename surfaces seeded from `label`, so keeping the
  // name and pressing Enter stored "ssh:prod-db" and the tab read ssh:ssh:...
  check("an un-renamed SSH pane seeds the host name only", leafRenameSeed(ssh, hosts) === "prod-db");
  check(
    "and re-committing it unchanged is idempotent",
    leafLabel({ ...ssh, customTitle: leafRenameSeed(ssh, hosts) } as PaneLeaf, hosts) ===
      leafLabel(ssh, hosts),
  );
  check(
    "a renamed one seeds the name the user typed",
    leafRenameSeed({ ...ssh, customTitle: "build" } as PaneLeaf, hosts) === "build",
  );
  check(
    "an extension panel seeds only the detail after the separator",
    leafRenameSeed(extLeaf("SQL Explorer · sakila")) === "sakila",
  );
  check(
    "a detail-less panel seeds empty rather than its own tag",
    leafRenameSeed(extLeaf("API Client")) === "",
  );
  check(
    "an untagged leaf seeds its plain label",
    leafRenameSeed(term("/srv/app") as PaneLeaf) === "app",
  );
  // A deleted connection reads as a bare "ssh": all tag, no name. Seeding that
  // back would let a plain Enter commit the tag itself as the name.
  check("a bare ssh leaf seeds empty, not its own tag", leafRenameSeed(ssh, new Map()) === "");
}

console.log("\nthe tab strip reads the same function");
{
  const leaf = term("/srv/app", { customTitle: "build" }) as PaneLeaf;
  const sshLeaf = term(undefined, { sshConnectionId: "c1" }) as PaneLeaf;
  const tab = paneTab({ kind: "split", id: id(), dir: "row", children: [leaf, sshLeaf] }, leaf.id);
  const entries = buildEntries([tab], hosts);
  check(
    "buildEntries labels match leafLabel for the same leaves",
    entries.map((e) => e.label).join("|") ===
      [leafLabel(leaf, hosts), leafLabel(sshLeaf, hosts)].join("|"),
  );
  check(
    "and the renamed one is flagged renamed",
    entries[0].kind === "pane-leaf" && entries[0].renamed === true,
  );
  check(
    "a terminal entry carries its cwd for the hover card",
    entries[0].kind === "pane-leaf" && entries[0].cwd === "/srv/app",
  );
}

console.log("\na cold workspace keeps depth-first order");
{
  // Nested splits, so a breadth-first or right-to-left walk would reorder them.
  const savedTerm = (cwd: string): SavedPaneNode => ({ kind: "leaf", leafKind: "terminal", cwd });
  const saved: SavedTab[] = [
    {
      kind: "pane",
      activeLeafIndex: 0,
      paneTree: {
        kind: "split",
        dir: "row",
        children: [
          savedTerm("/w/one"),
          {
            kind: "split",
            dir: "col",
            children: [savedTerm("/w/two"), savedTerm("/w/three")],
          },
          savedTerm("/w/four"),
        ],
      },
    },
    { kind: "pane", activeLeafIndex: 0, paneTree: savedTerm("/w/five") },
  ];

  // What the panel's `savedTitles` walk sees, in the order it sees it.
  const walked: string[] = [];
  const walk = (n: SavedPaneNode) => {
    if (n.kind === "split") return void n.children.forEach(walk);
    walked.push(n.leafKind === "terminal" ? (n.cwd ?? "") : "");
  };
  for (const t of saved) if (t.kind === "pane") walk(t.paneTree);

  let neg = -1;
  const entries = buildEntries(
    saved.map((t) => savedToTab(t, () => neg--)),
    hosts,
  );
  check(
    "rehydrated entries line up with a plain walk of the snapshot",
    entries.map((e) => e.label).join("|") === walked.map((cwd) => cwd.split("/").pop()).join("|"),
  );
  check(
    "and every id stays out of the live (positive) space",
    neg < 0 && entries.every((e) => e.tabId < 0),
  );
}

console.log(
  failures === 0 ? "\ntab-label-verify: OK\n" : `\ntab-label-verify: ${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
