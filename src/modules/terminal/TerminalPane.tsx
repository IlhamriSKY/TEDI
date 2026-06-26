import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import {
  useTerminalSession,
  type TediOpenInput,
  type TediSpawnTabInput,
} from "./lib/useTerminalSession";
import type { SshStatus } from "@/modules/ssh/status";
import type { AiCliStatus } from "./lib/aiCliStatus";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
  /** Bracketed-paste-aware insert. Prevents multi-line snippets from auto-executing under bash/zsh. */
  paste: (data: string) => void;
  /** True when the cursor sits on a shell prompt (PS1/zsh/pwsh/cmd) on the
   *  normal screen, i.e. safe for the AI to inject a command. False on the
   *  alt-screen (TUI app) or mid-command-output. */
  isAtPrompt: () => boolean;
  /** True when a foreground command is genuinely running (alt-screen TUI or
   *  an in-flight OSC 133 command). Prompt-text independent, so an idle
   *  terminal never reports busy. Backs the close-confirmation modal. */
  isProcessRunning: () => boolean;
};

type Props = {
  /** Leaf identifier passed back through callbacks. */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** Active pane within its tab. Receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** When set, opens an SSH session instead of a local PTY. */
  sshConnectionId?: string;
  /**
   * Daemon-side PTY UUID from a previously saved workspace. The terminal
   * session tries `pty_attach` first and falls back to a fresh spawn on
   * failure. Forwarded to `useTerminalSession`.
   */
  savedPtyId?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
  onDetectedLocalUrl?: (leafId: number, url: string) => void;
  onTediOpen?: (leafId: number, input: TediOpenInput) => void;
  onTediSpawnTab?: (leafId: number, input: TediSpawnTabInput) => void;
  onSshStatus?: (leafId: number, status: SshStatus) => void;
  onAiCliStatus?: (leafId: number, status: AiCliStatus) => void;
  /**
   * Fires once whenever the daemon hands back a session UUID. Caller
   * (the pane stack consumer) writes it into the leaf so the workspace
   * serializer persists it for restore on next launch.
   */
  onPtyId?: (leafId: number, ptyId: string) => void;
  ref?: Ref<TerminalPaneHandle>;
};

export function TerminalPane({
  leafId,
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
  ref,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  // Re-apply the xterm theme whenever the Theme-tab custom palette or
  // wallpaper opacity changes. The `customTheme` reference flips on every
  // setter call so identity comparison is enough.
  const customTheme = usePreferencesStore((s) => s.customTheme);
  const customThemeEnabled = usePreferencesStore((s) => s.customThemeEnabled);
  // Terminal theme is independent of the app chrome. In custom mode these drive
  // the palette; in follow-app mode the customTheme/resolvedTheme deps already
  // cover it. `applyTerminalTheme` (ThemeProvider) sets the CSS vars on the same
  // store change; the rAF below defers a frame so they're in place first.
  const terminalThemeMode = usePreferencesStore((s) => s.terminalThemeMode);
  const terminalThemeId = usePreferencesStore((s) => s.terminalThemeId);
  const terminalCustomPalette = usePreferencesStore((s) => s.terminalCustomPalette);
  // Note: app-opacity changes re-theme the terminal via the rAF-throttled
  // `tedi:canvas-opacity` window listener in `useTerminalSession`, so it stays
  // smooth during live slider drags (not a per-tick effect here).

  const session = useTerminalSession({
    leafId,
    container: containerRef,
    visible,
    focused,
    initialCwd,
    sshConnectionId,
    savedPtyId,
    onSearchReady: (a) => onSearchReady?.(leafId, a),
    onExit: (c) => onExit?.(leafId, c),
    onCwd: (c) => onCwd?.(leafId, c),
    onDetectedLocalUrl: (u) => onDetectedLocalUrl?.(leafId, u),
    onTediOpen: (input) => onTediOpen?.(leafId, input),
    onTediSpawnTab: (input) => onTediSpawnTab?.(leafId, input),
    onSshStatus: (status) => onSshStatus?.(leafId, status),
    onAiCliStatus: (status) => onAiCliStatus?.(leafId, status),
    onPtyId: (ptyId) => onPtyId?.(leafId, ptyId),
  });

  // `useTerminalSession` returns a fresh object literal every render, so
  // keeping `session` in the theme effect's deps would rebuild the theme on
  // every render. Hold the latest session in a ref and read it lazily inside
  // the rAF so the effect can depend only on the real theme inputs.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    // Defer one frame so CSS variable tokens see the new class / new
    // `--tedi-canvas-*` values written by `applyCustomTheme`.
    const id = requestAnimationFrame(() => sessionRef.current.applyTheme());
    return () => cancelAnimationFrame(id);
  }, [
    resolvedTheme,
    customTheme,
    customThemeEnabled,
    terminalThemeMode,
    terminalThemeId,
    terminalCustomPalette,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => session.write(data),
      focus: () => session.focus(),
      getBuffer: (max?: number) => session.getBuffer(max),
      getSelection: () => session.getSelection(),
      paste: (data: string) => session.paste(data),
      isAtPrompt: () => session.isAtPrompt(),
      isProcessRunning: () => session.isProcessRunning(),
    }),
    [session],
  );

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      data-terminal-leaf-id={leafId}
      // Internal drag-drops (file explorer rows → terminal) are
      // synthesized from mouse events by `ensureFsDragListener`
      // (HTML5 drag-drop is unreliable under Tauri's default
      // `dragDropEnabled: true`). The listener hit-tests
      // `closest("[data-terminal-leaf-id]")` and writes a
      // shell-quoted path to the matching PTY. The Tauri OS-level
      // drop path is separate and lives in `useTerminalFileDrop`.
      style={{
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    />
  );
}
