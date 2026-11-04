/**
 * The pure decisions behind the Workspaces section's Agents and History lists.
 *
 * Each one fails quietly: a wrong group key files one project under two folders,
 * a filter that ignores the path hides a session you can see in the tree, and a
 * resume allowed without its folder opens a tab where the CLI answers "no
 * conversation found". A resume command built from anything but an id would be
 * typed straight into a shell.
 */
import {
  agentRows,
  agentSections,
  agentTitle,
  ago,
  canResume,
  coldStatus,
  dayBucket,
  folderKeyOf,
  groupSessions,
  historySections,
  mostUrgent,
  openSessions,
  PINNED_SECTION,
  registryStatus,
  resumeCommand,
  resumeHint,
  RUNNING_SECTION,
  sessionKey,
  type AgentSession,
} from "../../src/modules/agentSessions/api";

let failed = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL:"} ${label}`);
  if (!cond) failed++;
}

function session(over: Partial<AgentSession>): AgentSession {
  return {
    agent: "claude",
    id: "00000000-0000-4000-8000-000000000001",
    project: "D--work-app",
    cwd: "D:\\work\\app",
    branch: null,
    title: "Fix login",
    custom: false,
    modifiedMs: 0,
    size: null,
    live: false,
    cwdMissing: false,
    ...over,
  };
}

console.log("\n[groupSessions] one folder, one group");
const list = [
  session({ id: "a", cwd: "D:\\work\\app", title: "Fix login" }),
  session({ id: "b", cwd: "d:/work/app", title: "Add tests" }),
  session({ id: "c", cwd: "D:\\work\\api", title: "Rate limit" }),
  session({ id: "d", cwd: null, project: "D--gone", title: "Old" }),
];
const groups = groupSessions(list, "");
ok("backslash and case variants share a group", groups.length === 3);
ok("first-seen (newest) folder comes first", groups[0].label === "app");
ok(
  "a group keeps its sessions in list order",
  groups[0].sessions.map((s) => s.id).join() === "a,b",
);
ok("no cwd falls back to the project dir name", groups[2].label === "D--gone");

console.log("\n[groupSessions] filter");
ok("matches a title, case-insensitively", groupSessions(list, "RATE").length === 1);
ok("matches the folder path", groupSessions(list, "work/api")[0]?.label === "api");
ok("blank filter is no filter", groupSessions(list, "   ").length === 3);
ok("no hit is an empty tree", groupSessions(list, "zzz").length === 0);

console.log("\n[canResume] only from the folder the session ran in");
ok("a session with its folder resumes", canResume(session({})));
ok("no folder recorded cannot resume", !canResume(session({ cwd: null })));
ok("a vanished folder cannot resume", !canResume(session({ cwdMissing: true })));
ok(
  "the hint names the missing folder",
  resumeHint(session({ cwdMissing: true })).includes("D:\\work\\app"),
);

console.log("\n[resumeCommand]");
ok("claude", resumeCommand("claude", "abc-1") === "claude --resume abc-1");
ok("codex", resumeCommand("codex", "abc-1") === "codex resume abc-1");

console.log("\n[ago]");
const now = 10 * 86_400_000;
ok("minutes", ago(now - 5 * 60_000, now) === "5m");
ok("hours under two days", ago(now - 47 * 3_600_000, now) === "47h");
ok("days after that", ago(now - 3 * 86_400_000, now) === "3d");
ok("under a minute", ago(now - 10_000, now) === "<1m");
ok("a clock skewed into the future is not negative", ago(now + 60_000, now) === "<1m");

console.log("\n[dayBucket] calendar days, not 24-hour spans");
const noon = new Date(2026, 9, 31, 12).getTime();
const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
ok("this morning is Today", dayBucket(at(31, 0), noon) === "Today");
ok("last night 23:00 is Yesterday", dayBucket(at(30, 23), noon) === "Yesterday");
ok("four days back is This week", dayBucket(at(27, 9), noon) === "This week");
ok("three weeks back is This month", dayBucket(at(10, 9), noon) === "This month");
ok("two months back is Older", dayBucket(new Date(2026, 7, 1).getTime(), noon) === "Older");

console.log("\n[historySections] everything a pane is not running");
const here = session({ id: "here", cwd: "D:/work/app", modifiedMs: at(31, 9) });
const sub = session({ id: "sub", cwd: "D:/work/app/api", modifiedMs: at(31, 8) });
const away = session({ id: "away", cwd: "D:/other", modifiedMs: at(31, 7) });
const liveAway = session({ id: "live", cwd: "D:/other", modifiedMs: at(30, 7), live: true });
const paned = session({ id: "paned", agent: "codex", cwd: "D:/third", modifiedMs: at(10, 7) });
const every = [here, sub, away, liveAway, paned];
const ids = (secs: ReturnType<typeof historySections>) =>
  secs.flatMap((sec) => sec.cards.map((c) => c.s.id)).join(",");
