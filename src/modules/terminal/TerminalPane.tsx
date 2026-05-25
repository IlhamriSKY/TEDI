import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
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
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
  onDetectedLocalUrl?: (leafId: number, url: string) => void;
  onTediOpen?: (leafId: number, input: TediOpenInput) => void;
  onTediSpawnTab?: (leafId: number, input: TediSpawnTabInput) => void;
  onSshStatus?: (leafId: number, status: SshStatus) => void;
  onAiCliStatus?: (leafId: number, status: AiCliStatus) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  {
    leafId,
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
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  // Re-apply the xterm theme whenever the Theme-tab custom palette or
  // wallpaper opacity changes. The `customTheme` reference flips on every
  // setter call so identity comparison is enough.
  const customTheme = usePreferencesStore((s) => s.customTheme);
  const customThemeEnabled = usePreferencesStore((s) => s.customThemeEnabled);

  const session = useTerminalSession({
    leafId,
    container: containerRef,
    visible,
    focused,
    initialCwd,
    sshConnectionId,
    onSearchReady: (a) => onSearchReady?.(leafId, a),
    onExit: (c) => onExit?.(leafId, c),
    onCwd: (c) => onCwd?.(leafId, c),
    onDetectedLocalUrl: (u) => onDetectedLocalUrl?.(leafId, u),
    onTediOpen: (input) => onTediOpen?.(leafId, input),
    onTediSpawnTab: (input) => onTediSpawnTab?.(leafId, input),
    onSshStatus: (status) => onSshStatus?.(leafId, status),
    onAiCliStatus: (status) => onAiCliStatus?.(leafId, status),
  });

  useEffect(() => {
    // Defer one frame so CSS variable tokens see the new class / new
    // `--tedi-canvas-*` values written by `applyCustomTheme`.
    const id = requestAnimationFrame(() => session.applyTheme());
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme, session, customTheme, customThemeEnabled]);

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => session.write(data),
      focus: () => session.focus(),
      getBuffer: (max?: number) => session.getBuffer(max),
      getSelection: () => session.getSelection(),
      paste: (data: string) => session.paste(data),
      isAtPrompt: () => session.isAtPrompt(),
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
});
