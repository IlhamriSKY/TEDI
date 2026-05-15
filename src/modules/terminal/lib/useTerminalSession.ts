import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  registerCwdHandler,
  registerPromptTracker,
  registerTediOpenHandler,
  registerTediSpawnTabHandler,
  type TediOpenInput,
  type TediSpawnTabInput,
} from "./osc-handlers";
import { openPty, type PtySession } from "./pty-bridge";
import {
  getConnectionSecrets,
  listConnections,
  markConnected,
  type SshConnection,
} from "@/modules/ssh/connections";
import { openSsh } from "@/modules/ssh/bridge";
import type { SshStatus } from "@/modules/ssh/status";

export type { TediOpenInput, TediSpawnTabInput };

const BACKWARD_KILL_WORD = "\x17";
const SHIFT_ENTER = "\x1b\r";

const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onTediOpen?: (input: TediOpenInput) => void;
  onTediSpawnTab?: (input: TediSpawnTabInput) => void;
  /** Emitted only for SSH-bound leaves. Drives the tab dot + status pill. */
  onSshStatus?: (status: SshStatus) => void;
};

const RECONNECT_BACKOFF_MS = [1_000, 3_000, 7_000] as const;
const MAX_SSH_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

// Lives outside React so split/unsplit re-parent the DOM without tearing
// down the term or PTY. Real disposal: `disposeSession`.
type Session = {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  pty: PtySession | null;
  cleanups: (() => void)[];
  callbacks: Callbacks;
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  lastSentCols: number;
  lastSentRows: number;
  lastW: number;
  lastH: number;
  lastCwd: string | null;
  lastDetectedUrl: string | null;
  pendingExit: number | null;
  webglEnabled: boolean;
  webglAddon: WebglAddon | null;
  ready: Promise<void>;
  disposed: boolean;
  initialCwd: string | undefined;
  /** If set, this leaf is bound to a saved SSH connection. */
  sshConnectionId: string | undefined;
  ptyOpening: boolean;
  /**
   * Last error message from a failed `openPtyForSession`. When set and
   * `pty === null`, the custom key handler interprets Enter as a retry
   * request. Cleared on successful spawn.
   */
  lastPtyError: string | null;
  // ---- SSH-only fields below. All ignored on local PTY leaves. ----
  /** Latest emitted status. Source of truth for both UI surfaces. */
  sshStatus: SshStatus;
  /**
   * Set when the user (or a tab close) intentionally tore down the SSH
   * session, so the exit/error handler can distinguish "they typed exit"
   * from "the network blipped" and skip auto-reconnect in the first case.
   */
  sshUserClose: boolean;
  /** Current attempt number when in a reconnect schedule (1-based). */
  sshReconnectAttempts: number;
  /** Pending timer for the next reconnect attempt (cleared on dispose). */
  sshReconnectTimer: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<number, Session>();

function ensureSession(
  leafId: number,
  initialCwd?: string,
  sshConnectionId?: string,
): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const prefs = usePreferencesStore.getState();
  const webglEnabled = prefs.terminalWebglEnabled;
  const fontSize = prefs.terminalFontSize;

  const term = new Terminal({
    fontFamily: detectMonoFontFamily(),
    fontSize,
    lineHeight: 1.05,
    theme: buildTerminalTheme(),
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    // 5k lines × 80 cols × ~16 B per cell ≈ 6 MB per leaf. 10k doubled
    // that for output almost no one scrolls back to. Keep this knob in
    // mind if/when we add a "scrollback" preference.
    scrollback: 5_000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => openUrl(uri).catch(console.error)),
  );

  const session: Session = {
    term,
    fitAddon,
    searchAddon,
    pty: null,
    cleanups: [],
    callbacks: {},
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    lastSentCols: 0,
    lastSentRows: 0,
    lastW: 0,
    lastH: 0,
    lastCwd: null,
    lastDetectedUrl: null,
    pendingExit: null,
    webglEnabled,
    webglAddon: null,
    ready: Promise.resolve(),
    disposed: false,
    initialCwd,
    sshConnectionId,
    ptyOpening: false,
    lastPtyError: null,
    sshStatus: { kind: "idle" },
    sshUserClose: false,
    sshReconnectAttempts: 0,
    sshReconnectTimer: null,
  };
  sessions.set(leafId, session);

  term.attachCustomKeyEventHandler((event) => {
    const pty = session.pty;
    if (!pty) {
      // No live shell. If we got here because of a prior open failure,
      // treat Enter as "retry" so the user can recover without closing
      // the tab. Applies to both local PTY spawn errors and SSH leaves
      // that exhausted the auto-reconnect schedule.
      const enterToRetry =
        !session.ptyOpening &&
        event.type === "keydown" &&
        event.key === "Enter" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey;
      if (session.lastPtyError !== null && enterToRetry) {
        event.preventDefault();
        event.stopPropagation();
        void retryPty(session);
        return false;
      }
      if (
        session.sshConnectionId &&
        enterToRetry &&
        canRetrySsh(session.sshStatus)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void retrySsh(session);
        return false;
      }
      return true;
    }
    if (isCtrlBackspace(event)) {
      event.preventDefault();
      event.stopPropagation();
      pty.write(BACKWARD_KILL_WORD);
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      event.stopPropagation();
      pty.write(SHIFT_ENTER);
      return false;
    }
    return true;
  });

  // Routes through session.pty so respawn doesn't need to rebind.
  term.onData((data) => session.pty?.write(data));

  // PTY is opened lazily in attachSession after the first fit, so the shell
  // starts with the real terminal size and never flushes a 80x24-sized
  // prompt into scrollback.
  session.ready = (async () => {
    await document.fonts.ready;
    if (session.disposed) return;

    const prompt = registerPromptTracker(term);
    session.cleanups.push(prompt.dispose);
    session.cleanups.push(
      registerCwdHandler(term, (cwd) => {
        session.lastCwd = cwd;
        session.callbacks.onCwd?.(cwd);
      }),
      registerTediOpenHandler(term, (input) => {
        session.callbacks.onTediOpen?.(input);
      }),
      registerTediSpawnTabHandler(term, (input) => {
        session.callbacks.onTediSpawnTab?.(input);
      }),
    );
  })();

  return session;
}

