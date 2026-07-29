/**
 * Imperative terminal-session lifecycle: construction (`ensureSession`), DOM
 * attach/detach (`attachSession`/`detachSession`), and disposal
 * (`disposeSession`), plus the small leaf-targeted helpers (`writeToLeaf`,
 * `findLeafIdFromPoint`). Operates on the module-level `sessions` Map from
 * `sessionState` and is framework-agnostic (no React), so the
 * `useTerminalSession` hook stays a thin binding layer over these functions.
 */

import { buildContentFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveTerminalPreset } from "@/modules/settings/terminalPalette";
import { buildTerminalTheme, resolveTerminalBackground } from "@/styles/terminalTheme";
import { isHostKeyMismatchError } from "@/modules/ssh/bridge";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  registerCwdHandler,
  registerProgressHandler,
  registerPromptTracker,
  registerTediOpenHandler,
  registerTediSpawnTabHandler,
} from "./osc-handlers";
import { createAiCliDetector } from "./aiCliDetector";
import type { AiCliKind } from "./aiCliStatus";
import { sessions, type Callbacks, type Session } from "./sessionState";
import { useTerminalTitles } from "./terminalTitles";
import { useAiCliStatuses } from "./aiCliStatusStore";
import {
  BACKWARD_KILL_WORD,
  SHIFT_ENTER,
  MIN_PTY_DIM,
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
  armAltExitRepaintWatchdog,
  flushPendingInput,
  openPtyForSession,
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
} from "./ssh-session";
import { loadWebglRenderer, syncRendererForWallpaper } from "./webgl";

/**
 * Synthesize the OSC 133 command lifecycle for shells that emit no pre-exec
 * marker (Windows pwsh sends only A/B/D - no C). Tracks printable keystrokes
 * and flips `commandRunning` on a non-empty Enter-submit; OSC 133;D (or the
 * next prompt) clears it. Gated by `sawShellIntegration` so a shell with no
 * integration at all (cmd.exe) never gets stuck "running". ESC-prefixed
 * payloads (arrow/function keys, bracketed paste) and alt-screen submits are
 * ignored - a TUI is reported as running via the buffer type instead.
 */