const base = {
  filter: "",
  folderKey: null as string | null,
  openKeys: new Set<string>(),
  pinnedKeys: new Set<string>(),
  now: noon,
};
ok(
  "lists every session newest first",
  ids(historySections(every, base)) === "here,sub,away,live,paned",
);
ok(
  "a session a pane runs is an Agents row, not history",
  ids(historySections(every, { ...base, openKeys: new Set([sessionKey(paned)]) })) ===
    "here,sub,away,live",
);
ok(
  "every card names its folder",
  historySections(every, base)
    .flatMap((sec) => sec.cards)
    .map((c) => c.folder)
    .join(",") === "app,api,other,other,third",
);
ok(
  "one project's filter takes its subfolders, not a similarly named sibling",
  ids(
    historySections([...every, session({ id: "sib", cwd: "D:/work/app2" })], {
      ...base,
      folderKey: folderKeyOf("D:\\work\\app\\"),
    }),
  ) === "here,sub",
);
const pinnedAway = historySections(every, { ...base, pinnedKeys: new Set([sessionKey(away)]) });
ok("a pin heads the list", ids(pinnedAway) === "away,here,sub,live,paned");
ok(
  "pins sit under their own heading",
  pinnedAway[0].label === PINNED_SECTION && pinnedAway[1].label === "Today",
);
ok(
  "a pin must still match the search",
  historySections([away], { ...base, filter: "zzz", pinnedKeys: new Set([sessionKey(away)]) })
    .length === 0,
);

