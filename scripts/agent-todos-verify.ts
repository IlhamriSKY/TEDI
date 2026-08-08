/**
 * The pure decisions behind "show the agent's todos on its board card".
 *
 * Every one of them fails SILENTLY in the app - a wrong path join, a wrong
 * project slug, a mis-replayed log or a broken identity check all still render
 * a card, just an empty or a wrong or a permanently re-rendering one. That is
 * exactly why they are checked here rather than trusted.
 */
import {
  normPath,
  projectSlug,
  replayTasks,
  sameTodos,
  todoProgress,
  type AgentTodo,
} from "../src/modules/terminal/lib/agentTodos";

let failed = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL:"} ${label}`);
  if (!cond) failed++;
}

/** One session-log line carrying a tool call, in the shape the log uses. */
function toolLine(...calls: { name: string; input: Record<string, unknown> }[]): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: calls.map((c) => ({ type: "tool_use", name: c.name, input: c.input })) },
  });
}
const create = (subject: string) => ({ name: "TaskCreate", input: { subject } });
const update = (taskId: string, input: Record<string, unknown>) => ({
  name: "TaskUpdate",
  input: { taskId, ...input },
});

console.log("\n1. normPath: the join between a TEDI terminal and a Claude session");
{
  // The session file stores a backslashed Windows path; OSC 7 reports forward
  // slashes. If these two don't meet, every card silently shows no todos.
  const fromSession = "D:\\Ilham\\Project\\laragon\\www\\TEDI - terax-ai";
  const fromOsc7 = "D:/Ilham/Project/laragon/www/TEDI - terax-ai";
  ok("backslashed and slashed forms match", normPath(fromSession) === normPath(fromOsc7));
  ok("drive-letter case is ignored", normPath("C:/Foo") === normPath("c:/foo"));
  ok("a trailing slash is ignored", normPath("/a/b/") === normPath("/a/b"));
  ok("different directories still differ", normPath("/a/b") !== normPath("/a/c"));
}

console.log("\n2. projectSlug: the only way to reach a session's log");
{
  // Both checked against the real directory names in ~/.claude/projects.
  ok(
    "a Windows path with spaces and dashes",
    projectSlug("D:\\Ilham\\Project\\laragon\\www\\TEDI - terax-ai") ===
      "D--Ilham-Project-laragon-www-TEDI---terax-ai",
  );
  ok(
    "an already-dashed folder keeps its dashes",
    projectSlug("D:\\Ilham\\Project\\laragon\\www\\SIASKA-NEW") ===
      "D--Ilham-Project-laragon-www-SIASKA-NEW",
  );
  ok("case is preserved", projectSlug("C:\\Users\\IT STAFF") === "C--Users-IT-STAFF");
}

console.log("\n3. replayTasks: rebuilding the list, including what is finished");
{
  const log = [
    toolLine(create("read the entry builder")),
    toolLine(create("wire the float bridge")),
    toolLine(update("1", { status: "completed" })),
    toolLine(update("2", { status: "in_progress" })),
  ].join("\n");
  const got = replayTasks(log);
  ok("both tasks survive", got.length === 2);
  // The whole point of reading the log: a completed task's own file is DELETED,
  // so this is the only place its text still exists.
  ok(
    "a completed task is still listed, with its text",
    got[0]?.subject === "read the entry builder" && got[0]?.status === "completed",
  );
  ok("an in-progress task keeps its status", got[1]?.status === "in_progress");
  ok("ids are assigned in creation order", got.map((t) => t.id).join(",") === "1,2");
}
{
  // Two creates in ONE message (parallel tool calls) must still number in order.
  const got = replayTasks(toolLine(create("a"), create("b"), create("c")));
  ok("parallel creates in one line number 1,2,3", got.map((t) => t.id).join(",") === "1,2,3");
}
{
  const log = [toolLine(create("a")), toolLine(update("1", { status: "deleted" }))].join("\n");
  ok("a deleted task is dropped, not shown as a ghost", replayTasks(log).length === 0);
}
{
  const log = [
    toolLine(create("old wording")),
    toolLine(update("1", { subject: "new wording" })),
  ].join("\n");
  ok("a re-worded task shows the NEW subject", replayTasks(log)[0]?.subject === "new wording");
}
{
  const log = [toolLine(create("a")), toolLine(update("99", { status: "completed" }))].join("\n");
  ok("an update for an unknown id is ignored", replayTasks(log).length === 1);
}
{
  // A real log is mostly prose and other tools; none of it may become a task.
  const noise = [
    JSON.stringify({ type: "user", content: "please add TaskCreate support" }),
    toolLine({ name: "Read", input: { file_path: "x" } }),
    "not json at all",
    "",
  ].join("\n");
  ok("prose mentioning TaskCreate creates nothing", replayTasks(noise).length === 0);
  ok("an empty log is empty, not a throw", replayTasks("").length === 0);
}
{
  const log = [toolLine(create("a")), toolLine(update("1", { status: "bogus" }))].join("\n");
  ok("an unknown status leaves the task alone", replayTasks(log)[0]?.status === "pending");
}

console.log("\n4. sameTodos: the guard that stops a 4s re-render loop");
{
  const a: AgentTodo[] = [
    { id: "1", subject: "read", status: "completed" },
    { id: "2", subject: "wire", status: "in_progress" },
  ];
  ok(
    "an identical list is the same",
    sameTodos(
      a,
      a.map((t) => ({ ...t })),
    ),
  );
  ok(
    "a STATUS change is a change",
    !sameTodos(a, [a[0], { ...a[1], status: "completed" as const }]),
  );
  ok("a SUBJECT change is a change", !sameTodos(a, [a[0], { ...a[1], subject: "rewire" }]));
  ok("a new item is a change", !sameTodos(a, [...a, { id: "3", subject: "x", status: "pending" }]));
  ok("a removed item is a change", !sameTodos(a, [a[0]]));
  ok("two empty lists are the same", sameTodos([], []));
}

console.log("\n5. todoProgress");
{
  const todos: AgentTodo[] = [
    { id: "1", subject: "a", status: "completed" },
    { id: "2", subject: "b", status: "in_progress" },
    { id: "3", subject: "c", status: "pending" },
  ];
  const p = todoProgress(todos);
  ok("counts only completed", p.done === 1 && p.total === 3);
  // The card hides itself on total 0, so this is the "show nothing" path.
  ok("an empty list is 0/0", todoProgress([]).total === 0);
  ok(
    "in_progress does NOT count as done",
    todoProgress([{ id: "1", subject: "a", status: "in_progress" }]).done === 0,
  );
}

console.log(
  failed === 0
    ? "\nagent-todos-verify: all checks passed"
    : `\nagent-todos-verify: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