function openPtyForSession(
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  // Fresh decoder per pty so a partial UTF-8 codepoint from a prior shell
  // doesn't leak into the new one.
  const urlDecoder = new TextDecoder("utf-8", { fatal: false });

  const onData = (bytes: Uint8Array) => {
    s.term.write(bytes);
    if (containsSchemeSeparator(bytes)) {
      const text = urlDecoder.decode(bytes, { stream: true });
      const matches = text.match(LOCAL_URL_RE);
      if (matches && matches.length > 0) {
        const url = stripTrailingPunct(matches[matches.length - 1]);
        if (url && url !== s.lastDetectedUrl) {
          s.lastDetectedUrl = url;
          s.callbacks.onDetectedLocalUrl?.(url);
        }
      }
    }
  };
  const onExit = (code: number) => {
    s.term.options.disableStdin = true;
    if (s.callbacks.onExit) s.callbacks.onExit(code);
    else s.pendingExit = code;
  };

  if (s.sshConnectionId) {
    return openSshForSession(s, s.sshConnectionId, onData, onExit);
  }

  return openPty(s.term.cols, s.term.rows, { onData, onExit }, cwd);
}

function writeSshBanner(s: Session, text: string): void {
  const enc = new TextEncoder();
  s.term.write(enc.encode(text));
}

function emitSshStatus(s: Session, next: SshStatus): void {
  s.sshStatus = next;
  s.callbacks.onSshStatus?.(next);
}

function canRetrySsh(status: SshStatus): boolean {
  return (
    (status.kind === "disconnected" && status.canRetry) ||
    (status.kind === "error" && status.canRetry)
  );
}

