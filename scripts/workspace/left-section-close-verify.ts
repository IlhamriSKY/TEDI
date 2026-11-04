/**
 * Self-check for closing a section in the left column.
 * Run: `npx tsx scripts/workspace/left-section-close-verify.ts`.
 *
 * A closed section has to be able to come back, and closing one must not change what
 * the other column's header offers. Both failures are silent: a section that cannot
 * be reopened just looks gone, and Source Control and Remote used to read `onClose`
 * as "this is the right column".
 */
import { readFileSync } from "node:fs";

const saved = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => saved.set(k, v),
};

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const LS = "tedi:sidebar:left-closed";
saved.set(LS, JSON.stringify({ workspaces: true, junk: "not a flag" }));
const { reopenLeft, useSidebarPlacementStore: store } =
  await import("../../src/modules/extensions/sidebarPlacementStore");
const { useSectionDragStore } = await import("../../src/lib/sectionDrag");
const closed = () => store.getState().leftClosed;

console.log("[store] a closed section stays closed");
check("restored from the last run", closed().workspaces === true);
check("a value that is not a flag is dropped", !("junk" in closed()), closed());
store.getState().closeLeft("files");
check("closing records it", closed().files === true);
check("and persists it", JSON.parse(saved.get(LS) ?? "{}").files === true, saved.get(LS));
store.getState().openLeft("files");
check("opening clears it", !("files" in closed()));
check("and persists that", !("files" in JSON.parse(saved.get(LS) ?? "{}")), saved.get(LS));
const same = closed();
store.getState().openLeft("never-closed");
check("opening what is open changes nothing", closed() === same);

console.log("\n[store] the way back");
store.getState().closeLeft("files");
const before = useSectionDragStore.getState().revealSeq;
reopenLeft("files");
check("reopening clears it", !closed().files);
check(
  "and asks the column to show itself",
  useSectionDragStore.getState().revealSeq === before + 1,
);
store.getState().closeLeft("xsec:ext:one");
store.getState().moveRight("xsec:ext:one");
store.getState().moveLeft("xsec:ext:one");
check("a section moved here is not hidden by an old close", !closed()["xsec:ext:one"]);

console.log("\n[column] every section has its X");
const sidebar = readFileSync("src/app/components/AppSidebar.tsx", "utf8");
for (const [key, prop] of [
  ["files", "onClose"],
  ["ssh", "onClose"],
  ["scm", "onClose"],
  ["workspaces", "onClosePanel"],
]) {
  check(`${key}`, sidebar.includes(`${prop}={closeSection("${key}")}`));
}
check("an extension's section", sidebar.includes("onClose={closeSection(key)}"));
check(
  "closed sections are left out in both loops",
  sidebar.match(/if \(leftClosed\[key\]\) \{/g)?.length === 2,
);
const extSection = readFileSync(
  "src/modules/extensions/components/ExtensionSidebarSection.tsx",
  "utf8",
);
check("an extension's header draws it in the left column", /\{close \? \(/.test(extSection));
check(
  "and shows its controls for it with no actions of its own",
  extSection.includes("headerActions.length > 0 || !!close"),
);

check(
  "the last section keeps no X",
  /sections\.length > 1 \? \(\) => useSidebarPlacementStore\.getState\(\)\.closeLeft\(key\) : undefined/.test(
    sidebar,
  ),
);

console.log("\n[column] an empty column, which docking the last section away still reaches");
check(
  "stays as it is: extensions re-register at launch, so a dip to empty is not a reason to shut",
  !sidebar.includes("setPanelOpen"),
);
check("lists what can come back when opened", sidebar.includes("closedHere.map("));
check("search reopens a closed Files", sidebar.includes("<FilesClosedShortcuts />"));

console.log("\n[status bar] each kind of section has a way back");
const builtin = readFileSync(
  "src/modules/extensions/components/BuiltinSectionRightToggles.tsx",
  "utf8",
);
const extToggle = readFileSync(
  "src/modules/extensions/components/SidebarSectionRightToggles.tsx",
  "utf8",
);
const bar = readFileSync("src/modules/statusbar/StatusBar.tsx", "utf8");
check(
  "files and workspaces",
  /leftClosed\[s\.id\]/.test(builtin) && /reopenLeft\(id\)/.test(builtin),
);
check("an extension's", /reopenLeft\(closedLeftKey\)/.test(extToggle));
check("source control", bar.includes('reopenLeft("scm")'));
check("remote", bar.includes('reopenLeft("ssh")'));
check(
  "the remote shortcut too, rather than toggling a column without it",
  readFileSync("src/app/lib/shortcutHandlers.ts", "utf8").includes('reopenLeft("ssh")'),
);

console.log("\n[headers] onClose does not say which column this is");
const scm = readFileSync("src/modules/scm/components/PanelHeader.tsx", "utf8");
const ssh = readFileSync("src/modules/ssh/SshFileExplorer.tsx", "utf8");
for (const [name, src, pref] of [
  ["source control", scm, "sourceControlInRightPanel"],
  ["remote", ssh, "sshInRightPanel"],
] as const) {
  check(`${name} asks the placement`, src.includes(`(s) => s.${pref}`));
  check(`${name} offers "move right" from the left`, src.includes("!inRightColumn ?"));
  check(
    `${name} offers "move left" only from the right`,
    src.includes("onClose && inRightColumn ?"),
  );
  check(`${name} no longer reads onClose as a side`, !/!onClose\b/.test(src));
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
