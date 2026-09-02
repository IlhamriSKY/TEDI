import { invoke, Channel } from "@tauri-apps/api/core";
import { decodeBase64 } from "@/lib/ipc";

export type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number };

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  /** Per-GUI numeric handle for subsequent write/resize/close. Stable
   *  within the current process; do NOT persist - use `sessionId` instead. */
  id: number;
  /** Daemon-side stable UUID. Empty string when running the in-process
   *  fallback backend; persisted in `SavedTerminalLeaf.ptyId` so the next
   *  GUI launch can call `reattachPty` to resume the shell. */
  sessionId: string;
  /** Whether the underlying shell is still running. Always true for a fresh
   *  `openPty`. On `reattachPty` it can be false: the daemon retains a
   *  session after its shell exits, so reattaching one only replays frozen
   *  scrollback. The caller respawns a fresh shell in that case instead of
   *  presenting a dead pane. */
  alive: boolean;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

/** Shape returned by the Rust `pty_open` / `pty_attach` commands. */
type PtyOpenResult = { id: number; sessionId: string; alive: boolean };

function makeChannel(handlers: PtyHandlers): Channel<PtyEvent> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    switch (event.type) {
      case "data":
        handlers.onData(decodeBase64(event.data));
        break;
      case "exit":
        handlers.onExit?.(event.code);
        break;
    }
  };
  return channel;
}

function buildSession(result: PtyOpenResult): PtySession {
  const { id, sessionId, alive } = result;
  return {
    id,
    sessionId,
    alive,
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: () => invoke("pty_close", { id }),
  };
}

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
): Promise<PtySession> {
  const channel = makeChannel(handlers);
  const result = await invoke<PtyOpenResult>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    onEvent: channel,
  });
  return buildSession(result);
}

/** Attach to an existing daemon session by UUID. The daemon replays its
 *  scrollback buffer on the channel before live events resume; xterm
 *  reconstructs screen state from the ANSI sequences in that replay. */
export async function reattachPty(
  sessionId: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const channel = makeChannel(handlers);
  const result = await invoke<PtyOpenResult>("pty_attach", {
    sessionId,
    cols,
    rows,
    onEvent: channel,
  });
  return buildSession(result);
}

/** Daemon-side session metadata (mirrors Rust `SessionInfo`; note the wire
 *  field is snake_case `created_at_ms`). `id` is the UUID `reattachPty` takes. */
export type DaemonSessionInfo = {
  id: string;
  cwd: string | null;
  cols: number;
  rows: number;
  alive: boolean;
  created_at_ms: number;
};

/** Enumerate the sessions the PTY daemon currently owns. Returns `[]` under the
 *  in-process fallback backend (no persistent daemon), so callers that diff
 *  against owned leaves simply find nothing to do. */
export async function listDaemonSessions(): Promise<DaemonSessionInfo[]> {
  return invoke<DaemonSessionInfo[]>("pty_list_sessions");
}

/** Kill every session the daemon owns, so nothing survives the GUI exiting.
 *  Backs the quit prompt's "Close all terminals" choice; a no-op under the
 *  in-process backend, whose shells die with the GUI anyway. */
export async function killAllDaemonSessions(): Promise<void> {
  return invoke<void>("pty_kill_all");
}