async function openSshForSession(
  s: Session,
  sshConnectionId: string,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number) => void,
): Promise<PtySession> {
  // Look up the saved connection metadata + secrets at open time so a
  // password change in settings is picked up on the next reconnect
  // without restarting the app.
  const list = await listConnections();
  const conn: SshConnection | undefined = list.find(
    (c) => c.id === sshConnectionId,
  );
  if (!conn) {
    throw new Error(`ssh: connection "${sshConnectionId}" not found`);
  }
  const secrets = await getConnectionSecrets(sshConnectionId);

  // `sshReconnectAttempts` is bumped by `scheduleSshReconnect` before this
  // runs; the first open (no reconnects yet) leaves it at 0 → attempt 1.
  const attempt = Math.max(1, s.sshReconnectAttempts);
  emitSshStatus(s, { kind: "connecting", attempt });
  writeSshBanner(
    s,
    `\x1b[2m[tedi] connecting to ${conn.user}@${conn.host}:${conn.port}…\x1b[0m\r\n`,
  );

  // Track whether we've already routed this attempt's terminal event into
  // the reconnect scheduler — russh can fire both onExit and onError for
  // the same drop, and the first one wins.
  let terminated = false;
  const handleTerminal = (reason: string) => {
    if (terminated) return;
    terminated = true;
    if (s.disposed) return;
    if (s.sshUserClose) {
      emitSshStatus(s, {
        kind: "disconnected",
        reason: "closed by user",
        canRetry: true,
      });
      onExit(0);
      return;
    }
    // Drop the live handle so attachSession / retrySsh treat the leaf as
    // "needs spawn" and the Enter-to-retry path can fire.
    s.pty = null;
    scheduleSshReconnect(s, reason);
  };

  const sshSession = await openSsh(
    {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.authMode === "password" ? secrets.password ?? "" : undefined,
      privateKey: conn.authMode === "key" ? secrets.privateKey ?? "" : undefined,
      privateKeyPassphrase:
        conn.authMode === "key" ? secrets.keyPassphrase ?? undefined : undefined,
      cols: s.term.cols,
      rows: s.term.rows,
    },
    {
      onConnected: (fp) => {
        writeSshBanner(s, `\x1b[2m[tedi] server key ${fp}\x1b[0m\r\n`);
        s.sshReconnectAttempts = 0;
        emitSshStatus(s, {
          kind: "connected",
          fingerprint: fp,
          since: Date.now(),
        });
        // Fire-and-forget; failure to write the timestamp shouldn't take
        // the live session down.
        void markConnected(sshConnectionId, fp).catch(() => {});
      },
      onData,
      onExit: (code) => {
        handleTerminal(code === 0 ? "remote closed" : `exit ${code}`);
      },
      onError: (msg) => {
        writeSshBanner(s, `\r\n\x1b[31m[tedi] ssh error: ${msg}\x1b[0m\r\n`);
        handleTerminal(msg);
      },
    },
  );

  // Adapter so the rest of useTerminalSession treats SSH like a PtySession.
  return {
    id: sshSession.id,
    write: (data) => sshSession.write(data),
    resize: (cols, rows) => sshSession.resize(cols, rows),
    close: () => sshSession.close(),
  };
}

function scheduleSshReconnect(s: Session, reason: string): void {
  if (s.disposed || s.sshUserClose) return;
  if (!s.sshConnectionId) return;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  const attempt = s.sshReconnectAttempts + 1;
  if (attempt > MAX_SSH_RECONNECT_ATTEMPTS) {
    s.sshReconnectAttempts = 0;
    emitSshStatus(s, {
      kind: "disconnected",
      reason,
      canRetry: true,
    });
    writeSshBanner(
      s,
      `\r\n\x1b[33m[tedi] disconnected (${reason}). Press Enter or click Retry to reconnect.\x1b[0m\r\n`,
    );
    return;
  }
  s.sshReconnectAttempts = attempt;
  const delay = RECONNECT_BACKOFF_MS[attempt - 1];
  emitSshStatus(s, {
    kind: "reconnecting",
    attempt,
    nextDelayMs: delay,
    reason,
  });
  writeSshBanner(
    s,
    `\r\n\x1b[33m[tedi] connection lost (${reason}); reconnecting in ${Math.round(
      delay / 1000,
    )}s (attempt ${attempt}/${MAX_SSH_RECONNECT_ATTEMPTS})…\x1b[0m\r\n`,
  );
  s.sshReconnectTimer = setTimeout(() => {
    s.sshReconnectTimer = null;
    void runSshReconnect(s);
  }, delay);
}

