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
import { openPty, reattachPty, type PtySession } from "./pty-bridge";
import {
  getConnectionSecrets,
  listConnections,
  markConnected,
  type SshConnection,
} from "@/modules/ssh/connections";
import { openSsh, isHostKeyMismatchError } from "@/modules/ssh/bridge";
import type { SshStatus } from "@/modules/ssh/status";
import {
  createAiCliDetector,
  cursorLineLooksLikeShellPrompt,
  type AiCliDetector,
} from "./aiCliDetector";
import type { AiCliStatus } from "./aiCliStatus";

export type { TediOpenInput, TediSpawnTabInput };

const BACKWARD_KILL_WORD = "\x17";
const SHIFT_ENTER = "\x1b\r";

// Floor for sizes pushed to the PTY. FitAddon can return 0x0 or 1x1 during
// layout transitions; TUIs break at those sizes. 2x2 is the smallest size
// every supported TUI tolerates.
const MIN_PTY_DIM = 2;

const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;

// PTY exits within this window after spawn are treated as init crashes
// (ConPTY race, profile script error) rather than user `exit`. Hold the
// leaf with a retry banner instead of closing the pane.
const SPAWN_GRACE_MS = 3_000;

// Hard ceiling on `pty_open`. Workspace restore on Windows can wedge with the
// promise never settling, leaving the leaf with `pty=null` AND `lastPtyError=null`
// so Enter-to-retry can't fire. After this many ms we force the retry-banner
// path. Local spawns normally complete in <300ms.
const SPAWN_TIMEOUT_MS = 15_000;

/** PTY lifecycle debug toggle. Default on; set `localStorage.TEDI_DEBUG_PTY = "0"` to silence. */
function isDebugPty(): boolean {
  try {
    return localStorage.getItem("TEDI_DEBUG_PTY") !== "0";
  } catch {
    return true;
  }
}

/**
 * After `pty_open` resolves, no bytes within this window means the shell
 * stalled. Surface as a retry-able error. 8s (was 5s) tolerates slow Windows
 * pwsh user-profile loads that import many modules before the first prompt.
 */
const NO_DATA_WATCHDOG_MS = 8_000;

/**
 * Last-resort recovery for the silent-blank failure mode where attachSession
 * never runs or `s.ready` stays pending. Fires only when there's no live
 * PTY, no pending error, AND no in-flight spawn - an in-flight spawn that
 * is just queued behind `SPAWN_LOCK` in Rust is legitimate progress and
 * `SPAWN_TIMEOUT_MS` already covers genuinely hung pty_open invokes. Sits
 * above worst-case `SPAWN_LOCK` queueing (3-5 splits stacking 1-2.5s of
 * ConPTY init on Windows) and below `SPAWN_TIMEOUT_MS` (15s).
 */
const STUCK_RECOVERY_MS = 12_000;

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onTediOpen?: (input: TediOpenInput) => void;
  onTediSpawnTab?: (input: TediSpawnTabInput) => void;
  /** Emitted for SSH-bound leaves. Drives the tab dot and status pill. */
  onSshStatus?: (status: SshStatus) => void;
  /** Emitted on AI CLI detection/state change. */
  onAiCliStatus?: (status: AiCliStatus) => void;
  /**
   * Fires once whenever the session acquires a daemon-side PTY id (on
   * successful `openPty` or `reattachPty`). The caller persists this onto
   * the leaf state so the workspace serializer can save it for restore.
   * Empty string means the in-process backend is in use (non-restorable).
   */
  onPtyId?: (ptyId: string) => void;
};

const RECONNECT_BACKOFF_MS = [1_000, 3_000, 7_000] as const;
const MAX_SSH_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

