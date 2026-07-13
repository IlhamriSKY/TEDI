import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveTerminalPreset } from "@/modules/settings/terminalPalette";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { buildContentFontFamily } from "@/lib/fonts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { type TediOpenInput, type TediSpawnTabInput } from "./osc-handlers";
import type { SshStatus } from "@/modules/ssh/status";
import { cursorLineLooksLikeShellPrompt } from "./aiCliDetector";
import type { AiCliStatus } from "./aiCliStatus";
import { sessions, type Callbacks, type Session } from "./sessionState";
import { STUCK_RECOVERY_MS, effectiveTerminalFontSize, describeError } from "./session-helpers";
import { respawnSession, retryPty, syncPtySize, writePtyError } from "./pty-lifecycle";
import { disconnectSsh, reconnectSsh, retrySsh } from "./ssh-session";
import { loadWebglRenderer, disposeWebglRenderer, syncRendererForWallpaper } from "./webgl";
import { ensureSession, attachSession, detachSession, canFit } from "./session-lifecycle";

export type { TediOpenInput, TediSpawnTabInput };
export { disconnectSsh, reconnectSsh, respawnSession };
export { writeToLeaf, findLeafIdFromPoint, disposeSession } from "./session-lifecycle";

/**
 * A font-size or font-family change invalidates the WebGL glyph atlas (glyphs
 * are cached keyed by font metrics). Dispose + recreate the renderer, then
 * refit since the new glyph metrics change the cell size.
 */
function reloadWebglAndRefit(s: Session): void {
  if (s.webglAddon && s.term.element) {
    disposeWebglRenderer(s);
    if (s.webglEnabled) loadWebglRenderer(s);
  }
  if (canFit(s.term.element?.parentElement)) {
    s.fitAddon.fit();
    syncPtySize(s);
  }
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
  /**
   * Per-leaf terminal theme override id (a `TERMINAL_PRESETS` id). When set,
   * this pane paints its own palette instead of the global terminal theme.
   * Undefined follows the global theme.
   */
  terminalThemeId?: string;
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
  terminalThemeId,
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
    const s = ensureSession(leafId, initialCwd, sshConnectionId, savedPtyId, terminalThemeId);
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
    reloadWebglAndRefit(s);
  }, [leafId, fontSize]);

  const fontFamilyPref = usePreferencesStore((p) => p.fontFamily);
  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    const family = buildContentFontFamily(fontFamilyPref);
    if (s.term.options.fontFamily === family) return;
    s.term.options.fontFamily = family;
    reloadWebglAndRefit(s);
  }, [leafId, fontFamilyPref]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    if (s.term.options.scrollback === scrollback) return;
    // Lowering trims the live history ring immediately (frees memory); raising
    // lets the terminal retain more going forward. Viewport size is unchanged,
    // so no refit is needed.
    s.term.options.scrollback = scrollback;
  }, [leafId, scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.webglEnabled = webglPref;
    if (!s.term.element) return;
    if (webglPref && !s.webglAddon) {
      loadWebglRenderer(s);
    } else if (!webglPref && s.webglAddon) {
      disposeWebglRenderer(s);
    }
  }, [leafId, webglPref]);

  // Per-leaf terminal theme override. `resolveTerminalPreset` returns the
  // preset's stable palette object (or null), so the dep only changes when the
  // chosen id actually changes. Writes the override onto the session and
  // rebuilds the xterm theme so the pane repaints in its own palette without
  // touching the global terminal theme or any sibling pane.
  const terminalThemeOverride = resolveTerminalPreset(terminalThemeId);
  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    if (s.terminalThemeOverride === terminalThemeOverride) return;
    s.terminalThemeOverride = terminalThemeOverride;
    syncRendererForWallpaper(s);
    s.term.options.theme = buildTerminalTheme(terminalThemeOverride);
    s.term.refresh(0, s.term.rows - 1);
  }, [leafId, terminalThemeOverride]);

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

  /** Drop the xterm selection. Used after a right-click copy so the next
   *  right-click pastes (Windows Terminal convention) instead of re-copying the
   *  same range while the highlight lingers. */
  const clearSelection = useCallback((): void => {
    sessions.get(leafId)?.term.clearSelection();
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

  // True when a foreground command is actually running: a full-screen TUI owns
  // the alt-screen, or the OSC 133 command lifecycle (C/D, with Enter-synthesis
  // for pwsh) says a command is mid-flight. Unlike `isAtPrompt`, this does not
  // guess from the PS1 text, so an idle terminal with a custom prompt never
  // reads as busy. Used by the close-confirmation so it only fires for a real
  // running process.
  const isProcessRunning = useCallback((): boolean => {
    const s = sessions.get(leafId);
    if (!s) return false;
    try {
      if (s.term.buffer.active.type === "alternate") return true;
    } catch {
      // ignore - fall through to the command-lifecycle flag.
    }
    return s.commandRunning === true;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    syncRendererForWallpaper(s);
    // Honor a per-leaf override so a global theme change (this callback's
    // trigger) never clobbers a pane that opted into its own palette.
    s.term.options.theme = buildTerminalTheme(s.terminalThemeOverride);
    s.term.refresh(0, s.term.rows - 1);
  }, [leafId]);

  return {
    write,
    focus,
    getBuffer,
    getSelection,
    clearSelection,
    paste,
    isAtPrompt,
    isProcessRunning,
    applyTheme,
  };
}
