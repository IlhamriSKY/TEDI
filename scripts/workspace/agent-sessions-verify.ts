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
  groupSessions,
  resumeCommand,
  resumeHint,
  type AgentSession,
} from "../../src/modules/agentSessions/api";

let failed = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL:"} ${label}`);
  if (!cond) failed++;
}

function session(over: Partial<AgentSession>): AgentSession {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    project: "D--work-app",
    cwd: "D:\\work\\app",
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

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nAll agent-sessions checks passed.");
