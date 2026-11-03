/**
 * Saved AI CLI sessions for the sidebar's AI Sessions section.
 *
 * Claude Code: `~/.claude/projects/<slug>/<id>.jsonl`, read and changed by
 * `modules/claude_sessions.rs` (a tail read; see there for why).
 * Codex: through Codex's own app-server (`modules/codex_sessions.rs`), because
 * it keeps two indexes beside its files that a raw delete would leave stale.
 */
import { basename, toForwardSlash } from "@/lib/path";
import { callBridge, registerBridge } from "@/modules/automation/bridge";
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
  /** Git branch it last ran on; null outside a repo. */
  branch: string | null;
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
      : "Click to resume";

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

/** Safe to type into a shell: both backends only list hex-and-dash ids. */
export const resumeCommand = (agent: SessionAgent, id: string) =>
  agent === "claude" ? `claude --resume ${id}` : `codex resume ${id}`;

/** Most sessions one `inspect sessions` returns; a heavy user has thousands. */
const MAX_LISTED_SESSIONS = 50;

registerBridge({
  agentSession: async (a: { action?: string; id?: string; title?: string; confirm?: boolean }) => {
    const { sessions } = await listAllSessions();
    const s = sessions.find((x) => x.id === a.id);
    if (!s)
      return { ok: false, error: `No saved session "${a.id}". \`inspect sessions\` lists them.` };
    if (a.action === "rename") {
      if (!a.title) return { ok: false, error: "rename needs `title`." };
      await renameSession(s, a.title);
      return { ok: true, id: s.id, title: a.title };
    }
    if (a.action !== "delete") return { ok: false, error: `Unknown action "${a.action}".` };
    // `live` is Claude only, as Codex does not report it, so a pane running that CLI
    // in that folder counts too. A pane in the folder may be on another session, and
    // refusing that is the cheap mistake.
    const panes = (await callBridge("panes")) as { agent?: string; cwd?: string }[];
    const folder = (p?: string | null) => toForwardSlash(p ?? "").toLowerCase();
    const open = panes.some((p) => p.agent === s.agent && folder(p.cwd) === folder(s.cwd));
    if (s.live || open) return { ok: false, error: "That session may be running. Close it first." };
    // The transcript goes for good, so one word from a model is not enough.
    if (a.confirm !== true)
      return { ok: false, error: `delete needs \`confirm: true\` for "${s.title}".` };
    await deleteSession(s);
    return { ok: true, deleted: s.id };
  },
  agentSessions: async (filter?: string | null) => {
    const { sessions, errors } = await listAllSessions();
    const q = filter?.trim().toLowerCase();
    const hits = q
      ? sessions.filter(
          (s) => s.title.toLowerCase().includes(q) || s.cwd?.toLowerCase().includes(q),
        )
      : sessions;
    return {
      total: hits.length,
      errors,
      sessions: hits.slice(0, MAX_LISTED_SESSIONS).map((s) => ({
        agent: s.agent,
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        branch: s.branch,
        modifiedMs: s.modifiedMs,
        live: s.live,
        resume: canResume(s) ? resumeCommand(s.agent, s.id) : null,
      })),
    };
  },
});

/**
 * Codex-style day headings for the card list: "Today", "Yesterday", "This week",
 * "This month", "Older". Calendar days in local time, not 24-hour spans, so a
 * session from 23:50 last night is Yesterday at 00:10.
 */
export function dayBucket(ms: number, now = Date.now()): string {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const day = midnight.getTime();
  if (ms >= day) return "Today";
  const d = new Date(day);
  d.setDate(d.getDate() - 1);
  if (ms >= d.getTime()) return "Yesterday";
  d.setDate(d.getDate() - 5);
  if (ms >= d.getTime()) return "This week";
  d.setDate(d.getDate() - 23);
  return ms >= d.getTime() ? "This month" : "Older";
}

export const sessionKey = (s: AgentSession) => `${s.agent}:${s.id}`;

/** A session belongs to a terminal's folder when it ran there or below it. */
const inFolder = (groupKey: string, folderKey: string) =>
  groupKey === folderKey || groupKey.startsWith(`${folderKey}/`);

export const PINNED_SECTION = "Pinned";
export const TERMINAL_SECTION = "Open in terminal";

/**
 * The cards AI Sessions shows, under their headings. All: every session of every
 * project, so search reaches them all. Working: the ones running right now.
 * Either way pins first, then the folders terminals have open (the focused one
 * leading), then the rest by day, each newest first.
 */
export function sessionSections(
  list: AgentSession[],
  opts: {
    filter: string;
    mode: "working" | "all";
    /** The focused terminal's folder, same key shape as `groupSessions`. */
    activeKey: string | null;
    /** Every local terminal's folder, including the focused one. */
    terminalKeys: Set<string>;
    /** Sessions an AI CLI pane is running, by `sessionKey`. */
    openKeys: Set<string>;
    pinnedKeys: Set<string>;
    now: number;
  },
): { label: string; cards: { s: AgentSession; folder: string; inTerminal: boolean }[] }[] {
  const { filter, mode, activeKey, terminalKeys, openKeys, pinnedKeys, now } = opts;
  const terminals = [...terminalKeys];
  const cards = groupSessions(list, filter)
    .flatMap((g) => {
      const inTerminal = terminals.some((k) => inFolder(g.key, k));
      const focused =
        activeKey !== null && terminalKeys.has(activeKey) && inFolder(g.key, activeKey);
      return g.sessions
        .filter((s) => mode === "all" || s.live || openKeys.has(sessionKey(s)))
        .map((s) => ({
          s,
          folder: g.label,
          inTerminal,
          rank: pinnedKeys.has(sessionKey(s)) ? 0 : focused ? 1 : inTerminal ? 2 : 3,
        }));
    })
    .sort((a, b) => a.rank - b.rank || b.s.modifiedMs - a.s.modifiedMs);
  const out: ReturnType<typeof sessionSections> = [];
  for (const { rank, ...c } of cards) {
    const label =
      rank === 0 ? PINNED_SECTION : rank < 3 ? TERMINAL_SECTION : dayBucket(c.s.modifiedMs, now);
    if (out.at(-1)?.label !== label) out.push({ label, cards: [] });
    out.at(-1)!.cards.push(c);
  }
  return out;
}

/** "5m", "3h", "2d" - the sidebar has room for a few characters, not a date. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