// Lives outside React so split/unsplit can re-parent the DOM without
// disposing the term or PTY. Real disposal happens in `disposeSession`.
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
  /** Bound saved SSH connection id, if any. */
  sshConnectionId: string | undefined;
  /**
   * Daemon-side PTY UUID from a prior GUI launch. When set,
   * `openPtyForSession` calls `reattachPty` first and falls back to
   * `openPty` only on attach failure. Cleared after the first spawn
   * resolves so a user-initiated retry / respawn doesn't reuse a stale
   * UUID (which would race the daemon's killing of the original).
   */
  savedPtyId: string | undefined;
  ptyOpening: boolean;
  /** Last error from a failed `openPtyForSession`. Drives Enter-to-retry. */
  lastPtyError: string | null;
  /** Wall-clock ms when the current PTY spawn resolved. Used with `SPAWN_GRACE_MS`. */
  ptySpawnedAt: number | null;
  /** Monotonic counter bumped per spawn. Used to ignore exit events from superseded PTYs. */
  ptySpawnEpoch: number;
  /** Watchdog for the no-bytes-after-open case. Cleared by the first byte. */
  noDataTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Spawn epoch that has already received its first byte. Prevents
   * `armNoDataWatchdog` from arming against a shell that printed its prompt
   * before `invoke("pty_open")` resolved.
   */
  firstByteEpoch: number;
  /**
   * "[tedi] starting shell…" placeholder is currently visible in the term
   * buffer. Cleared (via `\x1b[H\x1b[2J`) on the next PTY byte so the shell
   * paints onto a clean viewport instead of leaving the dim hint as
   * scrollback. Eliminates the perceived "blank pane" between attach and
   * first shell output, especially on Windows where ConPTY + pwsh profile
   * can take 200-1000ms before emitting anything.
   */
  placeholderShown: boolean;
  // SSH-only fields. Ignored on local PTY leaves.
  /** Latest emitted SSH status. */
  sshStatus: SshStatus;
  /** Set when the user closed the SSH session, so auto-reconnect skips. */
  sshUserClose: boolean;
  /** Current reconnect attempt number (1-based). */
  sshReconnectAttempts: number;
  /** Pending reconnect timer. */
  sshReconnectTimer: ReturnType<typeof setTimeout> | null;
  // AI CLI detection.
  /** Detector instance. */
  aiCliDetector: AiCliDetector | null;
  /** Latest emitted AI CLI status. Replayed on re-attach. */
  aiCliStatus: AiCliStatus;
};

const sessions = new Map<number, Session>();

/**
 * Snapshot the visible xterm viewport as newline-joined text in original
 * case. Returns "" on any buffer API error so a mid-reflow throw doesn't
 * kill the detector loop.
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
 * Compose base terminal font size with content-zoom, clamped to xterm bounds.
 * Scaling via xterm's `fontSize` triggers its internal recompute; CSS `zoom`
 * would leave the canvas at the old resolution.
 */
function effectiveTerminalFontSize(base: number, zoom: number): number {
  const raw = Math.round(base * (Number.isFinite(zoom) ? zoom : 1));
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, raw));
}

/**
 * True when the terminal canvas should be semi-transparent, i.e. the single
 * "App opacity" control is active (`data-tedi-glass`). Drives the switch to
 * the DOM renderer + an rgba background (the WebGL renderer dims foreground
 * glyphs when the background has alpha < 1, xterm.js #4054).
 */
function wallpaperActive(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.tediGlass === "on";
}

/**
 * Toggle the WebGL renderer in/out depending on whether a wallpaper is
 * active. The WebGL renderer in `@xterm/addon-webgl` has a known issue
 * (xterm.js #4054) where an rgba `theme.background` causes the
 * foreground glyphs to be alpha-multiplied too. The DOM renderer paints
 * each cell as a `<span>` with independent `background-color` and
 * `color`, so text stays fully opaque while the cell background can be
 * semi-transparent. We dispose WebGL when the wallpaper turns on and
 * re-load it when the wallpaper turns off (only if the user pref allows).
 */
function syncRendererForWallpaper(s: Session): void {
  const wantWebgl = s.webglEnabled && !wallpaperActive();
  if (wantWebgl && !s.webglAddon) {
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
  } else if (!wantWebgl && s.webglAddon) {
    try {
      s.webglAddon.dispose();
    } catch {
      /* ignore */
    }
    s.webglAddon = null;
  }
}