async function runSshReconnect(s: Session): Promise<void> {
  if (s.disposed || s.sshUserClose) return;
  if (!s.sshConnectionId) return;
  if (s.pty) return; // already alive
  if (s.ptyOpening) return;
  s.ptyOpening = true;
  s.lastPtyError = null;
  s.term.options.disableStdin = false;
  try {
    const pty = await openPtyForSession(s, s.initialCwd);
    s.ptyOpening = false;
    if (s.disposed) {
      void pty.close();
      return;
    }
    s.pty = pty;
    s.lastSentCols = s.term.cols;
    s.lastSentRows = s.term.rows;
    if (s.observer) void pty.resize(s.term.cols, s.term.rows);
  } catch (e) {
    s.ptyOpening = false;
    const msg = describeError(e);
    console.error("ssh reconnect failed:", e);
    scheduleSshReconnect(s, msg);
  }
}

/**
 * Manually re-arm an SSH leaf that was disconnected (auto-retries
 * exhausted, or user picked "Disconnect" from the status pill). Resets the
 * attempt counter so the user gets a fresh 3-attempt window.
 */
async function retrySsh(s: Session): Promise<void> {
  if (s.disposed) return;
  if (!s.sshConnectionId) return;
  if (s.pty) return;
  if (s.ptyOpening) return;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  s.sshReconnectAttempts = 0;
  s.sshUserClose = false;
  s.term.reset();
  s.term.options.disableStdin = false;
  await runSshReconnect(s);
}

/**
 * User-initiated SSH close. Sets the user-close flag so the exit handler
 * doesn't auto-reconnect, then closes the channel. Exposed so the status
 * bar's "Disconnect" menu item can drive it.
 */
export async function disconnectSsh(leafId: number): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return;
  if (!s.sshConnectionId) return;
  s.sshUserClose = true;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  const pty = s.pty;
  s.pty = null;
  if (pty) await pty.close().catch(() => {});
  emitSshStatus(s, {
    kind: "disconnected",
    reason: "closed by user",
    canRetry: true,
  });
  writeSshBanner(
    s,
    `\r\n\x1b[33m[tedi] disconnected. Press Enter or click Reconnect to come back.\x1b[0m\r\n`,
  );
}

/** External handle for the status pill's "Reconnect" button. */
export async function reconnectSsh(leafId: number): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return;
  if (!s.sshConnectionId) return;
  await retrySsh(s);
}

function describeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function writePtyError(s: Session, message: string): void {
  s.term.reset();
  s.term.options.disableStdin = false;
  s.term.write(
    "\x1b[31m\x1b[1m[tedi] failed to start shell\x1b[0m\r\n" +
      `\x1b[31m${message.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n\r\n` +
      "\x1b[2mPress Enter to retry, or close the tab.\x1b[0m\r\n",
  );
}

/**
 * Retry a PTY spawn after a prior failure. Wired to Enter via the custom
 * key handler in `ensureSession` so users can recover without closing the
 * tab. No-ops if already opening, already alive, or disposed.
 */
async function retryPty(s: Session): Promise<void> {
  if (s.disposed) return;
  if (s.pty) return;
  if (s.ptyOpening) return;
  s.ptyOpening = true;
  s.lastPtyError = null;
  s.term.reset();
  s.term.options.disableStdin = false;
  s.term.write("\x1b[2m[tedi] retrying…\x1b[0m\r\n");
  s.lastSentCols = s.term.cols;
  s.lastSentRows = s.term.rows;
  try {
    const pty = await openPtyForSession(s, s.initialCwd);
    s.ptyOpening = false;
    if (s.disposed) {
      void pty.close();
      return;
    }
    s.pty = pty;
    if (
      s.term.cols !== s.lastSentCols ||
      s.term.rows !== s.lastSentRows
    ) {
      s.lastSentCols = s.term.cols;
      s.lastSentRows = s.term.rows;
      void pty.resize(s.term.cols, s.term.rows);
    }
  } catch (e) {
    s.ptyOpening = false;
    const msg = describeError(e);
    s.lastPtyError = msg;
    console.error("retryPty: openPty failed:", e);
    writePtyError(s, msg);
  }
}

/**
 * Write raw bytes to a specific leaf's PTY without going through React state.
 * Used by the OS file-drop handler to paste paths into the terminal under
 * the cursor. Returns false if the leaf has no live PTY.
 */
export function writeToLeaf(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || !s.pty) return false;
  s.pty.write(data);
  s.term.focus();
  return true;
}

