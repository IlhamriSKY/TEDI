/**
 * The pure decisions behind the sidebar's AI Sessions tree.
 *
 * Each one fails quietly: a wrong group key files one project under two folders,
 * a filter that ignores the path hides a session you can see in the tree, and a
 * resume allowed without its folder opens a tab where the CLI answers "no
 * conversation found". A resume command built from anything but an id would be
 * typed straight into a shell.
 */
import {
  ago,
  canResume,
  dayBucket,
  groupSessions,
  resumeCommand,
  resumeHint,
  sessionKey,
  sessionSections,
  TERMINAL_SECTION,
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
ok("a clock skewed into the future reads 0m, not negative", ago(now + 60_000, now) === "0m");

console.log("\n[dayBucket] calendar days, not 24-hour spans");
const noon = new Date(2026, 9, 31, 12).getTime();
const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
ok("this morning is Today", dayBucket(at(31, 0), noon) === "Today");
ok("last night 23:00 is Yesterday", dayBucket(at(30, 23), noon) === "Yesterday");
ok("four days back is This week", dayBucket(at(27, 9), noon) === "This week");
ok("three weeks back is This month", dayBucket(at(10, 9), noon) === "This month");
ok("two months back is Older", dayBucket(new Date(2026, 7, 1).getTime(), noon) === "Older");

console.log("\n[sessionSections] Working and All modes, and pins");
const here = session({ id: "here", cwd: "D:/work/app", modifiedMs: at(31, 9) });
const sub = session({ id: "sub", cwd: "D:/work/app/api", modifiedMs: at(31, 8) });
const away = session({ id: "away", cwd: "D:/other", modifiedMs: at(31, 7) });
const liveAway = session({ id: "live", cwd: "D:/other", modifiedMs: at(30, 7), live: true });
const paned = session({ id: "paned", agent: "codex", cwd: "D:/third", modifiedMs: at(10, 7) });
const every = [here, sub, away, liveAway, paned];
const ids = (secs: ReturnType<typeof sessionSections>) =>
  secs.flatMap((sec) => sec.cards.map((c) => c.s.id)).join(",");
const base = {
  filter: "",
  mode: "all" as "all" | "working",
  activeKey: "d:/work/app" as string | null,
  terminalKeys: new Set(["d:/work/app"]),
  openKeys: new Set<string>(),
  pinnedKeys: new Set<string>(),
  now: noon,
};
const noTerminals = { ...base, activeKey: null, terminalKeys: new Set<string>() };
ok(
  "All lists every folder, the terminal's own on top",
  ids(sessionSections(every, base)) === "here,sub,away,live,paned",
);
ok(
  "All needs no terminal, and then is newest first",
  ids(sessionSections([paned, away, here], noTerminals)) === "here,away,paned",
);
{
  const secs = sessionSections(every, base);
  ok(
    "a terminal's folder and those under it get their own heading",
    secs[0].label === TERMINAL_SECTION && secs[0].cards.length === 2 && secs[1].label === "Today",
  );
  ok(
    "the indicator follows the folder, and every card names one",
    secs
      .flatMap((sec) => sec.cards)
      .map((c) => `${c.folder}:${c.inTerminal}`)
      .join(",") === "app:true,api:true,other:false,other:false,third:false",
  );
  const two = sessionSections(every, {
    ...base,
    activeKey: "d:/third",
    terminalKeys: new Set(["d:/work/app", "d:/third"]),
  });
  ok(
    "the focused terminal's folder leads the other terminals' folders",
    ids(two) === "paned,here,sub,away,live" && two[0].cards.length === 3,
  );
  ok(
    "a closed terminal's remembered folder no longer counts",
    sessionSections([here], { ...base, terminalKeys: new Set() })[0].label !== TERMINAL_SECTION,
  );
}
const working = sessionSections(every, {
  ...base,
  mode: "working",
  openKeys: new Set([sessionKey(paned)]),
});
ok("Working lists live and paned sessions from any folder", ids(working) === "live,paned");
ok(
  "Working marks a running session outside any terminal's folder",
  working.flatMap((sec) => sec.cards).every((c) => !c.inTerminal),
);
ok(
  "Working with nothing running is empty",
  sessionSections([here, away], { ...base, mode: "working" }).length === 0,
);
const pinnedAway = sessionSections(every, { ...base, pinnedKeys: new Set([sessionKey(away)]) });
ok("a pin heads All", ids(pinnedAway) === "away,here,sub,live,paned");
ok(
  "pins sit under their own heading",
  pinnedAway[0].label === "Pinned" && pinnedAway[1].label === TERMINAL_SECTION,
);
ok(
  "Working does not show an idle pin",
  sessionSections([away], { ...base, mode: "working", pinnedKeys: new Set([sessionKey(away)]) })
    .length === 0,
);
ok(
  "a pin must still match the search",
  sessionSections([away], { ...base, filter: "zzz", pinnedKeys: new Set([sessionKey(away)]) })
    .length === 0,
);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nAll agent-sessions checks passed.");
