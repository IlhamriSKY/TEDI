/**
 * Self-check for `resolveSshContext`, which decides whether Source Control acts
 * on a REMOTE repository or the local one.
 * Run: `npx tsx scripts/ssh/ssh-context-verify.ts`.
 *
 * `fromActiveLeaf` is the flag that gates it, and getting it wrong is not
 * cosmetic: the panel stages, commits and DISCARDS against whichever repo it
 * resolved to. The bug this exists to prevent: every tab without leaves
 * (Settings, a git or AI diff, the Source Control tab itself) made
 * `activePaneTab` null, which dropped `fromActiveLeaf` to false and silently
 * moved Source Control from the remote repository the user was working in back
 * to the local one - while the SSH file tree beside it carried on showing the
 * remote. A discard aimed at the remote would have deleted local work.
 */
import { NO_SSH_CONTEXT, resolveSshContext, type SshContext } from "../../src/app/hooks/sshContext";
import type { Tab } from "../../src/modules/tabs";
import type { SshConnectionBinding, SshStatus } from "../../src/modules/ssh/status";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const connected = (sessionId: number): SshStatus => ({
  kind: "connected",
  fingerprint: "SHA256:x",
  since: 0,
  sessionId,
});

/** A pane tab holding one leaf, which is also the active one. */
const paneTab = (id: number, title: string, leaf: Record<string, unknown>): Tab =>
  ({
    id,
    kind: "pane",
    title,
    activeLeafId: leaf.id,
    paneTree: { kind: "leaf", ...leaf },
  }) as unknown as Tab;

const sshTerminal = (leafId: number, cwd?: string) => ({
  id: leafId,
  leafKind: "terminal",
  sshConnectionId: "c-prod",
  ...(cwd ? { cwd } : {}),
});
const localTerminal = (leafId: number) => ({ id: leafId, leafKind: "terminal" });
/** A tab with no leaves at all: Settings, a diff, the Source Control tab. */
const leaflessTab = (id: number, kind: string): Tab =>
  ({ id, kind, title: kind }) as unknown as Tab;

const run = (over: Partial<Parameters<typeof resolveSshContext>[0]>): SshContext =>
  resolveSshContext({
    sshStatuses: new Map(),
    focusPaneTab: null,
    tabs: [],
    sshBindingByConnection: new Map(),
    lastSessionId: null,
    ...over,
  });

const sshTab = paneTab(1, "prod", sshTerminal(10, "/srv/app"));
const localTab = paneTab(2, "local", localTerminal(20));
const statuses = new Map<number, SshStatus>([[10, connected(77)]]);

console.log("[no sessions] nothing to resolve");
check("empty statuses", run({}), NO_SSH_CONTEXT);

console.log("\n[focused SSH terminal] drives Source Control at the remote");
check(
  "session, host and cwd all resolve",
  run({ sshStatuses: statuses, focusPaneTab: sshTab, tabs: [sshTab] }),
  { sessionId: 77, hostLabel: "prod", cwd: "/srv/app", fromActiveLeaf: true },
);

console.log("\n[focused LOCAL pane] hands Source Control back to the local repo");
// Still reports the background session for the file tree, but fromActiveLeaf
// false is what keeps the panel local.
const onLocal = run({ sshStatuses: statuses, focusPaneTab: localTab, tabs: [sshTab, localTab] });
check("session still offered for the tree", onLocal.sessionId, 77);
check("but NOT as the focused one", onLocal.fromActiveLeaf, false);

console.log("\n[the bug] a tab with no leaves must not retarget Source Control");
// Each of these used to null out `activePaneTab` and silently move the panel
// off the remote repository the user was working in.
for (const kind of ["scm", "git-diff", "ai-diff", "settings"]) {
  const ctx = run({
    sshStatuses: statuses,
    // What the hook now passes: the last PANE tab, held across the leafless one.
    focusPaneTab: sshTab,
    tabs: [sshTab, leaflessTab(9, kind)],
  });
  check(`focusing a "${kind}" tab keeps the remote`, ctx.fromActiveLeaf, true);
  check(`  and the same session`, ctx.sessionId, 77);
}

console.log("\n[disconnected] a leaf that is not connected never drives the panel");
check(
  "connecting is not connected",
  run({
    sshStatuses: new Map<number, SshStatus>([[10, { kind: "connecting", attempt: 1 }]]),
    focusPaneTab: sshTab,
    tabs: [sshTab],
  }),
  NO_SSH_CONTEXT,
);

console.log("\n[remote editor focused] counts as focused on that remote");
const remoteEditorTab = paneTab(3, "file", {
  id: 30,
  leafKind: "editor",
  path: "/srv/app/src/main.rs",
  sshConnectionId: "c-prod",
  sshHostLabel: "prod-db",
});
const binding = new Map<string, SshConnectionBinding>([
  ["c-prod", { sessionId: 77, connecting: false }],
]);
check(
  "anchors on the file's directory, not the shell $PWD",
  run({
    sshStatuses: statuses,
    focusPaneTab: remoteEditorTab,
    tabs: [sshTab, remoteEditorTab],
    sshBindingByConnection: binding,
  }),
  { sessionId: 77, hostLabel: "prod-db", cwd: "/srv/app/src", fromActiveLeaf: true },
);
// A remote file left open after Disconnect must not point Source Control at a
// dead session, which would be a permanent error banner.
check(
  "a dead session is refused outright",
  run({
    sshStatuses: statuses,
    focusPaneTab: remoteEditorTab,
    tabs: [remoteEditorTab],
    sshBindingByConnection: new Map([["c-prod", { sessionId: 999, connecting: false }]]),
  }),
  NO_SSH_CONTEXT,
);
// A LOCAL file in the editor is not a remote leaf, so it correctly falls back.
const localEditorTab = paneTab(4, "local file", {
  id: 40,
  leafKind: "editor",
  path: "C:/work/main.rs",
});
check(
  "a local file returns to the local repo",
  run({ sshStatuses: statuses, focusPaneTab: localEditorTab, tabs: [sshTab, localEditorTab] })
    .fromActiveLeaf,
  false,
);

console.log("\n[fallback stickiness] two remotes must not flap when focus leaves both");
const sshTabB = paneTab(5, "staging", { id: 50, leafKind: "terminal", sshConnectionId: "c-stg" });
const two = new Map<number, SshStatus>([
  [10, connected(77)],
  [50, connected(88)],
]);
check(
  "no memory: first in tab order",
  run({ sshStatuses: two, focusPaneTab: localTab, tabs: [sshTab, sshTabB, localTab] }).sessionId,
  77,
);
check(
  "with memory: the one already served stays",
  run({
    sshStatuses: two,
    focusPaneTab: localTab,
    tabs: [sshTab, sshTabB, localTab],
    lastSessionId: 88,
  }).sessionId,
  88,
);

console.log(failed === 0 ? "\nAll ssh-context checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
