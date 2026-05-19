import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "@/modules/settings/store";
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
import { openSsh, isHostKeyMismatchError } from "@/modules/ssh/bridge";
import type { SshStatus } from "@/modules/ssh/status";
import { createAiCliDetector, type AiCliDetector } from "./aiCliDetector";
import type { AiCliStatus } from "./aiCliStatus";

export type { TediOpenInput, TediSpawnTabInput };

const BACKWARD_KILL_WORD = "\x17";
const SHIFT_ENTER = "\x1b\r";

// Floor for any size pushed to the PTY. xterm's FitAddon can briefly compute
// 0×0 or 1×1 dimensions when the container collapses (drag, layout
// transition, hidden tab), and TUIs respond to that with broken or hung
// screens (nano shows a blank line; nvim panics out of room; btop draws
// nothing). 2×2 is the smallest size every TUI we care about tolerates.
const MIN_PTY_DIM = 2;

const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;

// If a freshly-spawned PTY exits within this window, treat it as a spawn-time
// crash rather than a user-initiated `exit`. Why: workspace-restore opens
// several PTYs concurrently and a transient ConPTY/profile-init failure used
// to bubble up as `onExit` -> `handleLeafExit` -> `closePaneByLeaf`, which
// silently dropped panes from the restored layout. We now hold the leaf in
// place with a retry banner so the user can recover with Enter.
const SPAWN_GRACE_MS = 3_000;

// Hard ceiling on how long we'll wait for `pty_open` to return a session id.
// Why: workspace-restore on Windows occasionally lands in a state where the
// `invoke("pty_open")` promise never settles - neither resolves nor rejects -
// leaving the leaf with `pty=null` AND `lastPtyError=null`, so the keyboard
// handler's Enter-to-retry path can't fire (it gates on `lastPtyError`). The
// user sees a forever-black pane that refuses to accept input. After this
// many ms we force the spawn into the retry-banner path so the leaf is
// recoverable with Enter. Ordinary local spawns complete in <300 ms; tens of
// seconds is well outside any legitimate slow-machine bound while still
// covering pathological ConPTY contention.
const SPAWN_TIMEOUT_MS = 15_000;

/**
 * Diagnostic toggle for the PTY lifecycle. Default-on so reports from users
 * include the lifecycle traces in their devtools console; set
 * `localStorage.TEDI_DEBUG_PTY = "0"` to silence.
 */
function isDebugPty(): boolean {
  try {
    return localStorage.getItem("TEDI_DEBUG_PTY") !== "0";
  } catch {
    return true;
  }
}

/**
 * After the PTY's `pty_open` resolves we treat any further silence as a
 * stall. A healthy shell writes its first prompt within tens of ms; if 5s
 * goes by with zero bytes flowing through `onData`, the user sees a
 * forever-blank pane that doesn't echo input. Surface that state as an
 * explicit banner + retry-able error so the leaf is recoverable with Enter.
 */
const NO_DATA_WATCHDOG_MS = 5_000;

/**
 * Last-resort watchdog armed when the leaf's `useEffect` runs. Catches the
 * silent-blank failure mode where attachSession never gets reached at all
 * (container.current never settles even past the rAF+interval safety net,
 * OR ensureSession's `s.ready` promise stays pending forever): both
 * `s.lastPtyError` and `s.pty` stay `null`, `ptyOpening` stays `false`, and
 * Enter-to-retry doesn't fire because the keyboard handler gates on
 * `lastPtyError !== null`. Observed on workspace-restore when a tab opens
 * with two split panes - one ends up forever-blank with no input echo and
 * no banner. After this many ms with no live PTY and no pending error, we
 * force `retryPty` / `retrySsh` so the leaf is no longer dead. Tuned > the
 * 120-frame (~2s) container-settle budget but < `SPAWN_TIMEOUT_MS` (15s)
 * so we recover before a genuine slow spawn would have surfaced its own
 * error banner.
 */
