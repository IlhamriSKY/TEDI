/**
 * The todo list an AI CLI is working through, read from ITS OWN files rather
 * than scraped off the terminal.
 *
 * The chain, all of it verified against live sessions:
 *   ~/.claude/sessions/<pid>.json      -> { sessionId, cwd }
 *   ~/.claude/projects/<slug>/<sessionId>.jsonl -> the session log
 * A TEDI terminal already knows its cwd, so that is the join - no pty
 * inspection, no PID plumbing.
 *
 * Why the LOG and not `~/.claude/tasks/<sessionId>/`: that directory holds one
 * file per task, but Claude Code DELETES a task's file the moment it completes,
 * which is why every finished session's directory is empty. Reading it can only
 * ever show unfinished work. The log keeps the whole history, so a card can show
 * what was done as well as what is left.
 *
 * Why not parse the terminal: the rendered list is only what is on screen, so it
 * disappears when the panel scrolls away, and the glyphs have already changed
 * between versions. The trade is that this only works for Claude Code, which is
 * why an unrecognised tool simply shows nothing.
 *
 * These are private, undocumented internals - the location has already moved
 * once (a `todowrite` tool call, then per-task files). Every failure here is
 * silent for that reason: a card decoration must never surface an error about
 * someone else's file layout.
 */
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useEffect } from "react";
import { create } from "zustand";

/** One item of an agent's todo list. */
export type AgentTodo = {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
};

/**
 * How long an answer is trusted. Short enough that ticking an item off shows up
 * while you watch, long enough that the board - which re-renders whenever any
 * agent's status flips, several times a second - does not turn into a file-IO
 * loop.
 */
const TTL_MS = 4000;

const fetchedAt = new Map<string, number>();
const inFlight = new Set<string>();

type TodoState = { todos: Record<string, AgentTodo[]> };
const useTodoStore = create<TodoState>(() => ({ todos: {} }));

/** Windows paths arrive backslashed from the session file and forward-slashed
 *  from OSC 7, and the drive letter's case is not stable either. Exported for
 *  the verify script: this is the whole join between a terminal and a session,
 *  and getting it wrong shows up as "no todos", which looks like "no todos". */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * The `~/.claude/projects` directory name for a working directory: every
 * character that isn't alphanumeric becomes a dash, so `D:\a\b - c` is
 * `D--a-b---c`. Checked against the live sessions on this machine rather than
 * guessed - it is the only way to reach a session's log without listing every
 * project directory.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

let claudeDirPromise: Promise<string> | null = null;
function claudeDir(): Promise<string> {
  claudeDirPromise ??= homeDir().then((h) => `${normPath(h)}/.claude`);
  return claudeDirPromise;
}

type DirEntry = { name: string; kind: "file" | "dir" | "symlink" };

async function readDir(path: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("fs_read_dir", { path });
  } catch {
    return [];
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const res = await invoke<{ kind: string; content: string }>("fs_read_file", { path });
    return res.kind === "text" ? res.content : null;
  } catch {
    return null;
  }
}

type SessionFile = { sessionId?: string; cwd?: string; updatedAt?: number };

/**
 * The session Claude Code is running in `cwd`, or null.
 *
 * Two sessions can share a directory (a second window on the same project), so
 * the most recently updated one wins - that is the one whose todos are moving.
 */
