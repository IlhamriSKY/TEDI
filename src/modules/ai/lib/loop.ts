/**
 * `/loop <interval> <prompt>`: re-send a prompt to the agent on a fixed interval,
 * like Claude Code's `/loop`. For watching something ("check the CI run and tell
 * me when it goes red"), not for driving a task to done - that is `/goal`.
 *
 * Each tick goes through the PROMPT QUEUE, so it waits behind a busy turn or a
 * pending approval and opens a restore checkpoint exactly as a typed prompt
 * does. A tick is queued for its own chat, so it never runs in another one,
 * and never stacks a second copy of itself.
 *
 * IN MEMORY, like an armed `/goal`: a restart ends every loop. Bounded by
 * `MAX_LOOP_RUNS` so a forgotten loop cannot bill a key all night.
 */

export const MIN_LOOP_MS = 60_000;
export const MAX_LOOP_MS = 7 * 24 * 3_600_000;
export const MAX_LOOP_RUNS = 48;

/** The slice of the chat store a loop needs. Passed in (the caller hands over
 *  `useChatStore.getState`) so this file imports no store and stays testable. */
export type LoopHost = () => {
  sessions: { id: string }[];
  activeSessionId: string | null;
  promptQueue: { text: string; sessionId: string | null }[];
  enqueuePrompt: (text: string, sessionId?: string | null) => void;
};

type Loop = {
  prompt: string;
  everyMs: number;
  runs: number;
  host: LoopHost;
  timer: ReturnType<typeof setInterval>;
};
const loops = new Map<string, Loop>();

/** `90s`, `10m`, `1h30m`, `2d` -> ms, or null when unparseable or out of range. */
export function parseInterval(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!/^(\d+[smhd])+$/.test(s)) return null;
  let ms = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([smhd])/g)) {
    ms +=
      Number(n) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u as "s" | "m" | "h" | "d"];
  }
  return ms >= MIN_LOOP_MS && ms <= MAX_LOOP_MS ? ms : null;
}

export function formatInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function tick(sessionId: string): void {
  const loop = loops.get(sessionId);
  if (!loop) return;
  const st = loop.host();
  if (!st.sessions.some((s) => s.id === sessionId)) {
    stopLoop(sessionId);
    return;
  }
  // Queued FOR ITS OWN CHAT: it drains when that chat is open and idle, and
  // one copy waits at most, however long the user stays elsewhere.
  if (st.promptQueue.some((q) => q.sessionId === sessionId && q.text === loop.prompt)) return;
  loop.runs++;
  st.enqueuePrompt(loop.prompt, sessionId);
  if (loop.runs >= MAX_LOOP_RUNS) stopLoop(sessionId);
}

/** Start (or replace) this session's loop, and run it once right away. */
export function startLoop(
  sessionId: string,
  everyMs: number,
  prompt: string,
  host: LoopHost,
): void {
  stopLoop(sessionId);
  const timer = setInterval(() => tick(sessionId), everyMs);
  loops.set(sessionId, { prompt, everyMs, runs: 0, host, timer });
  tick(sessionId);
}

export function stopLoop(sessionId: string): boolean {
  const loop = loops.get(sessionId);
  if (!loop) return false;
  clearInterval(loop.timer);
  loops.delete(sessionId);
  return true;
}

export function loopOf(
  sessionId: string,
): { prompt: string; everyMs: number; runs: number } | null {
  const l = loops.get(sessionId);
  return l ? { prompt: l.prompt, everyMs: l.everyMs, runs: l.runs } : null;
}