const STUCK_RECOVERY_MS = 8_000;

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onTediOpen?: (input: TediOpenInput) => void;
  onTediSpawnTab?: (input: TediSpawnTabInput) => void;
  /** Emitted only for SSH-bound leaves. Drives the tab dot + status pill. */
  onSshStatus?: (status: SshStatus) => void;
  /** Emitted when an AI CLI tool is detected/changes state in this leaf. */
  onAiCliStatus?: (status: AiCliStatus) => void;
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
  /**
   * Wall-clock ms when the current PTY's `then` resolved successfully. Used
   * by the exit handler to distinguish "shell crashed during init" (window
   * defined by `SPAWN_GRACE_MS`) from a user-initiated `exit` later on.
   * Reset to `null` whenever `pty` is cleared.
   */
  ptySpawnedAt: number | null;
  /**
   * Monotonic counter bumped at the start of every `openPtyForSession`. The
   * per-call exit handler captures the value at construction time so it can
   * detect "this exit pertains to a pty that's already been replaced by a
   * newer spawn" -- avoids the respawn race where late exit events for an
   * old pty would otherwise clobber `s.pty` / fire spurious banners on the
   * new one.
   */
  ptySpawnEpoch: number;
  /**
   * Watchdog timer armed when a local PTY's `pty_open` resolves. Cleared by
   * the first incoming byte. If it fires, the shell is treated as
   * unresponsive and the leaf gets a retry banner. Set to null when not armed.
   */
  noDataTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Epoch number for which `onData` has already received at least one byte.
   * Set in `onData`, read by `armNoDataWatchdog` to skip arming when bytes
   * arrived between `invoke("pty_open")` issuing and its promise resolving
   * (the channel's `onmessage` is wired up before the await, so the data
   * event for the first byte CAN beat the resolution). Without this guard
   * the watchdog would arm against a shell that already printed its prompt
   * and is now idle, fire after 5s, close the PTY, and trigger the auto-
   * close path via `onExit -> handleLeafExit -> closePaneByLeaf`.
   */
  firstByteEpoch: number;
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
  // ---- AI CLI detection ----
  /** Detector instance (per-session). Created in ensureSession's ready block. */
  aiCliDetector: AiCliDetector | null;
  /** Latest emitted AI CLI status. Replayed on re-attach. */
  aiCliStatus: AiCliStatus;
};

const sessions = new Map<number, Session>();

/**
 * Snapshot the visible content of an xterm Terminal's viewport as a single
 * newline-joined string (original case - the AI-CLI detector lowercases
 * as needed but also looks for case-sensitive Unicode markers like `❯`).
 *
 * Defensive: xterm's buffer / row APIs can throw or return null while the
 * terminal is mid-reflow (resize, theme swap). Any error returns "" so
 * the detector treats the screen as empty for that tick - safer than
 * letting an exception kill the detector loop.
 */
function readTerminalViewport(term: Terminal): string {
  try {
    const buf = term.buffer.active;
    const start = buf.baseY;
    const end = start + term.rows;
    const lines: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Compose the terminal's base font size with the global content-zoom factor
 * (see `Preferences.contentZoom`), clamped to xterm's sane bounds. xterm
 * renders glyphs into a GPU/canvas grid keyed by `fontSize`, so scaling the
 * pref this way triggers xterm's internal recompute - far more reliable than
 * CSS `zoom`, which leaves the canvas at the old resolution and offsets the
 * cursor from the text.
 */
function effectiveTerminalFontSize(base: number, zoom: number): number {
  const raw = Math.round(base * (Number.isFinite(zoom) ? zoom : 1));
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, raw));
}

