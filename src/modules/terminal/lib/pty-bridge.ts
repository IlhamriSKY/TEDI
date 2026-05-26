import { invoke, Channel } from "@tauri-apps/api/core";

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
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

/** Shape returned by the Rust `pty_open` / `pty_attach` commands. */
type PtyOpenResult = { id: number; sessionId: string };

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

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
  const { id, sessionId } = result;
  return {
    id,
    sessionId,
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
