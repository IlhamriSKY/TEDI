import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildTerminalTheme, resolveCanvasBackground } from "@/styles/terminalTheme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  registerCwdHandler,
  registerPromptTracker,
  registerTediOpenHandler,
  registerTediSpawnTabHandler,
  type TediOpenInput,
  type TediSpawnTabInput,
} from "./osc-handlers";
import { isHostKeyMismatchError } from "@/modules/ssh/bridge";
import type { SshStatus } from "@/modules/ssh/status";
import { createAiCliDetector, cursorLineLooksLikeShellPrompt } from "./aiCliDetector";
import type { AiCliStatus } from "./aiCliStatus";
import { sessions, type Callbacks, type Session } from "./sessionState";
import {
  BACKWARD_KILL_WORD,
  SHIFT_ENTER,
  MIN_PTY_DIM,
  STUCK_RECOVERY_MS,
  isDebugPty,
  readTerminalViewport,
  effectiveTerminalFontSize,
  wallpaperActive,
  describeError,
  isCtrlBackspace,
  isShiftEnter,
} from "./session-helpers";
import {
  armNoDataWatchdog,
  openPtyForSession,
  respawnSession,
  retryPty,
  syncPtySize,
  writePtyError,
} from "./pty-lifecycle";
import {
  canRetrySsh,
  emitSshStatus,
  retrySsh,
  scheduleSshReconnect,
  writeSshBanner,
  disconnectSsh,
  reconnectSsh,
} from "./ssh-session";

export type { TediOpenInput, TediSpawnTabInput };
export { disconnectSsh, reconnectSsh, respawnSession };

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
      // Only the canvas background alpha changes during an opacity drag; the
      // ANSI + chrome palette is identical. Resolve the background ONCE per
      // frame and patch each session's theme.background, instead of calling
      // buildTerminalTheme() per session (which forces ~27 getComputedStyle
      // probe reads each). The full rebuild still runs on real palette changes
      // (ensureSession + the React re-theme effect in TerminalPane).
      const solid =
        getComputedStyle(document.documentElement).getPropertyValue("--tedi-canvas-bg").trim() ||
        "#1e1e1e";
      const background = resolveCanvasBackground(solid);
      for (const s of sessions.values()) {
        syncRendererForWallpaper(s);
        s.term.options.theme = { ...s.term.options.theme, background };
        s.term.refresh(0, s.term.rows - 1);
      }
    });
  });
}

/**
 * True when `el` is laid out and the window is on-screen, i.e. a `fitAddon.fit()`
 * would measure a real size. On Windows a minimized (or hidden) borderless window
 * reports a ~0px container (the same event App.tsx guards for the sidebar); fitting
 * to that collapses xterm to FitAddon's 2x1 floor and rewraps the whole scrollback,
 * and the reflow back on restore is lossy - the cursor/text end up garbled. Skipping
 * the fit while collapsed keeps the buffer untouched, so restore needs no repair.
 * The `< 2` floor matches MIN_PTY_DIM; real panes are hundreds of px wide.
 */
function canFit(el: HTMLElement | null | undefined): boolean {
  return (
    !!el &&
    document.visibilityState === "visible" &&
    el.clientWidth >= MIN_PTY_DIM &&
    el.clientHeight >= MIN_PTY_DIM
  );
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
  // Guarded so an attach that lands while the window is minimized (0px container,
  // e.g. workspace restore) doesn't fit to a degenerate size or cache 0 as the
  // last good width - the ResizeObserver fits once the real size lands.
  if (canFit(container)) {
    s.fitAddon.fit();
    s.lastW = container.clientWidth;
    s.lastH = container.clientHeight;
  }

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
      // Skip the fit while the window is minimized/hidden or the container has
      // collapsed to ~0px (Windows reports a 0px container on minimize). Fitting
      // then reflows the scrollback to xterm's 2x1 floor and the rewrap back on
      // restore is lossy -> garbled text. Return BEFORE caching lastW/lastH so the
      // last good size survives and the post-restore tick re-fits (or no-ops).
      if (document.visibilityState !== "visible" || w < MIN_PTY_DIM || h < MIN_PTY_DIM) return;
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
    if (canFit(s.term.element?.parentElement)) {
      s.fitAddon.fit();
      syncPtySize(s);
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
    // Don't fit against a 0px container (window minimized) - it would reflow the
    // buffer the same way the ResizeObserver path does. Focus still runs.
    if (canFit(container.current)) {
      s.fitAddon.fit();
      // Push PTY size across the visibility flip. ResizeObserver doesn't fire on
      // hidden->visible since dimensions don't change, so we sync explicitly.
      syncPtySize(s);
    }
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