function ensureSession(leafId: number, initialCwd?: string, sshConnectionId?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const prefs = usePreferencesStore.getState();
  const webglEnabled = prefs.terminalWebglEnabled;
  const fontSize = effectiveTerminalFontSize(prefs.terminalFontSize, prefs.contentZoom);

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
  term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri).catch(console.error)));

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
    ptySpawnedAt: null,
    ptySpawnEpoch: 0,
    noDataTimer: null,
    firstByteEpoch: 0,
    sshStatus: { kind: "idle" },
    sshUserClose: false,
    sshReconnectAttempts: 0,
    sshReconnectTimer: null,
    aiCliDetector: null,
    aiCliStatus: null,
  };
  sessions.set(leafId, session);

  term.attachCustomKeyEventHandler((event) => {
    // IME composition: defer entirely to the browser/IME. Without this guard,
    // a Ctrl+Backspace pressed mid-composition (Japanese candidate delete,
    // Hangul jamo correction) would inject \x17 into the PTY and corrupt
    // both the IME state and the on-screen buffer. `keyCode === 229` is the
    // legacy signal some IMEs still emit; `isComposing` is the spec field.
    if (event.isComposing || event.keyCode === 229) return true;
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
      if (session.sshConnectionId && enterToRetry && canRetrySsh(session.sshStatus)) {
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

  // AI CLI detector. `readBuffer` gives it the live xterm viewport for
  // screen-content classification; `isAltScreen` lets it auto-clear the
  // active tool the moment the TUI exits back to the main shell buffer.
  const detector = createAiCliDetector({
    onStatus: (status) => {
      session.aiCliStatus = status;
      session.callbacks.onAiCliStatus?.(status);
    },
    readBuffer: () => readTerminalViewport(term),
    isAltScreen: () => term.buffer.active.type === "alternate",
  });
  session.aiCliDetector = detector;
  session.cleanups.push(() => detector.dispose());

  // Route through session.pty so a respawn doesn't need to rebind.
  term.onData((data) => {
    session.aiCliDetector?.pushInput(data);
    session.pty?.write(data);
  });

  // PTY is opened lazily in attachSession after the first fit, so the shell
  // starts with the real terminal size and never flushes a 80x24-sized
  // prompt into scrollback.
  session.ready = (async () => {
    await document.fonts.ready;
    if (session.disposed) return;

    const prompt = registerPromptTracker(term, () => {
      // Shell printed its next prompt: any AI CLI that was active has
      // exited back to the shell. The detector's primary auto-clear
      // path (alt-screen toggle) misses tools that never enter the alt
      // buffer (`claude --help`, `codex login`, `ollama run`, etc.),
      // which would otherwise leave the tab badge stuck.
      session.aiCliDetector?.notifyShellPrompt();
    });
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

/**
 * Push the current xterm dimensions to the live PTY, floored to MIN_PTY_DIM
 * and de-duplicated against `lastSentCols/Rows`. Returns true when an IPC
 * resize was actually issued - used by callers that need to know whether
 * the trip across the bridge happened.
 *
 * Keeping floor + compare + bookkeeping in one place means every callsite
 * (initial attach, mid-life ResizeObserver tick, font-size effect, retry,
 * respawn, SSH reconnect) gets identical behavior. Without this, a pane
 * collapsed to 1×1 during a layout animation could push `cols=1` to the
 * PTY and break the TUI on screen, then never recover because the compare
 * would say "already aligned" once the pane grew back.
 */
function syncPtySize(s: Session): boolean {
  if (!s.pty || s.disposed) return false;
  const cols = Math.max(MIN_PTY_DIM, s.term.cols);
  const rows = Math.max(MIN_PTY_DIM, s.term.rows);
  if (cols === s.lastSentCols && rows === s.lastSentRows) return false;
  s.lastSentCols = cols;
  s.lastSentRows = rows;
  void s.pty.resize(cols, rows);
  return true;
}

function openPtyForSession(s: Session, cwd: string | undefined): Promise<PtySession> {
  // Capture the epoch this open belongs to. Late exit events for a
  // superseded spawn will see `myEpoch !== s.ptySpawnEpoch` and bail out
  // before touching session state owned by the newer spawn.
  s.ptySpawnEpoch += 1;
  const myEpoch = s.ptySpawnEpoch;

  // Fresh decoder per pty so a partial UTF-8 codepoint from a prior shell
  // doesn't leak into the new one.
  const urlDecoder = new TextDecoder("utf-8", { fatal: false });

  // Diagnostic counters - surface when a leaf claims a live PTY but the
  // user sees an empty pane. Toggle via TEDI_DEBUG_PTY=0 in localStorage if
  // it ever gets noisy in production.
  const debug = isDebugPty();
  let firstByteLogged = false;
  let totalBytes = 0;
  const spawnedAtForLog = performance.now();

  const onData = (bytes: Uint8Array) => {
    if (debug && !firstByteLogged) {
      firstByteLogged = true;
      console.info(
        `[tedi-pty] leaf=${s.term.cols}x${s.term.rows} epoch=${myEpoch} first byte after ${Math.round(
          performance.now() - spawnedAtForLog,
        )}ms (${bytes.length}B)`,
      );
    }
    // First real bytes from the shell - record arrival on the session AND
    // disarm any already-armed watchdog. Recording on the session matters
    // when bytes beat the `invoke("pty_open")` resolution: the timer hasn't
    // been armed yet (clearTimeout is a no-op), so `armNoDataWatchdog` will
    // later check `firstByteEpoch` and refuse to arm against a shell that
    // already spoke.
    s.firstByteEpoch = myEpoch;
    if (s.noDataTimer !== null) {
      clearTimeout(s.noDataTimer);
      s.noDataTimer = null;
    }
    totalBytes += bytes.length;
    s.term.write(bytes);
    s.aiCliDetector?.pushOutput(bytes);
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
    if (debug) {
      console.info(
        `[tedi-pty] onExit epoch=${myEpoch} code=${code} totalBytes=${totalBytes} elapsed=${Math.round(performance.now() - spawnedAtForLog)}ms`,
      );
    }
    // Late exit from a pty that's already been replaced -- ignore so we
    // don't clobber the newer spawn's state.
    if (myEpoch !== s.ptySpawnEpoch) return;

    // Spawn-time crash detection: if the PTY died within SPAWN_GRACE_MS of
    // opening with a non-zero exit code, the shell almost certainly failed
    // to initialise (bad ConPTY state, profile script error, transient race
    // with workspace hydration disposing the wrong leaf, etc.). Hold the
    // leaf in place with a retry banner instead of forwarding the exit to
    // App.tsx -- which would close the pane and silently shrink the
    // restored layout.
    const spawnedAt = s.ptySpawnedAt;
    const elapsed = spawnedAt !== null ? Date.now() - spawnedAt : Infinity;
    if (
      !s.disposed &&
      !s.sshConnectionId &&
      spawnedAt !== null &&
      elapsed < SPAWN_GRACE_MS &&
      code !== 0
    ) {
      s.pty = null;
      s.ptySpawnedAt = null;
      s.term.options.disableStdin = false;
      const msg = `shell exited with code ${code} ${elapsed}ms after spawn`;
      s.lastPtyError = msg;
      writePtyError(s, msg);
      return;
    }
    s.term.options.disableStdin = true;
    s.aiCliDetector?.reset();
    if (s.callbacks.onExit) s.callbacks.onExit(code);
    else s.pendingExit = code;
  };

  // Spawn at the floored dimensions for the same reason syncPtySize floors:
  // a pane mid-collapse would otherwise hand the shell a 1×1 viewport and
  // leave most TUIs (nvim/btop/nano) unrecoverable until a resize event
  // happens to fire later.
  const spawnCols = Math.max(MIN_PTY_DIM, s.term.cols);
  const spawnRows = Math.max(MIN_PTY_DIM, s.term.rows);

  if (s.sshConnectionId) {
    return openSshForSession(s, s.sshConnectionId, spawnCols, spawnRows, onData, onExit);
  }

  return withSpawnTimeout(openPty(spawnCols, spawnRows, { onData, onExit }, cwd));
}

/**
 * Rejects with a timeout error if `pty_open` doesn't settle within
 * `SPAWN_TIMEOUT_MS`. Funnels a hung spawn into the existing retry-banner
 * codepath so the leaf stays recoverable with Enter instead of staying a
 * forever-black pane with no input. The race is one-shot: if the underlying
 * promise resolves later (the spawn did eventually complete), we close the
 * stray PTY so Rust doesn't leak the session.
 */
function withSpawnTimeout(p: Promise<PtySession>): Promise<PtySession> {
  return new Promise<PtySession>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`shell did not start within ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s`));
    }, SPAWN_TIMEOUT_MS);
    p.then(
      (pty) => {
        if (settled) {
          void pty.close().catch(() => {});
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(pty);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number) => void,
): Promise<PtySession> {
  // Look up the saved connection metadata + secrets at open time so a
  // password change in settings is picked up on the next reconnect
  // without restarting the app.
  const list = await listConnections();
  const conn: SshConnection | undefined = list.find((c) => c.id === sshConnectionId);
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
  // the reconnect scheduler - russh can fire both onExit and onError for
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
    s.ptySpawnedAt = null;
    scheduleSshReconnect(s, reason);
  };

  // We need both the russh session id (known when `openSsh` resolves) AND
  // the server fingerprint (known when `onConnected` fires) on the
  // `connected` status. The two events aren't strictly ordered: the
  // fingerprint event can land before OR after the open promise resolves.
  // Track both, emit/re-emit as soon as the session id is known so the
  // SFTP panel can wire up immediately, then patch with the fingerprint
  // when (or if) it arrives.
  let pendingFingerprint: string | null = null;
  let resolvedSessionId: number | null = null;
  const emitConnectedIfReady = () => {
    if (resolvedSessionId === null) return;
    s.sshReconnectAttempts = 0;
    emitSshStatus(s, {
      kind: "connected",
      fingerprint: pendingFingerprint ?? "",
      since: Date.now(),
      sessionId: resolvedSessionId,
    });
  };

  const sshSession = await openSsh(
    {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.authMode === "password" ? (secrets.password ?? "") : undefined,
      privateKey: conn.authMode === "key" ? (secrets.privateKey ?? "") : undefined,
      privateKeyPassphrase:
        conn.authMode === "key" ? (secrets.keyPassphrase ?? undefined) : undefined,
      // Pin against the fingerprint recorded by the last successful connect.
      // First-ever connect on this host has no value here and falls through
      // to TOFU; later connects compare and fail fast on mismatch so an
      // attacker swapping the server key can't go unnoticed.
      expectedFingerprint: conn.lastFingerprint || undefined,
      cols,
      rows,
    },
    {
      onConnected: (fp) => {
        writeSshBanner(s, `\x1b[2m[tedi] server key ${fp}\x1b[0m\r\n`);
        pendingFingerprint = fp;
        // Fire-and-forget; failure to write the timestamp shouldn't take
        // the live session down.
        void markConnected(sshConnectionId, fp).catch(() => {});
        emitConnectedIfReady();
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

  resolvedSessionId = sshSession.id;
  emitConnectedIfReady();

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
    s.ptySpawnedAt = Date.now();
    // Only sync once the ResizeObserver is wired (post attachSession);
    // otherwise term.cols/rows still hold pre-fit defaults that would push
    // the wrong size across the bridge before the first measure-pass runs.
    if (s.observer) syncPtySize(s);
  } catch (e) {
    s.ptyOpening = false;
    const msg = describeError(e);
    console.error("ssh reconnect failed:", e);
    if (isHostKeyMismatchError(e)) {
      // Retrying a mismatch can never recover - it'll just fail the same
      // way at the next backoff interval and add noise. Park the leaf in
      // the explicit error state with `canRetry: true` so the user can
      // edit the saved connection (clear lastFingerprint) and trigger a
      // manual retry once they've confirmed the new key is legitimate.
      s.sshReconnectAttempts = 0;
      writeSshBanner(s, `\r\n\x1b[31m[tedi] ${msg}\x1b[0m\r\n`);
      emitSshStatus(s, { kind: "error", message: msg, canRetry: true });
      return;
    }
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
  s.ptySpawnedAt = null;
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
 * Arm the no-data watchdog. Called when a local PTY's open resolves; the
 * watchdog fires if the shell produces no output within `NO_DATA_WATCHDOG_MS`,
 * which happens when ConPTY/profile init silently wedges or the channel
 * delivers the spawn-success ack but no data events. Disarmed by the first
 * `onData` call.
 */
function armNoDataWatchdog(s: Session, epoch: number): void {
  if (s.sshConnectionId) return; // SSH has its own status banner
  // Bytes may have already arrived between `invoke("pty_open")` issuing and
  // its promise resolving - the Tauri Channel's `onmessage` is wired up
  // before the await, so the first data event CAN beat the spawn-result. If
  // that happened for this epoch, the shell is healthy and we must NOT arm:
  // the prompt is already printed and no further bytes are expected until
  // the user types, so a 5s timer would fire on a perfectly working shell.
  if (s.firstByteEpoch === epoch) return;
  if (s.noDataTimer !== null) clearTimeout(s.noDataTimer);
  s.noDataTimer = setTimeout(() => {
    s.noDataTimer = null;
    if (s.disposed) return;
    // Bail if a newer spawn has replaced this one - its own watchdog covers it.
    if (epoch !== s.ptySpawnEpoch) return;
    // Bail if data did arrive between the timer firing and this callback
    // executing (rare but possible under heavy scheduling).
    if (!s.pty) return;
    const dyingPty = s.pty;
    s.pty = null;
    s.ptySpawnedAt = null;
    // Close the orphaned PTY so Rust isn't holding a dead shell forever.
    void dyingPty.close().catch(() => {});
    const msg = `shell did not emit any output within ${Math.round(
      NO_DATA_WATCHDOG_MS / 1000,
    )}s of opening - likely stalled during init`;
    s.lastPtyError = msg;
    console.warn("[tedi-pty] no-data watchdog fired:", msg);
    writePtyError(s, msg);
  }, NO_DATA_WATCHDOG_MS);
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
  // Seed to the values openPtyForSession will actually spawn at (floored)
  // so the post-spawn syncPtySize is a coherent no-op when nothing changed
  // mid-await.
  s.lastSentCols = Math.max(MIN_PTY_DIM, s.term.cols);
  s.lastSentRows = Math.max(MIN_PTY_DIM, s.term.rows);
  let myEpoch = 0;
  try {
    const promise = openPtyForSession(s, s.initialCwd);
    // Captured after openPtyForSession's synchronous epoch bump so a later
    // recovery (or a duplicate retry) won't have its result overwritten by
    // this awaiter when the older spawn finally lands.
    myEpoch = s.ptySpawnEpoch;
    const pty = await promise;
    if (s.disposed) {
      void pty.close().catch(() => {});
      return;
    }
    if (myEpoch !== s.ptySpawnEpoch) {
      void pty.close().catch(() => {});
      return;
    }
    s.ptyOpening = false;
    s.pty = pty;
    s.ptySpawnedAt = Date.now();
    syncPtySize(s);
    armNoDataWatchdog(s, s.ptySpawnEpoch);
  } catch (e) {
    // Drop stale failures (myEpoch === 0 means openPtyForSession threw
    // synchronously before bumping the counter - treat as a real failure).
    if (myEpoch !== 0 && myEpoch !== s.ptySpawnEpoch) return;
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
  const host = (el as Element).closest<HTMLElement>("[data-terminal-leaf-id]");
  if (!host) return null;
  const raw = host.dataset.terminalLeafId;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function respawnSession(leafId: number, cwd?: string): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.pty?.close();
  s.pty = null;
  s.ptySpawnedAt = null;
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
  let myEpoch = 0;
  try {
    const promise = openPtyForSession(s, cwd);
    myEpoch = s.ptySpawnEpoch;
    pty = await promise;
  } catch (e) {
    if (myEpoch !== 0 && myEpoch !== s.ptySpawnEpoch) return;
    s.ptyOpening = false;
    const msg = describeError(e);
    s.lastPtyError = msg;
    console.error("respawnSession: openPty failed:", e);
    writePtyError(s, msg);
    return;
  }
  if (s.disposed) {
    void pty.close().catch(() => {});
    return;
  }
  if (myEpoch !== s.ptySpawnEpoch) {
    void pty.close().catch(() => {});
    return;
  }
  s.ptyOpening = false;
  s.pty = pty;
  s.ptySpawnedAt = Date.now();
  if (s.observer) syncPtySize(s);
  armNoDataWatchdog(s, s.ptySpawnEpoch);
}

function attachSession(leafId: number, container: HTMLDivElement, callbacks: Callbacks): void {
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
    // Same floor as openPtyForSession so post-spawn syncPtySize doesn't
    // double-fire on the first attach when nothing changed mid-await.
    s.lastSentCols = Math.max(MIN_PTY_DIM, s.term.cols);
    s.lastSentRows = Math.max(MIN_PTY_DIM, s.term.rows);
    const debug = isDebugPty();
    const tAttach = performance.now();
    if (debug) {
      console.info(
        `[tedi-pty] attach leaf=${leafId} cols=${s.term.cols} rows=${s.term.rows} containerWxH=${container.clientWidth}x${container.clientHeight} firstAttach=${firstAttach} ssh=${s.sshConnectionId ?? "-"}`,
      );
    }
    const myPromise = openPtyForSession(s, s.initialCwd);
    // openPtyForSession bumps `s.ptySpawnEpoch` synchronously, so the value
    // we read here belongs to this call. The stuck-recovery watchdog can
    // later kick off a `retryPty`, bumping the epoch again; the guards
    // below drop this stale spawn so it doesn't clobber the live state.
    const myEpoch = s.ptySpawnEpoch;
    myPromise
      .then((pty) => {
        if (debug) {
          console.info(
            `[tedi-pty] spawn ok leaf=${leafId} ptyId=${pty.id} after ${Math.round(performance.now() - tAttach)}ms disposed=${s.disposed} stale=${myEpoch !== s.ptySpawnEpoch}`,
          );
        }
        if (s.disposed) {
          void pty.close().catch(() => {});
          return;
        }
        if (myEpoch !== s.ptySpawnEpoch) {
          void pty.close().catch(() => {});
          return;
        }
        s.ptyOpening = false;
        s.pty = pty;
        s.ptySpawnedAt = Date.now();
        syncPtySize(s);
        armNoDataWatchdog(s, s.ptySpawnEpoch);
      })
      .catch((e) => {
        if (myEpoch !== s.ptySpawnEpoch) return;
        s.ptyOpening = false;
        const msg = describeError(e);
        console.error("openPty failed:", e);
        // SSH-bound leaves stay live and run through the backoff scheduler
        // so the user sees consistent reconnect UX whether the failure is
        // a fresh open or a mid-session drop. Local PTY leaves keep the
        // "Press Enter to retry" flow.
        if (s.sshConnectionId) {
          if (isHostKeyMismatchError(e)) {
            // Same reasoning as in runSshReconnect: spinning the backoff
            // loop on a mismatch never recovers. Park in `error` so the
            // status pill can offer "Disconnect" and the user can fix the
            // saved fingerprint before retrying.
            s.sshReconnectAttempts = 0;
            writeSshBanner(s, `\r\n\x1b[31m[tedi] ${msg}\x1b[0m\r\n`);
            emitSshStatus(s, { kind: "error", message: msg, canRetry: true });
            return;
          }
          writeSshBanner(s, `\r\n\x1b[31m[tedi] ssh connect failed: ${msg}\x1b[0m\r\n`);
          scheduleSshReconnect(s, msg);
          return;
        }
        s.lastPtyError = msg;
        writePtyError(s, msg);
      });
  } else if (s.pty) {
    syncPtySize(s);
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
  //  - PTY_RESIZE (SIGWINCH) is throttled because shells / fancy prompts
  //    (powerlevel10k, starship) redraw on every WINCH and that reads as
  //    blinking. BUT the previous 256 ms trailing-only setting was too
  //    long: during a split-handle drag the xterm viewport already paints
  //    at the new cols while the shell is still writing at the old width,
  //    causing visible overlap, mid-line wrap, and broken TUI panels
  //    (nvim/btop/nano need WINCH to clear+redraw their alt-screen
  //    buffer). Two thresholds now:
  //      - NORMAL prompt buffer → 90 ms (still trailing): the shell's
  //        edit line stays coherent and prompts don't strobe.
  //      - ALT-screen buffer (TUI active) → leading + 40 ms trailing:
  //        emit WINCH on the first frame so the TUI starts its redraw
  //        immediately, then again on the last frame for the final size.
  const FIT_DEBOUNCE_MS = 8;
  const PTY_RESIZE_DEBOUNCE_NORMAL_MS = 90;
  const PTY_RESIZE_DEBOUNCE_ALT_MS = 40;
  // Min gap between leading-edge WINCH emits while a drag is in flight.
  // Keeps a 60Hz ResizeObserver storm from flooding the shell with one
  // SIGWINCH per frame.
  const PTY_RESIZE_ALT_LEADING_THROTTLE_MS = 80;

  const flushPtyResize = () => {
    s.ptyTimer = null;
    syncPtySize(s);
  };

  let lastAltLeadingAt = 0;
  const isAltActive = () => {
    try {
      return s.term.buffer.active.type === "alternate";
    } catch {
      return false;
    }
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
      const alt = isAltActive();
      // Leading-edge SIGWINCH for TUIs: redraw starts on frame 1 instead
      // of waiting for drag-end. Throttled so a stream of pixel-by-pixel
      // ResizeObserver ticks doesn't spam the shell.
      if (alt) {
        const now = performance.now();
        if (now - lastAltLeadingAt >= PTY_RESIZE_ALT_LEADING_THROTTLE_MS) {
          lastAltLeadingAt = now;
          syncPtySize(s);
        }
      }
      const debounceMs = alt ? PTY_RESIZE_DEBOUNCE_ALT_MS : PTY_RESIZE_DEBOUNCE_NORMAL_MS;
      if (s.ptyTimer) clearTimeout(s.ptyTimer);
      s.ptyTimer = setTimeout(flushPtyResize, debounceMs);
    }, FIT_DEBOUNCE_MS);
  });
  s.observer.observe(container);

  // Re-sync App state after re-attach (prior detach cleared callbacks).
  if (s.lastCwd !== null) callbacks.onCwd?.(s.lastCwd);
  if (s.lastDetectedUrl !== null) callbacks.onDetectedLocalUrl?.(s.lastDetectedUrl);
  callbacks.onSearchReady?.(s.searchAddon);
  if (s.sshConnectionId) {
    // Re-emit the latest known status so the pill/dot redraw correctly after
    // a split or workspace-switch reattaches the leaf to a fresh App tree.
    callbacks.onSshStatus?.(s.sshStatus);
  }
  // Same idea for AI CLI status: replay so the tab dot survives reattach.
  // Also replay when null - covers the "tool exited while detached" case
  // (e.g. mid-split), where the App-level Map would otherwise stay stuck on
  // the last "blocking" entry. The handler dedups so a null-then-null is
  // a no-op when nothing changed.
  callbacks.onAiCliStatus?.(s.aiCliStatus);
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
  if (s.noDataTimer) clearTimeout(s.noDataTimer);
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
  /** Fires when a known AI CLI tool starts / changes state / exits in this leaf. */
  onAiCliStatus?: (status: AiCliStatus) => void;
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
  onAiCliStatus,
}: Options) {
  const cbRef = useRef({
    onSearchReady,
    onExit,
    onCwd,
    onDetectedLocalUrl,
    onTediOpen,
    onTediSpawnTab,
    onSshStatus,
    onAiCliStatus,
  });
  cbRef.current = {
    onSearchReady,
    onExit,
    onCwd,
    onDetectedLocalUrl,
    onTediOpen,
    onTediSpawnTab,
    onSshStatus,
    onAiCliStatus,
  };

  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    let attachIntervalId: ReturnType<typeof setInterval> | null = null;
    let stuckTimer: ReturnType<typeof setTimeout> | null = null;
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
      onAiCliStatus: (status) => cbRef.current.onAiCliStatus?.(status),
    };
    // Wait for the container ref to be set. In normal mounts this is
    // already truthy by the time s.ready resolves, but split/unsplit and
    // strict-mode double-mount can briefly null it; retry a few frames
    // before giving up so we don't end up with a tab that has no shell.
    //
    // Bumped from 30 to 120 frames (~2s) because workspace-restore mounts
    // several panes through react-resizable-panels at once, and on slower
    // machines the inner ResizablePanel's measure-pass ran past the old
    // 30-frame budget for one of the leaves -- leaving that pane with a
    // mounted xterm but no PTY (silent blank). After the rAF budget is
    // exhausted, fall back to a 250ms poll until cleanup runs, so a
    // genuinely-late mount still recovers instead of staying permanently
    // blank.
    const MAX_ATTACH_FRAMES = 120;
    const ATTACH_FALLBACK_INTERVAL_MS = 250;
    const tryAttach = (framesLeft: number) => {
      if (cancelled) return;
      if (container.current) {
        attachSession(leafId, container.current, callbacks);
        if (visible && focused) s.term.focus();
        return;
      }
      if (framesLeft <= 0) {
        console.warn(
          `useTerminalSession: container ref never settled for leaf ${leafId} within ${MAX_ATTACH_FRAMES} frames; falling back to interval poll`,
        );
        attachIntervalId = setInterval(() => {
          if (cancelled) {
            if (attachIntervalId !== null) {
              clearInterval(attachIntervalId);
              attachIntervalId = null;
            }
            return;
          }
          if (!container.current) return;
          if (attachIntervalId !== null) {
            clearInterval(attachIntervalId);
            attachIntervalId = null;
          }
          attachSession(leafId, container.current, callbacks);
          if (visible && focused) s.term.focus();
        }, ATTACH_FALLBACK_INTERVAL_MS);
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
        // actually visible - writes to a detached xterm buffer in memory
        // but the user can't see them.
        if (cancelled) return;
        const msg = describeError(e);
        s.lastPtyError = msg;
        console.error("session ready failed:", e);
        writePtyError(s, msg);
        tryAttach(MAX_ATTACH_FRAMES);
      });

    // Stuck-recovery watchdog: see STUCK_RECOVERY_MS for the failure mode.
    // Fires once; if the leaf is still healthy by then we no-op. If
    // attachSession's spawn is mid-flight (ptyOpening=true, no error yet),
    // we cancel the stale opening and force a fresh retry - the epoch
    // guards in attachSession/retryPty drop the late stale result if it
    // ever lands.
    stuckTimer = setTimeout(() => {
      stuckTimer = null;
      if (cancelled || s.disposed) return;
      if (s.pty) return; // healthy
      if (s.lastPtyError !== null) return; // Enter-to-retry handles it
      console.warn(
        `[tedi-pty] stuck-recovery: leaf=${leafId} pty=null lastPtyError=null ptyOpening=${s.ptyOpening} sshConn=${s.sshConnectionId ?? "-"} sshStatus=${s.sshStatus.kind} containerAttached=${s.term.element !== undefined} after ${STUCK_RECOVERY_MS}ms - forcing retry`,
      );
      // Reset the opening flag so retryPty/retrySsh aren't blocked by a
      // hung in-flight promise.
      s.ptyOpening = false;
      if (s.sshConnectionId) {
        // SSH state machine drives its own reconnect; only intervene when
        // we haven't even started a connect attempt yet (idle).
        if (s.sshStatus.kind === "idle") {
          void retrySsh(s);
        }
      } else {
        void retryPty(s);
      }
    }, STUCK_RECOVERY_MS);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (attachIntervalId !== null) {
        clearInterval(attachIntervalId);
        attachIntervalId = null;
      }
      if (stuckTimer !== null) clearTimeout(stuckTimer);
      detachSession(leafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId]);

  const baseFontSize = usePreferencesStore((p) => p.terminalFontSize);
  const contentZoom = usePreferencesStore((p) => p.contentZoom);
  const fontSize = effectiveTerminalFontSize(baseFontSize, contentZoom);
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
    syncPtySize(s);
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
    // Bridge the PTY size across the visibility flip. ResizeObserver only
    // fires on dimension changes, and `visibility: hidden` -> `visible`
    // preserves layout dimensions -- so without this, a session that fit
    // at the wrong size while hidden would never push the corrected
    // cols/rows to the shell on show.
    syncPtySize(s);
    if (focused) s.term.focus();
  }, [leafId, visible, focused]);

  const write = useCallback((data: string) => sessions.get(leafId)?.pty?.write(data), [leafId]);

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

  /**
   * Hand a string to xterm as a paste rather than raw bytes. Going through
   * `term.paste` instead of `pty.write` matters when the shell has bracketed
   * paste mode on (most modern setups: zsh+zle, bash 4.4+ readline, fish,
   * pwsh PSReadLine): xterm wraps the payload in `\e[200~ … \e[201~`, the
   * shell treats it as one literal block, and editors/REPLs avoid
   * interpreting embedded newlines as Enter-to-execute. Raw `pty.write`
   * skips that wrapper and would, e.g., immediately run every line of a
   * multi-line snippet pasted into bash.
   */
  const paste = useCallback((data: string) => sessions.get(leafId)?.term.paste(data), [leafId]);

  const applyTheme = useCallback(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.term.options.theme = buildTerminalTheme();
  }, [leafId]);

  return { write, focus, getBuffer, getSelection, paste, applyTheme };
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
