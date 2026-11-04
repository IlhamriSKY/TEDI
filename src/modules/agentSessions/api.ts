/**
 * AI CLI sessions for the Workspaces section's Agents and History lists.
 *
 * Claude Code: `~/.claude/projects/<slug>/<id>.jsonl`, read and changed by
 * `modules/claude_sessions.rs` (a tail read; see there for why).
 * Codex: through Codex's own app-server (`modules/codex_sessions.rs`), because
 * it keeps two indexes beside its files that a raw delete would leave stale.
 */
import { basename, toForwardSlash } from "@/lib/path";
import { callBridge, registerBridge } from "@/modules/automation/bridge";
import {
  toolDisplayName,
  type AiCliKind,
  type AiCliState,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import { listDaemonSessions } from "@/modules/terminal/lib/pty-bridge";
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

export const listSessions = (agent: SessionAgent) =>
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

/** A session a `claude` process holds, and the pane it runs in when one does. */
export type RunningSession = {
  id: string;
  status: string | null;
  /** When `status` last changed, in ms. 0 before the session's first turn. */
  since: number;
  ptyId: string | null;
};

/**
 * Claude's own registry, each process traced to its pane: a pane's shell pid
 * among the process's parents. `dir` is the folder to watch for the next change,
 * `alivePtys` the daemon sessions whose shell is still up.
 */
export async function listRunningSessions(): Promise<{
  dir: string;
  running: RunningSession[];
  alivePtys: string[];
}> {
  const [{ dir, running }, shells] = await Promise.all([
    invoke<{
      dir: string;
      running: {
        id: string;
        status: string | null;
        statusUpdatedAt: number | null;
        ancestors: number[];
      }[];
    }>("claude_sessions_running"),
    listDaemonSessions().catch(() => []),
  ]);
  const paneOf = new Map(shells.filter((s) => s.alive && s.pid).map((s) => [s.pid, s.id]));
  return {
    dir,
    alivePtys: shells.filter((s) => s.alive).map((s) => s.id),
    running: running.map(({ id, status, statusUpdatedAt, ancestors }) => ({
      id,
      status,
      since: statusUpdatedAt ?? 0,
      ptyId: ancestors.map((pid) => paneOf.get(pid)).find(Boolean) ?? null,
    })),
  };
}

/** A session's state as Claude reports it, for one no local pane is watching. */
export function registryStatus(r: RunningSession): NonNullable<AiCliStatus> {
  const state = r.status === "busy" ? "working" : r.status === "waiting" ? "blocking" : "idle";
  return { tool: "claude", state, since: r.since };
}

/**
 * A pane in a workspace not opened since launch has no detector yet, so all it has
 * is the CLI saved with it, and only while its shell is still alive. Claude is left
 * to its registry, which knows exactly.
 * shortcut: a CLI quit while its workspace is cold reads as idle until the workspace
 * is opened; ask the daemon for the shell's children if that matters.
 */
export function coldStatus(
  tool: AiCliKind | undefined,
  ptyId: string | null,
  alivePtys: string[],
): NonNullable<AiCliStatus> | null {
  if (!tool || tool === "claude" || !ptyId || !alivePtys.includes(ptyId)) return null;
  return { tool, state: "idle", since: 0 };
}

/** A local terminal pane, with what the pane detector says runs in it. */
export type SessionPane = {
  leafId: number;
  ptyId: string | null;
  cwd: string | null;
  status: NonNullable<AiCliStatus> | null;
};
export type OpenSession = { leafId: number; status: NonNullable<AiCliStatus> | null };

/**
 * Which listed sessions a pane is running. Claude's are known exactly, from its
 * registry. Everything else is a guess per folder and CLI: Codex never reports
 * its process, and neither does a daemon older than `SessionInfo.pid`, so the N
 * panes claim N sessions, `live` ones first, then the most recently written.
 * shortcut: the guess is wrong when two panes run Codex in one folder and one is
 * a fresh session not yet listed; ask Codex's app-server for its threads if that
 * matters.
 */
export function openSessions(
  sessions: AgentSession[],
  panes: SessionPane[],
  running: RunningSession[],
): Map<string, OpenSession> {
  const out = new Map<string, OpenSession>();
  const claimed = new Set<number>();
  for (const r of running) {
    const p = r.ptyId ? panes.find((x) => x.ptyId === r.ptyId) : undefined;
    if (!p) continue;
    out.set(`claude:${r.id}`, { leafId: p.leafId, status: p.status });
    claimed.add(p.leafId);
  }
  const exact = running.some((r) => r.ptyId);
  const elsewhere = new Set(running.filter((r) => r.ptyId).map((r) => r.id));
  for (const p of panes) {
    const tool = p.status?.tool;
    if (!p.cwd || claimed.has(p.leafId) || (tool !== "claude" && tool !== "codex")) continue;
    // With the registry answering, a Claude pane it does not list has not registered yet.
    if (tool === "claude" && exact) continue;
    const folder = folderKeyOf(p.cwd);
    const pick = sessions
      .filter(
        (s) =>
          s.agent === tool &&
          s.cwd !== null &&
          folderKeyOf(s.cwd) === folder &&
          !out.has(sessionKey(s)) &&
          !elsewhere.has(s.id),
      )
      .sort((a, b) => Number(b.live) - Number(a.live) || b.modifiedMs - a.modifiedMs)[0];
    if (pick) out.set(sessionKey(pick), { leafId: p.leafId, status: p.status });
  }
  return out;
}

/** A pane the Agents list can show, in any workspace. */
export type AgentPane = SessionPane & {
  tabId: number;
  /** Null for a process running outside any pane here, with nothing to go to. */
  workspaceId: string | null;
  /** Its workspace was not opened this session, so the leaf id is throwaway and
   *  going there can only switch workspace. */
  cold: boolean;
  /** The name given to this pane. */
  customTitle: string | null;
  /** Where a remote pane runs. */
  host: string | null;
};
export type AgentRow = {
  pane: AgentPane;
  session: AgentSession | null;
  status: NonNullable<AiCliStatus>;
};

/**
 * One row per pane with an AI CLI in it. Led by the pane, not the session: any of
 * the CLIs the detector knows belongs here, and a fresh session with no
 * transcript yet still has a pane to jump to. The detector, which drives the
 * pane's own badge, wins over the registry. A Claude process in no pane gets a row
 * too, so the list holds every agent running on this machine, in whatever folder.
 */
export function agentRows(
  panes: AgentPane[],
  open: Map<string, OpenSession>,
  sessions: AgentSession[],
  running: RunningSession[],
): AgentRow[] {
  const keyOfLeaf = new Map([...open].map(([key, o]) => [o.leafId, key]));
  const listed = new Map(sessions.map((s) => [sessionKey(s), s]));
  const registry = new Map(running.map((r) => [`claude:${r.id}`, r]));
  const out: AgentRow[] = [];
  for (const pane of panes) {
    const key = keyOfLeaf.get(pane.leafId);
    const reg = key ? registry.get(key) : undefined;
    const status = pane.status ?? (reg ? registryStatus(reg) : null);
    if (status) out.push({ pane, session: (key && listed.get(key)) || null, status });
  }
  running.forEach((r, i) => {
    const key = `claude:${r.id}`;
    if (open.has(key)) return;
    const session = listed.get(key) ?? null;
    out.push({
      pane: {
        // Clear of a live leaf's id and of a cold pane's small negative ones.
        leafId: Number.MIN_SAFE_INTEGER + i,
        tabId: -1,
        workspaceId: null,
        cold: true,
        ptyId: null,
        cwd: session?.cwd ?? null,
        status: null,
        customTitle: null,
        host: null,
      },
      session,
      status: registryStatus(r),
    });
  });
  return out;
}

/**
 * What a row reads as. The session leads even over a pane's own name, since opening
 * a worktree names the pane after its project, which would make every row in it read
 * the same. A shell titles itself with its own binary, which says nothing.
 */
export function agentTitle(r: AgentRow, terminalTitle?: string): string {
  if (r.session) return r.session.title;
  if (r.pane.customTitle) return r.pane.customTitle;
  return terminalTitle && !/^([A-Za-z]:[\\/]|\/)/.test(terminalTitle)
    ? terminalTitle
    : toolDisplayName(r.status.tool);
}

/** Most urgent first. Idle closes the list because nothing there needs anyone. */
const AGENT_SECTIONS: { state: AiCliState; label: string }[] = [
  { state: "blocking", label: "Needs you" },
  { state: "done", label: "Done" },
  { state: "working", label: "Working" },
  { state: "idle", label: "Idle" },
];

export type AgentSection = {
  id: string;
  label: string;
  /** The state its heading already names, so a row need not spell it out. */
  state: AiCliState | null;
  rows: AgentRow[];
};

/**
 * The Agents list: pins first, then by urgency, or by workspace when `workspaces`
 * is given. Looking at a finished agent turns `done` into `idle`, so `heldDone`
 * keeps that pane under Done until focus leaves it: the row must not jump away
 * from under the click that opened it.
 */
export function agentSections(
  rows: AgentRow[],
  opts: {
    heldDone: number | null;
    pinnedKeys: Set<string>;
    workspaces: { id: string; name: string }[] | null;
  },
): AgentSection[] {
  const { heldDone, pinnedKeys, workspaces } = opts;
  const isPinned = (r: AgentRow) => !!r.session && pinnedKeys.has(sessionKey(r.session));
  const rest = rows.filter((r) => !isPinned(r));
  const stateOf = (r: AgentRow) =>
    r.pane.leafId === heldDone && r.status.state === "idle" ? "done" : r.status.state;
  const sections: AgentSection[] = workspaces
    ? [
        ...workspaces.map((w) => ({
          id: `workspace:${w.id}`,
          label: w.name,
          state: null,
          rows: rest.filter((r) => r.pane.workspaceId === w.id),
        })),
        {
          id: "elsewhere",
          label: RUNNING_SECTION,
          state: null,
          rows: rest.filter((r) => r.pane.workspaceId === null),
        },
      ]
    : AGENT_SECTIONS.map(({ state, label }) => ({
        id: state,
        label,
        state,
        rows: rest
          .filter((r) => stateOf(r) === state)
          .sort((a, b) => b.status.since - a.status.since || a.pane.leafId - b.pane.leafId),
      }));
  return [
    { id: "pinned", label: PINNED_SECTION, state: null, rows: rows.filter(isPinned) },
    ...sections,
  ].filter((sec) => sec.rows.length > 0);
}

/** What a folded heading shows for the rows it hides. */
export function mostUrgent(rows: AgentRow[]): AiCliState | null {
  return (
    AGENT_SECTIONS.find(({ state }) => rows.some((r) => r.status.state === state))?.state ?? null
  );
}

/** Same key shape as `groupSessions`, so one folder compares equal however it was written. */
export const folderKeyOf = (path: string) => toForwardSlash(path).replace(/\/+$/, "").toLowerCase();

/** A session belongs to a folder when it ran there or below it. */
const inFolder = (groupKey: string, folderKey: string) =>
  groupKey === folderKey || groupKey.startsWith(`${folderKey}/`);

export const PINNED_SECTION = "Pinned";
export const RUNNING_SECTION = "Running elsewhere";

/**
 * The History list: every session nothing is running, since those are Agents rows.
 * Pins first, then by day, each newest first. `folderKey` narrows it to one project.
 */
export function historySections(
  list: AgentSession[],
  opts: {
    filter: string;
    folderKey: string | null;
    /** Sessions something is running, by `sessionKey`. */
    openKeys: Set<string>;
    pinnedKeys: Set<string>;
    now: number;
  },
): { label: string; cards: { s: AgentSession; folder: string }[] }[] {
  const { filter, folderKey, openKeys, pinnedKeys, now } = opts;
  const cards = groupSessions(list, filter)
    .filter((g) => folderKey === null || inFolder(g.key, folderKey))
    .flatMap((g) =>
      g.sessions
        .filter((s) => !openKeys.has(sessionKey(s)))
        .map((s) => ({ s, folder: g.label, pinned: pinnedKeys.has(sessionKey(s)) })),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.s.modifiedMs - a.s.modifiedMs);
  const out: ReturnType<typeof historySections> = [];
  for (const { pinned, ...c } of cards) {
    const label = pinned ? PINNED_SECTION : dayBucket(c.s.modifiedMs, now);
    if (out.at(-1)?.label !== label) out.push({ label, cards: [] });
    out.at(-1)!.cards.push(c);
  }
  return out;
}

/** "<1m", "5m", "3h", "2d" - the sidebar has room for a few characters, not a date. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