async function sessionForCwd(root: string, cwd: string): Promise<string | null> {
  const want = normPath(cwd);
  const entries = await readDir(`${root}/sessions`);
  let best: { id: string; at: number } | null = null;
  for (const e of entries) {
    if (!e.name.endsWith(".json")) continue;
    const raw = await readText(`${root}/sessions/${e.name}`);
    if (raw === null) continue;
    let s: SessionFile;
    try {
      s = JSON.parse(raw) as SessionFile;
    } catch {
      continue;
    }
    if (!s.sessionId || !s.cwd || normPath(s.cwd) !== want) continue;
    const at = s.updatedAt ?? 0;
    if (!best || at > best.at) best = { id: s.sessionId, at };
  }
  return best?.id ?? null;
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * Rebuild a session's todo list by replaying its `TaskCreate` / `TaskUpdate`
 * calls, in order.
 *
 * Ids are assigned by creation order starting at 1, which is how Claude Code
 * numbers them - a `TaskUpdate` then addresses one by that id. `deleted` is a
 * real status and removes the task rather than showing it as a ghost.
 *
 * Exported and pure because everything here fails quietly: get the ordering or
 * the id assignment wrong and the card still renders, just describing work that
 * was never done in an order nobody worked in.
 */
export function replayTasks(jsonl: string): AgentTodo[] {
  const byId = new Map<string, AgentTodo>();
  let nextId = 1;
  for (const line of jsonl.split("\n")) {
    // Cheap pre-filter: a session log is mostly assistant text, and parsing
    // every line of a multi-megabyte file to find a handful of tool calls is
    // the difference between milliseconds and a stutter.
    if (!line.includes("TaskCreate") && !line.includes("TaskUpdate")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = (entry as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      const block = b as { type?: string; name?: string; input?: Record<string, unknown> };
      if (block?.type !== "tool_use" || !block.input) continue;
      // Hoisted: this runs once per tool call across a whole session log.
      const input = block.input;
      const subject = typeof input.subject === "string" ? input.subject : "";
      if (block.name === "TaskCreate") {
        const id = String(nextId++);
        if (subject) byId.set(id, { id, subject, status: "pending" });
        continue;
      }
      if (block.name !== "TaskUpdate") continue;
      const id = typeof input.taskId === "string" ? input.taskId : null;
      if (!id) continue;
      const status = input.status;
      if (status === "deleted") {
        byId.delete(id);
        continue;
      }
      const t = byId.get(id);
      if (!t) continue;
      if (subject) t.subject = subject;
      if (typeof status === "string" && STATUSES.has(status)) {
        t.status = status as AgentTodo["status"];
      }
    }
  }
  return [...byId.values()];
}

/** Fetch `cwd`'s todo list unless a fresh answer is cached or a call is out. */
export async function ensureAgentTodos(cwd: string): Promise<void> {
  const key = normPath(cwd);
  const at = fetchedAt.get(key);
  if (inFlight.has(key) || (at !== undefined && Date.now() - at < TTL_MS)) return;
  inFlight.add(key);
  try {
    const root = await claudeDir();
    const sessionId = await sessionForCwd(root, cwd);
    if (!sessionId) {
      setTodos(key, EMPTY);
      return;
    }
    // ponytail: reads the whole session log each refresh. Fine for the sizes
    // seen (a long session is a few MB and this only runs while a board is on
    // screen); if it ever shows up in a profile, the upgrade is a tail read -
    // remember the byte offset and ask Rust for only what was appended.
    const log = await readText(`${root}/projects/${projectSlug(cwd)}/${sessionId}.jsonl`);
    setTodos(key, log === null ? EMPTY : replayTasks(log));
  } catch {
    // Someone else's file layout. A card decoration never surfaces an error.
    setTodos(key, EMPTY);
  } finally {
    inFlight.delete(key);
    fetchedAt.set(key, Date.now());
  }
}

function setTodos(key: string, todos: AgentTodo[]) {
  useTodoStore.setState((s) => {
    const prev = s.todos[key];
    if (prev && sameTodos(prev, todos)) return s;
    return { todos: { ...s.todos, [key]: todos } };
  });
}

/** Identity check so an unchanged poll doesn't re-render every card. Exported
 *  for the verify script: getting this wrong is invisible until the board is
 *  re-rendering on a 4s timer forever. */
export function sameTodos(a: AgentTodo[], b: AgentTodo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status || a[i].subject !== b[i].subject) {
      return false;
    }
  }
  return true;
}

/** Progress of a todo list: how many are done, and how many there are. */
export function todoProgress(todos: AgentTodo[]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
}

/**
 * The todo list of the agent running in `cwd`, or an empty array.
 *
 * `enabled` gates on the caller having actually detected an AI CLI, so a plain
 * shell never touches the disk. Like `useGitBranch` the effect has NO dependency
 * array on purpose: the TTL makes a re-run a Map lookup, and riding the renders
 * the board already does is what keeps a ticking list current without this
 * module owning a timer that would poll forever in the background.
 */
export function useAgentTodos(cwd: string | undefined, enabled: boolean): AgentTodo[] {
  const key = cwd && enabled ? normPath(cwd) : null;
  const todos = useTodoStore((s) => (key ? s.todos[key] : undefined));
  useEffect(() => {
    if (cwd && enabled) void ensureAgentTodos(cwd);
  });
  return todos ?? EMPTY;
}

/** Stable empty array so a card with no todos keeps a stable prop identity. */
const EMPTY: AgentTodo[] = [];