// Live-refresh every terminal's rgba background when the "App opacity" slider
// moves (`appOpacity.ts` dispatches `tedi:canvas-opacity`). rAF-throttled so a
// fast drag re-themes at most once per frame, and the renderer only toggles
// when crossing the glass on/off edge (not during a 0..1 drag). Keeps the
// terminal in sync with the CSS surfaces without a write/IPC per pixel.
// Guard against duplicate registration. This is a module-level singleton, but
// a dev HMR re-eval (or any re-import) would otherwise stack a second listener
// that keeps another closure over the `sessions` Map alive. The flag makes the
// bind idempotent.
const opacityWin =
  typeof window !== "undefined"
    ? (window as Window & { __tediCanvasOpacityBound?: boolean })
    : null;
if (opacityWin && !opacityWin.__tediCanvasOpacityBound) {
  opacityWin.__tediCanvasOpacityBound = true;
  let scheduled = false;
  window.addEventListener("tedi:canvas-opacity", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const s of sessions.values()) {
        syncRendererForWallpaper(s);
        s.term.options.theme = buildTerminalTheme();
        s.term.refresh(0, s.term.rows - 1);
      }
    });
  });
}

function ensureSession(
  leafId: number,
  initialCwd?: string,
  sshConnectionId?: string,
  savedPtyId?: string,
): Session {
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
    // 5k lines x 80 cols x ~16 B per cell ≈ 6 MB per leaf.
    scrollback: 5_000,
    allowProposedApi: true,
    // Required so the WebGL renderer honours an rgba `theme.background` and
    // lets the Theme tab's wallpaper bleed through the terminal canvas.
    allowTransparency: true,
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
    savedPtyId,
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
    placeholderShown: false,
  };
  sessions.set(leafId, session);

  term.attachCustomKeyEventHandler((event) => {
    // IME composition: let the browser/IME handle it. Otherwise Ctrl+Backspace
    // mid-composition injects \x17 and corrupts both IME and screen state.
    if (event.isComposing || event.keyCode === 229) return true;
    const pty = session.pty;
    if (!pty) {
      // No live shell. Enter retries open after a prior failure (local PTY
      // or SSH after auto-reconnect exhaustion).
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

  // AI CLI detector. `readBuffer` provides the viewport; `isAltScreen` auto-clears on TUI exit.
  const detector = createAiCliDetector({
    onStatus: (status) => {
      session.aiCliStatus = status;
      session.callbacks.onAiCliStatus?.(status);
    },
    readBuffer: () => readTerminalViewport(term),
    isAltScreen: () => term.buffer.active.type === "alternate",
    readCursorLine: () => {
      try {
        const buf = term.buffer.active;
        const line = buf.getLine(buf.baseY + buf.cursorY);
        return line ? line.translateToString(true) : "";
      } catch {
        return "";
      }
    },
  });
  session.aiCliDetector = detector;
  session.cleanups.push(() => detector.dispose());

  // Route through session.pty so respawn doesn't rebind. Capture the
  // disposable and release it in `disposeSession` (via cleanups) so the
  // closure over `session` isn't retained between dispose and GC - matches
  // the prompt/cwd/osc handlers pushed below.
  const onDataDisposable = term.onData((data) => {
    session.aiCliDetector?.pushInput(data);
    session.pty?.write(data);
  });
  session.cleanups.push(() => onDataDisposable.dispose());

  // PTY opens lazily after the first fit so the shell starts at the real terminal size.
  session.ready = (async () => {
    await document.fonts.ready;
    if (session.disposed) return;

    const prompt = registerPromptTracker(term, () => {
      // New shell prompt means any active AI CLI exited. Covers tools that never enter the alt buffer.
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
 * Push xterm dimensions to the live PTY, floored to MIN_PTY_DIM and
 * deduplicated against `lastSentCols/Rows`. Returns true when an IPC resize
 * was issued. Central to every callsite so behavior stays consistent.
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
  // Capture spawn epoch. Late exit events for a superseded spawn bail before mutating newer state.
  s.ptySpawnEpoch += 1;
  const myEpoch = s.ptySpawnEpoch;

  // Fresh decoder per pty so partial UTF-8 from a prior shell doesn't leak.
  const urlDecoder = new TextDecoder("utf-8", { fatal: false });

  // Diagnostic counters for the live-PTY-but-empty-pane case. Toggle via TEDI_DEBUG_PTY.
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
    // First bytes from the shell. Disarm the watchdog and record the epoch
    // so `armNoDataWatchdog` won't arm against a shell that already spoke.
    s.firstByteEpoch = myEpoch;
    if (s.noDataTimer !== null) {
      clearTimeout(s.noDataTimer);
      s.noDataTimer = null;
    }
    // Clear the "starting shell…" placeholder before the shell's first
    // paint so it doesn't linger above the prompt as scrollback. Soft reset
    // (cursor home + erase display) keeps SGR/cursor state owned by the
    // shell's own output.
    if (s.placeholderShown) {
      s.placeholderShown = false;
      s.term.write("\x1b[H\x1b[2J");
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
    // Late exit from a replaced pty. Ignore to avoid clobbering newer state.
    if (myEpoch !== s.ptySpawnEpoch) return;

    // Spawn-time crash detection. PTY death within SPAWN_GRACE_MS with non-zero
    // exit means init failed. Hold the leaf with a retry banner instead of closing.
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

  // Spawn at floored dimensions so a mid-collapse pane doesn't hand the shell a 1x1 viewport.
  const spawnCols = Math.max(MIN_PTY_DIM, s.term.cols);
  const spawnRows = Math.max(MIN_PTY_DIM, s.term.rows);

  if (s.sshConnectionId) {
    return openSshForSession(s, s.sshConnectionId, spawnCols, spawnRows, onData, onExit);
  }

  // Restore path: a saved daemon UUID exists. Try `reattachPty` first. Two
  // ways it can miss, both ending in a fresh spawn at the saved cwd:
  //   1. `reattachPty` rejects - the daemon lost the session entirely
  //      (daemon crash or PC reboot since the workspace was saved).
  //   2. `reattachPty` resolves but `alive === false` - the daemon still
  //      holds the session, but its shell already exited while this GUI was
  //      detached. Reattaching it would only replay frozen scrollback into a
  //      pane that can't take input (the "blank tab that never opens a
  //      terminal" symptom). Discard it and spawn fresh so the tab works.
  // Either way the UUID is consumed - later retries / respawns go through
  // `openPty`. Done in one async fn (not a `.catch` after `.then`) so the
  // fresh-spawn fallback can't be double-fired by the reattach branch.
  const reattachId = s.savedPtyId;
  if (reattachId) {
    s.savedPtyId = undefined;
    return withSpawnTimeout(
      (async (): Promise<PtySession> => {
        let attached: PtySession;
        try {
          attached = await reattachPty(reattachId, spawnCols, spawnRows, { onData, onExit });
        } catch (e) {
          if (isDebugPty()) {
            console.info(
              `[tedi-pty] reattach failed for ${reattachId}, falling back to fresh spawn: ${describeError(e)}`,
            );
          }
          return openPty(spawnCols, spawnRows, { onData, onExit }, cwd);
        }
        if (attached.alive === false) {
          if (isDebugPty()) {
            console.info(
              `[tedi-pty] reattach ${reattachId} resolved dead (shell already exited); respawning fresh`,
            );
          }
          // Tell the daemon to drop the dead session (also reaps its
          // scrollback) and wipe the replayed dead output so the fresh
          // shell paints onto a clean viewport.
          void attached.close().catch(() => {});
          s.term.reset();
          s.placeholderShown = false;
          // The dead session's replayed scrollback already stamped
          // `firstByteEpoch` for this spawn epoch, which would suppress the
          // no-data watchdog for the fresh shell. Clear it so the watchdog
          // can still catch a fresh spawn that stalls during init.
          s.firstByteEpoch = 0;
          return openPty(spawnCols, spawnRows, { onData, onExit }, cwd);
        }
        return attached;
      })(),
    );
  }

  return withSpawnTimeout(openPty(spawnCols, spawnRows, { onData, onExit }, cwd));
}

/**
 * Rejects with a timeout error if `pty_open` doesn't settle within
 * `SPAWN_TIMEOUT_MS`. Funnels a hung spawn into the retry-banner path. If
 * the promise resolves later, closes the stray PTY so Rust doesn't leak it.
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
  // Look up connection metadata at open time so settings changes are picked up on the next reconnect.
  const list = await listConnections();
  const conn: SshConnection | undefined = list.find((c) => c.id === sshConnectionId);
  if (!conn) {
    throw new Error(`ssh: connection "${sshConnectionId}" not found`);
  }
  const secrets = await getConnectionSecrets(sshConnectionId);

  // `sshReconnectAttempts` is bumped by `scheduleSshReconnect`. 0 means first open.
  const attempt = Math.max(1, s.sshReconnectAttempts);
  emitSshStatus(s, { kind: "connecting", attempt });
  writeSshBanner(
    s,
    `\x1b[2m[tedi] connecting to ${conn.user}@${conn.host}:${conn.port}…\x1b[0m\r\n`,
  );

  // Route the first of onExit/onError into the reconnect scheduler; russh can fire both.
  let terminated = false;
  const handleTerminal = (reason: string) => {
    if (terminated) return;
    terminated = true;
    if (s.disposed) return;
    // SSH dropped. Reset the AI CLI detector so its state doesn't ghost into the next reconnect.
    s.aiCliDetector?.reset();
    if (s.sshUserClose) {
      emitSshStatus(s, {
        kind: "disconnected",
        reason: "closed by user",
        canRetry: true,
      });
      onExit(0);
      return;
    }
    // Drop the live handle so attachSession/retrySsh treat the leaf as "needs spawn".
    s.pty = null;
    s.ptySpawnedAt = null;
    scheduleSshReconnect(s, reason);
  };

  // Need both russh session id (from openSsh) and server fingerprint (from onConnected).
  // The two events can land in either order, so emit on session id and re-emit when fingerprint arrives.
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
      // Pin against the last recorded fingerprint. First connect is TOFU; later connects fail fast on mismatch.
      expectedFingerprint: conn.lastFingerprint || undefined,
      cols,
      rows,
    },
    {
      onConnected: (fp) => {
        writeSshBanner(s, `\x1b[2m[tedi] server key ${fp}\x1b[0m\r\n`);
        pendingFingerprint = fp;
        // Fire-and-forget. Timestamp write failure shouldn't break the session.
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

  // Adapter so SSH looks like a PtySession to the rest of the file. SSH
  // sessions are not persisted via daemon UUIDs (`pty_attach` is local
  // PTY only), so `sessionId` is empty - serialize.ts skips ptyId for
  // SSH leaves.
  return {
    id: sshSession.id,
    sessionId: "",
    alive: true,
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
    // Only sync after the ResizeObserver is wired. Pre-fit defaults would push the wrong size.
    if (s.observer) syncPtySize(s);
  } catch (e) {
    s.ptyOpening = false;
    const msg = describeError(e);
    console.error("ssh reconnect failed:", e);
    if (isHostKeyMismatchError(e)) {
      // Fingerprint mismatches can't auto-recover. Park in error so the user can
      // edit the saved connection (clear lastFingerprint) and retry manually.
      s.sshReconnectAttempts = 0;
      writeSshBanner(s, `\r\n\x1b[31m[tedi] ${msg}\x1b[0m\r\n`);
      emitSshStatus(s, { kind: "error", message: msg, canRetry: true });
      return;
    }
    scheduleSshReconnect(s, msg);
  }
}

/** Manually re-arm a disconnected SSH leaf. Resets the attempt counter for a fresh 3-attempt window. */
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
  s.placeholderShown = false;
  s.term.options.disableStdin = false;
  await runSshReconnect(s);
}

/** User-initiated SSH close. Sets the user-close flag so the exit handler skips auto-reconnect. */
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

/** Status pill "Reconnect" handle. */
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
  s.placeholderShown = false;
  s.term.options.disableStdin = false;
  s.term.write(
    "\x1b[31m\x1b[1m[tedi] failed to start shell\x1b[0m\r\n" +
      `\x1b[31m${message.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n\r\n` +
      "\x1b[2mPress Enter to retry, or close the tab.\x1b[0m\r\n",
  );
}

/**
 * Arm the no-data watchdog after a local PTY's open resolves. Fires when
 * the shell produces no output within `NO_DATA_WATCHDOG_MS`. Disarmed by
 * the first `onData`.
 */
function armNoDataWatchdog(s: Session, epoch: number): void {
  if (s.sshConnectionId) return; // SSH has its own status banner
  // First byte may have arrived before `pty_open` resolved (channel onmessage is
  // wired before the await). Don't arm in that case; the shell is already healthy.
  if (s.firstByteEpoch === epoch) return;
  if (s.noDataTimer !== null) clearTimeout(s.noDataTimer);
  s.noDataTimer = setTimeout(() => {
    s.noDataTimer = null;
    if (s.disposed) return;
    // Bail if a newer spawn has replaced this one.
    if (epoch !== s.ptySpawnEpoch) return;
    // Bail if bytes arrived between timer fire and callback.
    if (!s.pty) return;
    const dyingPty = s.pty;
    s.pty = null;
    s.ptySpawnedAt = null;
    // Close the orphaned PTY so Rust doesn't leak it.
    void dyingPty.close().catch(() => {});
    const msg = `shell did not emit any output within ${Math.round(
      NO_DATA_WATCHDOG_MS / 1000,
    )}s of opening - likely stalled during init`;
    s.lastPtyError = msg;
    console.warn("[tedi-pty] no-data watchdog fired:", msg);
    writePtyError(s, msg);
  }, NO_DATA_WATCHDOG_MS);
}

/** Retry a PTY spawn. Wired to Enter for recovery. No-op if opening, alive, or disposed. */
async function retryPty(s: Session): Promise<void> {
  if (s.disposed) return;
  if (s.pty) return;
  if (s.ptyOpening) return;
  s.ptyOpening = true;
  s.lastPtyError = null;
  s.term.reset();
  s.term.options.disableStdin = false;
  s.term.write("\x1b[2m[tedi] retrying…\x1b[0m\r\n");
  // Treat the retrying hint as the new placeholder so the first PTY byte
  // wipes it instead of leaving "retrying…" stuck above the prompt.
  s.placeholderShown = true;
  // Seed to the values openPtyForSession spawns at (floored) so post-spawn syncPtySize no-ops.
  s.lastSentCols = Math.max(MIN_PTY_DIM, s.term.cols);
  s.lastSentRows = Math.max(MIN_PTY_DIM, s.term.rows);
  let myEpoch = 0;
  try {
    const promise = openPtyForSession(s, s.initialCwd);
    // Captured after the synchronous epoch bump so a later recovery won't be overwritten.
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
    // Drop stale failures. myEpoch === 0 means synchronous throw before counter bump.
    if (myEpoch !== 0 && myEpoch !== s.ptySpawnEpoch) return;
    s.ptyOpening = false;
    const msg = describeError(e);
    s.lastPtyError = msg;
    console.error("retryPty: openPty failed:", e);
    writePtyError(s, msg);
  }
}

/** Write raw bytes to a leaf's PTY without React state. Returns false if no live PTY. */
export function writeToLeaf(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || !s.pty) return false;
  s.pty.write(data);
  s.term.focus();
  return true;
}

/** Hit-test at a CSS-pixel point and return the enclosing terminal leaf id, or null. */
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
  s.placeholderShown = false;
  s.term.options.disableStdin = false;
  s.lastSentCols = 0;
  s.lastSentRows = 0;
  s.lastDetectedUrl = null;
  s.pendingExit = null;
  // Hold the flag so attachSession can't open a second PTY mid-await.
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

  // Fit before WebGL and PTY open so renderer and shell start at the right size.
  s.fitAddon.fit();
  s.lastW = container.clientWidth;
  s.lastH = container.clientHeight;

  if (firstAttach && !s.webglAddon && s.webglEnabled && !wallpaperActive()) {
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
    // Same floor as openPtyForSession so post-spawn syncPtySize no-ops on first attach.
    s.lastSentCols = Math.max(MIN_PTY_DIM, s.term.cols);
    s.lastSentRows = Math.max(MIN_PTY_DIM, s.term.rows);
    // Immediate visual feedback so the user doesn't see a blank pane while
    // ConPTY initializes and the shell loads its profile. SSH leaves get
    // their own "[tedi] connecting to …" banner from `openSshForSession`,
    // so skip the placeholder there. Cleared by `onData` on the first byte.
    if (firstAttach && !s.sshConnectionId && !s.placeholderShown) {
      s.placeholderShown = true;
      s.term.write("\x1b[2m[tedi] starting shell…\x1b[0m");
    }
    const debug = isDebugPty();
    const tAttach = performance.now();
    if (debug) {
      console.info(
        `[tedi-pty] attach leaf=${leafId} cols=${s.term.cols} rows=${s.term.rows} containerWxH=${container.clientWidth}x${container.clientHeight} firstAttach=${firstAttach} ssh=${s.sshConnectionId ?? "-"}`,
      );
    }
    const myPromise = openPtyForSession(s, s.initialCwd);
    // Capture spawn epoch. Stuck-recovery may retry and bump it; guards below drop stale spawns.
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
        // Stamp the daemon UUID onto the leaf so the workspace serializer
        // picks it up on the next save. Empty `sessionId` means the
        // in-process backend ran the spawn (non-restorable); the leaf's
        // `ptyId` stays undefined and serialize.ts skips persistence.
        if (pty.sessionId) s.callbacks.onPtyId?.(pty.sessionId);
      })
      .catch((e) => {
        if (myEpoch !== s.ptySpawnEpoch) return;
        s.ptyOpening = false;
        const msg = describeError(e);
        console.error("openPty failed:", e);
        // SSH leaves use the backoff scheduler. Local PTY uses Enter-to-retry.
        if (s.sshConnectionId) {
          if (isHostKeyMismatchError(e)) {
            // Fingerprint mismatch can't auto-recover. Park in error so the user can fix the saved fingerprint.
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
  //  - FIT every frame; local, no IPC.
  //  - PTY_RESIZE (SIGWINCH) throttled:
  //      Normal buffer: 90ms trailing so prompts don't strobe.
  //      Alt-screen (TUI active): leading + 40ms trailing so the TUI starts
  //      redrawing on frame 1 and finishes at the final size.
  const FIT_DEBOUNCE_MS = 8;
  const PTY_RESIZE_DEBOUNCE_NORMAL_MS = 90;
  const PTY_RESIZE_DEBOUNCE_ALT_MS = 40;
  // Min gap between leading-edge WINCH emits. Caps the SIGWINCH rate during drag.
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
      // Leading-edge SIGWINCH for TUIs so redraw starts on frame 1. Throttled.
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

  // Re-sync App state after re-attach. Prior detach cleared callbacks.
  if (s.lastCwd !== null) callbacks.onCwd?.(s.lastCwd);
  if (s.lastDetectedUrl !== null) callbacks.onDetectedLocalUrl?.(s.lastDetectedUrl);
  callbacks.onSearchReady?.(s.searchAddon);
  if (s.sshConnectionId) {
    // Re-emit status so pill/dot redraw after split or workspace-switch reattach.
    callbacks.onSshStatus?.(s.sshStatus);
  }
  // Same for AI CLI status. Replay even null so the App-level Map clears
  // when a tool exited while detached.
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
  /** When set, opens an SSH session instead of a local PTY. */
  sshConnectionId?: string;
  /**
   * Daemon UUID from a previously saved workspace. When set the session
   * tries `pty_attach` first and falls back to a fresh `pty_open` on
   * failure (daemon was killed or the PC rebooted). Consumed on first
   * spawn so a subsequent retry does not reuse the same UUID.
   */
  savedPtyId?: string;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onTediOpen?: (input: TediOpenInput) => void;
  onTediSpawnTab?: (input: TediSpawnTabInput) => void;
  /** Fires on SSH connection state change. */
  onSshStatus?: (status: SshStatus) => void;
  /** Fires when an AI CLI starts, changes state, or exits. */
  onAiCliStatus?: (status: AiCliStatus) => void;
  /**
   * Fires once whenever the session acquires a daemon-side UUID
   * (`pty_open` / `pty_attach` returning a non-empty `sessionId`).
   * Stamp it onto the leaf so the workspace serializer persists it.
   */
  onPtyId?: (ptyId: string) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  sshConnectionId,
  savedPtyId,
  onSearchReady,
  onExit,
  onCwd,
  onDetectedLocalUrl,
  onTediOpen,
  onTediSpawnTab,
  onSshStatus,
  onAiCliStatus,
  onPtyId,
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
    onPtyId,
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
    onPtyId,
  };

  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    let attachIntervalId: ReturnType<typeof setInterval> | null = null;
    let stuckTimer: ReturnType<typeof setTimeout> | null = null;
    const s = ensureSession(leafId, initialCwd, sshConnectionId, savedPtyId);
    // Pre-spawn, accept a fresher initialCwd (e.g. explorerRoot resolved between mounts).
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
      onPtyId: (ptyId) => cbRef.current.onPtyId?.(ptyId),
    };
    // Wait for the container ref. Up to 120 rAF frames (~2s) covers
    // react-resizable-panels measure-pass during workspace restore; after
    // that, poll every 250ms until cleanup runs.
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
        // session.ready failed (font load, OSC register). Surface a retry hint.
        // Still attach so the message is visible.
        if (cancelled) return;
        const msg = describeError(e);
        s.lastPtyError = msg;
        console.error("session ready failed:", e);
        writePtyError(s, msg);
        tryAttach(MAX_ATTACH_FRAMES);
      });

    // Stuck-recovery watchdog. Fires once; no-ops if the leaf is healthy.
    // See STUCK_RECOVERY_MS.
    stuckTimer = setTimeout(() => {
      stuckTimer = null;
      if (cancelled || s.disposed) return;
      if (s.pty) return; // healthy
      if (s.lastPtyError !== null) return; // Enter-to-retry handles it
      // In-flight spawn is legitimate progress (typically queued behind
      // Rust's SPAWN_LOCK during rapid splits). `SPAWN_TIMEOUT_MS` handles
      // the genuinely-hung case. Re-arming a spawn here would double-queue
      // a ConPTY init and the late resolution would just close as stale.
      if (s.ptyOpening) return;
      console.warn(
        `[tedi-pty] stuck-recovery: leaf=${leafId} pty=null lastPtyError=null ptyOpening=${s.ptyOpening} sshConn=${s.sshConnectionId ?? "-"} sshStatus=${s.sshStatus.kind} containerAttached=${s.term.element !== undefined} after ${STUCK_RECOVERY_MS}ms - forcing retry`,
      );
      if (s.sshConnectionId) {
        // SSH has its own reconnect. Only intervene from idle.
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
    // WebGL caches glyphs keyed by old font metrics. Dispose and recreate after a font-size change.
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
    // Push PTY size across the visibility flip. ResizeObserver doesn't fire on
    // hidden->visible since dimensions don't change, so we sync explicitly.
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
   * Paste via xterm so bracketed paste mode (zsh/bash/fish/pwsh) wraps the
   * payload in `\e[200~ ... \e[201~`. Raw `pty.write` would skip the wrapper
   * and run every line of a multi-line snippet on paste.
   */
  const paste = useCallback((data: string) => sessions.get(leafId)?.term.paste(data), [leafId]);

  // True when the cursor line matches a shell PS1 on the normal screen. Used
  // by the AI's run_in_terminal to refuse disrupting a running command or TUI.
  // Alt-screen (vim, htop, top, etc.) is always treated as busy.
  const isAtPrompt = useCallback((): boolean => {
    const s = sessions.get(leafId);
    if (!s) return false;
    try {
      const buf = s.term.buffer.active;
      if (buf.type === "alternate") return false;
      const line = buf.getLine(buf.baseY + buf.cursorY);
      const text = line ? line.translateToString(true) : "";
      return cursorLineLooksLikeShellPrompt(text);
    } catch {
      return false;
    }
  }, [leafId]);

  const applyTheme = useCallback(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    syncRendererForWallpaper(s);
    s.term.options.theme = buildTerminalTheme();
    s.term.refresh(0, s.term.rows - 1);
  }, [leafId]);

  return { write, focus, getBuffer, getSelection, paste, isAtPrompt, applyTheme };
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
