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
 * Run: `npx tsx scripts/tab-label-verify.ts`.
 */
import { buildEntries } from "../src/modules/tabs/lib/entries";
import { leafLabel } from "../src/modules/tabs/lib/tabHelpers";
import { savedToTab } from "../src/modules/workspaces/serialize";
import type { SavedPaneNode, SavedTab } from "../src/modules/workspaces/store";
import type { PaneLeaf, PaneNode } from "../src/modules/terminal/lib/panes";
import type { SshConnection } from "../src/modules/ssh/connections";
import type { Tab } from "../src/modules/tabs";

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

console.log("\na user-set name outranks every derived one");
{
  const named = [
    term("/srv/app", { customTitle: "build" }),
    { kind: "leaf", id: id(), leafKind: "terminal", sshConnectionId: "c1", customTitle: "build" },
    { kind: "leaf", id: id(), leafKind: "editor", path: "/a/main.rs", customTitle: "build" },
    { kind: "leaf", id: id(), leafKind: "browser", url: "https://x.dev", customTitle: "build" },
    {
      kind: "leaf",
      id: id(),
      leafKind: "extension-panel",
      extensionId: "e",
      panelId: "p",
      title: "SQL",
      customTitle: "build",
    },
  ] as PaneLeaf[];
  check(
    "on terminal, ssh, editor, browser and extension-panel leaves",
    named.every((l) => leafLabel(l, hosts) === "build"),
  );
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