/**
 * Hit-test the DOM at a CSS-pixel point and return the enclosing terminal
 * leaf id, if any. Walks up from `elementFromPoint` looking for the
 * `data-terminal-leaf-id` attribute set by `TerminalPane`.
 */
export function findLeafIdFromPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const host = (el as Element).closest<HTMLElement>(
    "[data-terminal-leaf-id]",
  );
  if (!host) return null;
  const raw = host.dataset.terminalLeafId;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.pty?.close();
  s.pty = null;
  s.term.reset();
  s.term.options.disableStdin = false;
  s.lastSentCols = 0;
  s.lastSentRows = 0;
  s.lastDetectedUrl = null;
  s.pendingExit = null;
  // Hold the flag so attachSession can't open a second PTY while we await.
  s.ptyOpening = true;
  s.lastPtyError = null;
  let pty: PtySession;
  try {
    pty = await openPtyForSession(s, cwd);
  } catch (e) {
    s.ptyOpening = false;
    const msg = describeError(e);
    s.lastPtyError = msg;
    console.error("respawnSession: openPty failed:", e);
    writePtyError(s, msg);
    return;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  s.pty = pty;
  if (s.observer) {
    pty.resize(s.term.cols, s.term.rows);
    s.lastSentCols = s.term.cols;
    s.lastSentRows = s.term.rows;
  }
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;

  const firstAttach = !s.term.element;
  if (firstAttach) {
    s.term.open(container);
  } else if (s.term.element && s.term.element.parentNode !== container) {
    container.appendChild(s.term.element);
  }

  // Sync fit before WebGL load and PTY open so the renderer measures the
  // real container and the shell starts at the right cols/rows.
  s.fitAddon.fit();
  s.lastW = container.clientWidth;
  s.lastH = container.clientHeight;

  if (firstAttach && !s.webglAddon && s.webglEnabled) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (s.webglAddon === webgl) s.webglAddon = null;
      });
      s.term.loadAddon(webgl);
      s.webglAddon = webgl;
    } catch (e) {
      console.warn("WebGL renderer unavailable:", e);
    }
  }

  if (!s.pty && !s.ptyOpening) {
    s.ptyOpening = true;
    s.lastPtyError = null;
    s.lastSentCols = s.term.cols;
    s.lastSentRows = s.term.rows;
    openPtyForSession(s, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed) {
          pty.close();
          return;
        }
        s.pty = pty;
        if (
          s.term.cols !== s.lastSentCols ||
          s.term.rows !== s.lastSentRows
        ) {
          s.lastSentCols = s.term.cols;
          s.lastSentRows = s.term.rows;
          pty.resize(s.term.cols, s.term.rows);
        }
      })
      .catch((e) => {
        s.ptyOpening = false;
        const msg = describeError(e);
        console.error("openPty failed:", e);
        // SSH-bound leaves stay live and run through the backoff scheduler
        // so the user sees consistent reconnect UX whether the failure is
        // a fresh open or a mid-session drop. Local PTY leaves keep the
        // "Press Enter to retry" flow.
        if (s.sshConnectionId) {
          writeSshBanner(
            s,
            `\r\n\x1b[31m[tedi] ssh connect failed: ${msg}\x1b[0m\r\n`,
          );
          scheduleSshReconnect(s, msg);
          return;
        }
        s.lastPtyError = msg;
        writePtyError(s, msg);
      });
  } else if (
    s.pty &&
    (s.term.cols !== s.lastSentCols || s.term.rows !== s.lastSentRows)
  ) {
    s.lastSentCols = s.term.cols;
    s.lastSentRows = s.term.rows;
    s.pty.resize(s.term.cols, s.term.rows);
  }

  s.observer?.disconnect();
  s.observer = null;
  if (s.fitTimer) {
    clearTimeout(s.fitTimer);
    s.fitTimer = null;
  }
  if (s.ptyTimer) {
    clearTimeout(s.ptyTimer);
    s.ptyTimer = null;
  }

  // Two-stage debounce:
  //  - FIT runs frequently (~one frame) so xterm visually keeps up with
  //    the window during drag. Local, no IPC.
  //  - PTY_RESIZE only fires on the trailing edge of the drag, because
  //    SIGWINCH is what causes shells / fancy prompts (powerlevel10k,
  //    starship) to redraw mid-resize, which the user perceives as
  //    blinking. The shell only cares about the FINAL size.
  const FIT_DEBOUNCE_MS = 8;
  const PTY_RESIZE_DEBOUNCE_MS = 256;

  const flushPtyResize = () => {
    s.ptyTimer = null;
    if (!s.pty || s.disposed) return;
    if (s.term.cols === s.lastSentCols && s.term.rows === s.lastSentRows)
      return;
    s.lastSentCols = s.term.cols;
    s.lastSentRows = s.term.rows;
    s.pty.resize(s.term.cols, s.term.rows);
  };

  s.observer = new ResizeObserver(() => {
    if (s.fitTimer) clearTimeout(s.fitTimer);
    s.fitTimer = setTimeout(() => {
      s.fitTimer = null;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === s.lastW && h === s.lastH) return;
      s.lastW = w;
      s.lastH = h;
      s.fitAddon.fit();
      if (s.ptyTimer) clearTimeout(s.ptyTimer);
      s.ptyTimer = setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  s.observer.observe(container);

  // Re-sync App state after re-attach (prior detach cleared callbacks).
  if (s.lastCwd !== null) callbacks.onCwd?.(s.lastCwd);
  if (s.lastDetectedUrl !== null)
    callbacks.onDetectedLocalUrl?.(s.lastDetectedUrl);
  callbacks.onSearchReady?.(s.searchAddon);
  if (s.sshConnectionId) {
    // Re-emit the latest known status so the pill/dot redraw correctly after
    // a split or workspace-switch reattaches the leaf to a fresh App tree.
    callbacks.onSshStatus?.(s.sshStatus);
  }
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    callbacks.onExit?.(code);
  }
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.observer?.disconnect();
  s.observer = null;
  if (s.fitTimer) {
    clearTimeout(s.fitTimer);
    s.fitTimer = null;
  }
  if (s.ptyTimer) {
    clearTimeout(s.ptyTimer);
    s.ptyTimer = null;
  }
  s.callbacks = {};
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  s.sshUserClose = true;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  s.cleanups.forEach((fn) => fn());
  s.observer?.disconnect();
  if (s.fitTimer) clearTimeout(s.fitTimer);
  if (s.ptyTimer) clearTimeout(s.ptyTimer);
  s.pty?.close();
  s.term.dispose();
  sessions.delete(leafId);
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  /** If set, the leaf will open an SSH session instead of a local PTY. */
  sshConnectionId?: string;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onTediOpen?: (input: TediOpenInput) => void;
  onTediSpawnTab?: (input: TediSpawnTabInput) => void;
  /** Fires whenever an SSH leaf transitions between connection states. */
  onSshStatus?: (status: SshStatus) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  sshConnectionId,
  onSearchReady,
  onExit,
  onCwd,
  onDetectedLocalUrl,
  onTediOpen,
  onTediSpawnTab,
  onSshStatus,
}: Options) {
  const cbRef = useRef({
    onSearchReady,
    onExit,
    onCwd,
    onDetectedLocalUrl,
    onTediOpen,
    onTediSpawnTab,
    onSshStatus,
  });
  cbRef.current = {
    onSearchReady,
    onExit,
    onCwd,
    onDetectedLocalUrl,
    onTediOpen,
    onTediSpawnTab,
    onSshStatus,
  };

  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    const s = ensureSession(leafId, initialCwd, sshConnectionId);
    // If the leaf hasn't spawned its PTY yet, accept a fresher initialCwd
    // from this render (e.g. explorerRoot resolved between mounts).
    if (!s.pty && !s.ptyOpening && initialCwd && s.initialCwd !== initialCwd) {
      s.initialCwd = initialCwd;
    }
    const callbacks: Callbacks = {
      onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
      onExit: (c) => cbRef.current.onExit?.(c),
      onCwd: (c) => cbRef.current.onCwd?.(c),
      onDetectedLocalUrl: (u) => cbRef.current.onDetectedLocalUrl?.(u),
      onTediOpen: (input) => cbRef.current.onTediOpen?.(input),
      onTediSpawnTab: (input) => cbRef.current.onTediSpawnTab?.(input),
      onSshStatus: (status) => cbRef.current.onSshStatus?.(status),
    };
    // Wait for the container ref to be set. In normal mounts this is
    // already truthy by the time s.ready resolves, but split/unsplit and
    // strict-mode double-mount can briefly null it; retry a few frames
    // before giving up so we don't end up with a tab that has no shell.
    const MAX_ATTACH_FRAMES = 30;
    const tryAttach = (framesLeft: number) => {
      if (cancelled) return;
      if (container.current) {
        attachSession(leafId, container.current, callbacks);
        if (visible && focused) s.term.focus();
        return;
      }
      if (framesLeft <= 0) {
        console.warn(
          `useTerminalSession: container ref never settled for leaf ${leafId}`,
        );
        return;
      }
      rafId = requestAnimationFrame(() => tryAttach(framesLeft - 1));
    };
    s.ready
      .then(() => {
        if (cancelled) return;
        tryAttach(MAX_ATTACH_FRAMES);
      })
      .catch((e) => {
        // session.ready failed (font load rejected, OSC handler register
        // threw, etc.). Surface to the user with a retry hint instead of
        // leaving the tab silently empty. Still attach so the message is
        // actually visible — writes to a detached xterm buffer in memory
        // but the user can't see them.
        if (cancelled) return;
        const msg = describeError(e);
        s.lastPtyError = msg;
        console.error("session ready failed:", e);
        writePtyError(s, msg);
        tryAttach(MAX_ATTACH_FRAMES);
      });
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      detachSession(leafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    if (s.term.options.fontSize === fontSize) return;
    s.term.options.fontSize = fontSize;
    // WebGL renderer caches glyphs in a GPU texture atlas keyed by the old
    // font metrics. Dispose and re-create so the new size renders correctly.
    if (s.webglAddon && s.term.element) {
      s.webglAddon.dispose();
      s.webglAddon = null;
      if (s.webglEnabled) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            webgl.dispose();
            if (s.webglAddon === webgl) s.webglAddon = null;
          });
          s.term.loadAddon(webgl);
          s.webglAddon = webgl;
        } catch (e) {
          console.warn("WebGL renderer unavailable:", e);
        }
      }
    }
    s.fitAddon.fit();
    if (s.pty && (s.term.cols !== s.lastSentCols || s.term.rows !== s.lastSentRows)) {
      s.lastSentCols = s.term.cols;
      s.lastSentRows = s.term.rows;
      s.pty.resize(s.term.cols, s.term.rows);
    }
  }, [leafId, fontSize]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.webglEnabled = webglPref;
    if (!s.term.element) return;
    if (webglPref && !s.webglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (s.webglAddon === webgl) s.webglAddon = null;
        });
        s.term.loadAddon(webgl);
        s.webglAddon = webgl;
      } catch (e) {
        console.warn("WebGL renderer unavailable:", e);
      }
    } else if (!webglPref && s.webglAddon) {
      s.webglAddon.dispose();
      s.webglAddon = null;
    }
  }, [leafId, webglPref]);

  useLayoutEffect(() => {
    if (!visible) return;
    const s = sessions.get(leafId);
    if (!s) return;
    s.fitAddon.fit();
    if (focused) s.term.focus();
  }, [leafId, visible, focused]);

  const write = useCallback(
    (data: string) => sessions.get(leafId)?.pty?.write(data),
    [leafId],
  );

  const focus = useCallback(() => {
    sessions.get(leafId)?.term.focus();
  }, [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const buf = s.term.buffer.active;
      const total = buf.length;
      const lines: string[] = [];
      const start = Math.max(0, total - maxLines);
      for (let i = start; i < total; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      }
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const sel = sessions.get(leafId)?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.term.options.theme = buildTerminalTheme();
  }, [leafId]);

  return { write, focus, getBuffer, getSelection, applyTheme };
}

function isCtrlBackspace(event: KeyboardEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Backspace" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

function isShiftEnter(event: KeyboardEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,);\]]+$/, "");
}

function containsSchemeSeparator(bytes: Uint8Array): boolean {
  const n = bytes.length;
  for (let i = 0; i < n - 2; i++) {
    if (bytes[i] === 0x3a && bytes[i + 1] === 0x2f && bytes[i + 2] === 0x2f) {
      return true;
    }
  }
  return false;
}