console.log("\n[openSessions] which pane runs which session");
{
  // Three Claudes in one folder, the shape that a per-folder guess gets wrong.
  const one = session({ id: "one", modifiedMs: 3, live: true });
  const two = session({ id: "two", modifiedMs: 2, live: true });
  const three = session({ id: "three", modifiedMs: 1, live: true });
  const cdx = session({ id: "cdx", agent: "codex", modifiedMs: 1 });
  type Tool = "claude" | "codex" | "aider";
  type State = "idle" | "working" | "blocking" | "done";
  const cli = (tool: Tool, state: State, since = 0) => ({ tool, state, since });
  const pane = (leafId: number, ptyId: string | null, status: ReturnType<typeof cli> | null) => ({
    leafId,
    ptyId,
    cwd: "D:\\work\\app",
    status,
    tabId: 1,
    workspaceId: "w",
    cold: false,
    customTitle: null as string | null,
    host: null as string | null,
  });
  const reg = (id: string, status: string | null, ptyId: string | null, since = 0) => ({
    id,
    status,
    ptyId,
    since,
  });
  const panes = [pane(1, "p1", cli("claude", "working")), pane(2, "p2", cli("claude", "idle"))];
  const running = [reg("three", "idle", "p1"), reg("two", "busy", "p2"), reg("one", "busy", null)];
  const listed = [one, two, three];
  const open = openSessions(listed, panes, running);
  ok("the registry link wins over the newest", open.get("claude:three")?.leafId === 1);
  ok("each pane gets its own session", open.get("claude:two")?.leafId === 2);
  ok("a process in no pane is not open", !open.has("claude:one"));
  ok(
    "a Claude pane not yet in the registry claims nothing",
    openSessions([one], [pane(3, "p3", cli("claude", "idle"))], [reg("two", "busy", "p2")]).size ===
      0,
  );
  ok(
    "a pane the detector missed is still linked",
    openSessions([two], [pane(2, "p2", null)], running).get("claude:two")?.status === null,
  );
  const guessed = openSessions(
    [two, one],
    [pane(1, null, cli("claude", "idle"))],
    [reg("one", "idle", null)],
  );
  ok("an older daemon falls back to the newest in the folder", guessed.has("claude:one"));
  ok(
    "Codex is still matched by folder",
    openSessions([cdx], [pane(4, "p4", cli("codex", "idle"))], running).has("codex:cdx"),
  );

  console.log("\n[agentRows] one row per pane with an AI CLI in it");
  const rows = agentRows(panes, open, listed, running);
  ok(
    "a row carries the session its pane runs",
    rows.map((r) => r.session?.id).join() === "three,two,one",
  );
  ok(
    "a pane's detector beats the registry",
    rows
      .slice(0, 2)
      .map((r) => r.status.state)
      .join() === "working,idle",
  );
  const undetected = agentRows([pane(2, "p2", null)], open, listed, [reg("two", "busy", "p2", 7)]);
  ok(
    "a pane in a workspace not opened yet shows the CLI saved with it",
    coldStatus("codex", "p1", ["p1"])?.tool === "codex",
  );
  ok("not once its shell has gone", coldStatus("codex", "p1", []) === null);
  ok("Claude is left to its registry", coldStatus("claude", "p1", ["p1"]) === null);
  ok(
    "a linked pane the detector missed takes the registry's state and time",
    undetected[0]?.status.state === "working" && undetected[0].status.since === 7,
  );
  ok(
    "a plain shell is no agent",
    agentRows([pane(9, "p9", null)], new Map(), listed, []).length === 0,
  );
  const outside = rows.find((x) => x.pane.workspaceId === null);
  ok(
    "a process in no pane is a row too, from its own folder, with nowhere to go",
    rows.length === 3 && outside?.session?.id === "one" && outside.status.state === "working",
  );
  ok(
    "and its id cannot be a cold pane's or a live leaf's",
    (outside?.pane.leafId ?? 0) < -1_000_000,
  );
  const aider = agentRows([pane(5, null, cli("aider", "working"))], new Map(), [], []);
  ok("any CLI the detector knows gets a row, with no session", aider[0]?.session === null);
  ok("it reads as its CLI with nothing better", agentTitle(aider[0]) === "Aider");
  ok("the terminal's title is better", agentTitle(aider[0], "fix tests") === "fix tests");
  ok("a shell's own binary path is not", agentTitle(aider[0], "C:\\x\\pwsh.exe") === "Aider");
  ok(
    "a pane's name beats the terminal's title",
    agentTitle({ ...aider[0], pane: { ...aider[0].pane, customTitle: "mine" } }, "x") === "mine",
  );
  ok(
    "a session's title beats them all, since a worktree names its pane after the project",
    agentTitle({ ...rows[0], pane: { ...rows[0].pane, customTitle: "pokehub" } }, "x") ===
      three.title,
  );

  console.log("\n[agentSections] most urgent first");
  const r = (leafId: number, state: State, since = 0) =>
    agentRows([pane(leafId, null, cli("aider", state, since))], new Map(), [], [])[0];
  const mixed = [
    r(1, "idle"),
    r(2, "working", 1),
    r(3, "done"),
    r(4, "blocking"),
    r(5, "working", 9),
  ];
  const opts = { heldDone: null, pinnedKeys: new Set<string>(), workspaces: null };
  const secs = agentSections(mixed, opts);
  ok(
    "Needs you, Done, Working, Idle",
    secs.map((s) => s.label).join() === "Needs you,Done,Working,Idle",
  );
  ok(
    "the latest change leads its section",
    secs[2].rows.map((x) => x.pane.leafId).join() === "5,2",
  );
  ok(
    "a section with nothing in it is not listed",
    agentSections([r(1, "idle")], opts).length === 1,
  );
  const held = agentSections([r(1, "idle"), r(2, "idle")], { ...opts, heldDone: 1 });
  ok(
    "a viewed done stays under Done until focus leaves it",
    held[0].label === "Done" && held[0].rows[0].pane.leafId === 1 && held[1].label === "Idle",
  );
  ok(
    "held only covers that transition, not a new turn",
    agentSections([r(1, "working")], { ...opts, heldDone: 1 })[0].label === "Working",
  );
  const withSession = { ...r(7, "idle"), session: one };
  const pinnedRows = agentSections([r(4, "blocking"), withSession], {
    ...opts,
    pinnedKeys: new Set([sessionKey(one)]),
  });
  ok(
    "a pinned agent heads the list, whatever its state, and only once",
    pinnedRows[0].label === PINNED_SECTION &&
      pinnedRows[0].rows[0].pane.leafId === 7 &&
      pinnedRows[1].rows.every((x) => x.pane.leafId !== 7),
  );
  const elsewhere = { ...r(8, "working"), pane: { ...r(8, "working").pane, workspaceId: "w2" } };
  const grouped = agentSections([r(1, "idle"), elsewhere], {
    ...opts,
    workspaces: [
      { id: "w", name: "One" },
      { id: "w2", name: "Two" },
      { id: "w3", name: "Empty" },
    ],
  });
  ok(
    "by workspace, in their order, skipping one with no agent",
    grouped.map((s) => s.label).join() === "One,Two" && grouped[0].state === null,
  );
  ok(
    "by workspace, a process in no pane is not dropped",
    agentSections(rows, { ...opts, workspaces: [{ id: "w", name: "One" }] }).at(-1)?.label ===
      RUNNING_SECTION,
  );
  ok(
    "a folded group reports its most urgent row",
    mostUrgent([r(1, "idle"), r(2, "working"), r(3, "blocking")]) === "blocking" &&
      mostUrgent([]) === null,
  );

  console.log("\n[registryStatus] Claude's own word");
  ok("busy is working", registryStatus(reg("x", "busy", null)).state === "working");
  ok("waiting needs you", registryStatus(reg("x", "waiting", null)).state === "blocking");
  ok("no status yet is idle", registryStatus(reg("x", null, null)).state === "idle");
  ok("it keeps when that changed", registryStatus(reg("x", "busy", null, 7)).since === 7);
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nAll agent-sessions checks passed.");
