/**
 * Saved AI CLI sessions for the sidebar's AI Sessions section.
 *
 * Claude Code: `~/.claude/projects/<slug>/<id>.jsonl`, read and changed by
 * `modules/claude_sessions.rs` (a tail read; see there for why).
 * Codex: through Codex's own app-server (`modules/codex_sessions.rs`), because
 * it keeps two indexes beside its files that a raw delete would leave stale.
 */
import { basename, toForwardSlash } from "@/lib/path";
import { invoke } from "@tauri-apps/api/core";

export type SessionAgent = "claude" | "codex";

export const SESSION_AGENTS: { id: SessionAgent; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export type AgentSession = {
  /** Which CLI owns it. Set here, not by the backend. */
  agent: SessionAgent;
  id: string;
  /** Claude: the `projects/<slug>` directory name, its backend handle. Codex: "". */
  project: string;
  /** The real working directory. Null when none was logged. */
  cwd: string | null;
  title: string;
  /** Title came from a rename, not an auto title. */
  custom: boolean;
  modifiedMs: number;
  /** Transcript bytes; Codex does not report it. */
  size: number | null;
  /** A running process holds it (Claude only). */
  live: boolean;
  /** `cwd` no longer exists, so the CLI cannot find the session to resume. */
  cwdMissing: boolean;
};

/** Both CLIs only find a session from the folder it ran in. */
export const canResume = (s: AgentSession): s is AgentSession & { cwd: string } =>
  s.cwd !== null && !s.cwdMissing;

export const resumeHint = (s: AgentSession): string =>
  !s.cwd
    ? "No folder recorded, cannot resume"
    : s.cwdMissing
      ? `Folder no longer exists: ${s.cwd}`
      : "Double-click to resume";

export type SessionGroup = { key: string; label: string; path: string; sessions: AgentSession[] };

/**
 * One folder row per working directory, newest activity first (the list arrives
 * sorted by time, so first-seen order is already that). Keyed case-insensitively
 * and slash-normalised: Windows hands back `D:\x` and `d:/x` for one folder.
 * `filter` matches the title or the folder path.
 */
export function groupSessions(list: AgentSession[], filter: string): SessionGroup[] {
  const q = filter.trim().toLowerCase();
  const groups = new Map<string, SessionGroup>();
  for (const s of list) {
    const path = s.cwd ? toForwardSlash(s.cwd) : s.project || "(unknown folder)";
    if (q && !s.title.toLowerCase().includes(q) && !path.toLowerCase().includes(q)) continue;
    const key = path.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { key, label: s.cwd ? basename(path) || path : path, path, sessions: [] };
      groups.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...groups.values()];
}

const listSessions = (agent: SessionAgent) =>
  invoke<Omit<AgentSession, "agent">[]>(
    agent === "claude" ? "claude_sessions_list" : "codex_sessions_list",
  ).then((list) => list.map((s): AgentSession => ({ ...s, agent })));

/**
 * Both CLIs' sessions in one list, newest first (what `groupSessions` expects).
 * One failing keeps the other: most users have only one of them installed.
 * `onAgent` hears each CLI as it lands: Claude is a disk read, Codex spawns an
 * app-server, so Claude rows need not wait the second Codex takes.
 */
export async function listAllSessions(
  onAgent?: (agent: SessionAgent, list: AgentSession[]) => void,
): Promise<{ sessions: AgentSession[]; errors: string[] }> {
  const results = await Promise.allSettled(
    SESSION_AGENTS.map((a) =>
      listSessions(a.id).then((list) => {
        onAgent?.(a.id, list);
        return list;
      }),
    ),
  );
  const sessions: AgentSession[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") sessions.push(...r.value);
    else errors.push(String(r.reason));
  }
  sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { sessions, errors };
}

export const renameSession = (s: AgentSession, title: string) =>
  s.agent === "claude"
    ? invoke<void>("claude_session_rename", { project: s.project, id: s.id, title })
    : invoke<void>("codex_session_rename", { id: s.id, title });

export const deleteSession = (s: AgentSession) =>
  s.agent === "claude"
    ? invoke<void>("claude_session_delete", { project: s.project, id: s.id })
    : invoke<void>("codex_session_delete", { id: s.id });

/** A session belongs to the focused terminal's folder when it ran there or below it. */
export const inFolder = (groupKey: string, folderKey: string) =>
  groupKey === folderKey || groupKey.startsWith(`${folderKey}/`);

/** Safe to type into a shell: both backends only list hex-and-dash ids. */
export const resumeCommand = (agent: SessionAgent, id: string) =>
  agent === "claude" ? `claude --resume ${id}` : `codex resume ${id}`;

/** "5m", "3h", "2d" - the sidebar has room for a few characters, not a date. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