function trackCommandInput(session: Session, data: string): void {
  if (!session.sawShellIntegration) return;
  if (data.length === 0 || data.charCodeAt(0) === 0x1b) return;
  const isAlt = session.term.buffer.active.type === "alternate";
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") {
      if (session.pendingCommandInput && !isAlt) session.commandRunning = true;
      session.pendingCommandInput = false;
    } else if (ch === "\x03") {
      // Ctrl+C: the input line was abandoned.
      session.pendingCommandInput = false;
    } else if (code >= 0x20 && code !== 0x7f) {
      session.pendingCommandInput = true;
    }
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
      // ANSI + terminal palette is identical. Resolve the terminal background
      // ONCE per frame and patch each session's theme.background, instead of
      // calling buildTerminalTheme() per session (which forces ~20
      // getComputedStyle probe reads each). The full rebuild still runs on real
      // palette changes (ensureSession + the React re-theme effect in
      // TerminalPane). Reads the terminal-owned `--tedi-term-bg`, so a custom
      // terminal theme keeps its own background under glass.
      const globalBackground = resolveTerminalBackground();
      for (const s of sessions.values()) {
        syncRendererForWallpaper(s);
        // A pane with a per-leaf theme override keeps its own palette's
        // background; everything else shares the single global resolve.
        const background = s.terminalThemeOverride
          ? resolveTerminalBackground(s.terminalThemeOverride)
          : globalBackground;
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
export function canFit(el: HTMLElement | null | undefined): boolean {
  return (
    !!el &&
    document.visibilityState === "visible" &&
    el.clientWidth >= MIN_PTY_DIM &&
    el.clientHeight >= MIN_PTY_DIM
  );
}

export function ensureSession(
  leafId: number,
  initialCwd?: string,
  sshConnectionId?: string,
  savedPtyId?: string,
  terminalThemeId?: string,
  savedActiveTool?: AiCliKind,
): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const prefs = usePreferencesStore.getState();
  const webglEnabled = prefs.terminalWebglEnabled;
  const fontSize = effectiveTerminalFontSize(prefs.terminalFontSize, prefs.contentZoom);
  // Per-leaf theme override (Pane header -> "Terminal theme"). Resolved here so
  // the very first xterm paint already uses it instead of flashing the global
  // palette for a frame.
  const terminalThemeOverride = resolveTerminalPreset(terminalThemeId);

  const term = new Terminal({
    fontFamily: buildContentFontFamily(prefs.fontFamily),
    fontSize,
    lineHeight: 1.05,
    theme: buildTerminalTheme(terminalThemeOverride),
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    // User-configurable history cap (Settings -> General). Each line is ~cols x
    // ~16 B, so a lower value keeps the per-leaf footprint small. Live changes
    // are pushed onto open terminals from useTerminalSession.
    scrollback: prefs.terminalScrollback,
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
    webglLossReloads: 0,
    ready: Promise.resolve(),
    disposed: false,
    initialCwd,
    sshConnectionId,
    terminalThemeOverride,
    savedPtyId,
    ptyOpening: false,
    lastPtyError: null,
    ptySpawnedAt: null,
    ptySpawnEpoch: 0,
    noDataTimer: null,
    firstByteEpoch: 0,
    blankRepaintEpoch: 0,
    sshStatus: { kind: "idle" },
    sshUserClose: false,
    sshReconnectAttempts: 0,
    sshReconnectTimer: null,
    aiCliDetector: null,
    aiCliStatus: null,
    placeholderShown: false,
    imeJustEnded: false,
    commandRunning: false,
    sawShellIntegration: false,
    pendingCommandInput: false,
    pendingInput: [],
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
      // Live, attach-independent mirror for the Workspaces panel (stays fresh
      // even while this workspace is hidden, when `callbacks` is cleared).
      useAiCliStatuses.getState().setStatus(leafId, status);
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
    // Restore path: resume classifying a still-running agent after reattach.
    initialTool: savedActiveTool,
  });
  session.aiCliDetector = detector;
  session.cleanups.push(() => detector.dispose());

  // Mirror the program-set terminal title (OSC 0/2) into a small store the
  // Workspaces panel reads, so a running agent's title (Claude Code, Codex, …)
  // shows next to the folder name. Lives for the term's life; the entry is
  // dropped in `disposeSession`.
  const titleSub = term.onTitleChange((title) => {
    // Feed the RAW title (glyph intact) to the detector first - it reads the
    // leading spinner glyph as a working signal. setTitle then strips that glyph
    // for the Workspaces-panel label.
    session.aiCliDetector?.pushTitle(title);
    useTerminalTitles.getState().setTitle(leafId, title);
  });
  session.cleanups.push(() => titleSub.dispose());

  // Repair the pane when a foreground program LEAVES the alternate screen
  // (CSI ?1049l). The trigger case is Claude Code's `/tui fullscreen` <->
  // `/tui default` renderer toggle: xterm restores the cursor but not the
  // normal buffer's scroll region, no pane-pixel-size change means the
  // ResizeObserver never repaints, and the relaunched classic renderer then
  // draws a corrupted prompt box whose line-editor redraw lands off-screen (so
  // input looks dead). `armAltExitRepaintWatchdog` resets the region + nudges a
  // resize. Gated on `sawAltScreenBuffer` so only the alt->normal exit edge
  // fires - launching a TUI (normal->alt) is left untouched.
  let sawAltScreenBuffer = false;
  const bufferSub = term.buffer.onBufferChange(() => {
    let isAlt = false;
    try {
      isAlt = term.buffer.active.type === "alternate";
    } catch {
      return;
    }
    if (isAlt) {
      sawAltScreenBuffer = true;
      return;
    }
    if (!sawAltScreenBuffer) return;
    sawAltScreenBuffer = false;
    armAltExitRepaintWatchdog(session);
  });
  session.cleanups.push(() => bufferSub.dispose());

  // Route through session.pty so respawn doesn't rebind. Capture the
  // disposable and release it in `disposeSession` (via cleanups) so the
  // closure over `session` isn't retained between dispose and GC - matches
  // the prompt/cwd/osc handlers pushed below.
  const onDataDisposable = term.onData((data) => {
    // IME composition output (Vietnamese, CJK, …) can arrive decomposed (NFD:
    // base letter + a separate combining mark). xterm renders a multi-codepoint
    // cell through the WebGL "combined glyph" path (canvas fillText + bounding-
    // box scan, with no DOM fallback), which can drop or mis-stack the mark.
    // Normalizing to NFC collapses it onto the robust single-glyph path. The
    // `compositionend` listener in `attachSession` opens `imeJustEnded` for one
    // macrotask, which is exactly when xterm flushes the composed text (it emits
    // it from its own `setTimeout(0)`), so every chunk of that composition is
    // normalized. Pasted text and ordinary keystrokes never fire `compositionend`
    // - and can't interleave into that macrotask - so they reach the shell
    // byte-for-byte unchanged (incl. macOS NFD filenames pasted from Finder).
    const out = session.imeJustEnded ? data.normalize("NFC") : data;
    session.aiCliDetector?.pushInput(out);
    trackCommandInput(session, out);
    if (session.pty) {
      session.pty.write(out);
    } else {
      // No live PTY handle yet. This fires for xterm's auto-replies to device
      // queries the shell streams during startup - notably the DSR
      // cursor-position report answering `ESC[6n`, which PSReadLine (and other
      // line editors) block on before drawing the prompt. The daemon can
      // deliver that query before `invoke("pty_open")` resolves and assigns
      // `session.pty`; dropping the reply hangs the shell and leaves a blank
      // pane. Buffer it and flush via `flushPendingInput` once the PTY is live.
      session.pendingInput.push(out);
    }
  });
  session.cleanups.push(() => onDataDisposable.dispose());

  // PTY opens lazily after the first fit so the shell starts at the real terminal size.
  session.ready = (async () => {
    await document.fonts.ready;
    if (session.disposed) return;

    const prompt = registerPromptTracker(term, {
      onPromptStart: () => {
        // New shell prompt: shell integration is live, and any running
        // command / active AI CLI has finished.
        session.sawShellIntegration = true;
        session.commandRunning = false;
        session.pendingCommandInput = false;
        session.aiCliDetector?.notifyShellPrompt();
      },
      onCommandStart: () => {
        // OSC 133;C (bash/zsh/fish pre-exec). Authoritative command-start.
        session.sawShellIntegration = true;
        session.commandRunning = true;
      },
      onCommandEnd: () => {
        // OSC 133;D. Command finished - back to idle at the prompt.
        session.sawShellIntegration = true;
        session.commandRunning = false;
        session.pendingCommandInput = false;
      },
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
      // OSC 9;4 progress (Claude Code emits `9;4;3` busy / `9;4;0` done). The
      // detector treats this as its most reliable per-turn busy/idle oracle -
      // it survives the subagent case where the on-screen footer looks idle.
      registerProgressHandler(term, (state, progress) => {
        session.aiCliDetector?.pushProgress(state, progress);
      }),
    );
  })();

  return session;
}

/**
 * Mark a terminal's finished ("done") AI-CLI badge as attended-to (the user
 * focused it), so the held "done" decays back to idle. No-op when the leaf has
 * no session or no active agent.
 */
export function acknowledgeAiCli(leafId: number): void {
  sessions.get(leafId)?.aiCliDetector?.acknowledge();
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

export function attachSession(
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
    // `term.textarea` exists only after `open()`. Open an NFC window for IME
    // output (see the `onData` handler). xterm flushes the composed text from
    // its own `setTimeout(0)` after `compositionend`, so a single `setTimeout(0)`
    // backstop - the sole clearer - keeps the window open for exactly that one
    // macrotask: every chunk of the composition is normalized, while a later
    // real keystroke (a separate task) can't be caught. The guard avoids
    // mutating a session disposed within that macrotask.
    const textarea = s.term.textarea;
    if (textarea) {
      const onCompositionEnd = () => {
        s.imeJustEnded = true;
        setTimeout(() => {
          if (!s.disposed) s.imeJustEnded = false;
        }, 0);
      };
      textarea.addEventListener("compositionend", onCompositionEnd);
      s.cleanups.push(() => textarea.removeEventListener("compositionend", onCompositionEnd));
    }
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
    loadWebglRenderer(s);
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
        // Flush any terminal replies (e.g. the DSR cursor-position report the
        // shell is blocking on) that xterm produced before the PTY went live.
        flushPendingInput(s);
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

export function detachSession(leafId: number): void {
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
  useTerminalTitles.getState().clearTitle(leafId);
  useAiCliStatuses.getState().clearStatus(leafId);
}
