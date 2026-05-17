import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  useTerminalSession,
  type TediOpenInput,
  type TediSpawnTabInput,
} from "./lib/useTerminalSession";
import type { SshStatus } from "@/modules/ssh/status";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
  /** Bracketed-paste-aware insert. Use this for clipboard paste paths so
   *  multi-line snippets don't execute line-by-line under bash/zsh. */
  paste: (data: string) => void;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab - receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** If set, the leaf opens an SSH session instead of a local PTY. */
  sshConnectionId?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
  onDetectedLocalUrl?: (leafId: number, url: string) => void;
  onTediOpen?: (leafId: number, input: TediOpenInput) => void;
  onTediSpawnTab?: (leafId: number, input: TediSpawnTabInput) => void;
  onSshStatus?: (leafId: number, status: SshStatus) => void;
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
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

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
  });

  useEffect(() => {
    // Defer one frame so CSS-variable token resolution sees the new class.
    const id = requestAnimationFrame(() => session.applyTheme());
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme, session]);

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => session.write(data),
      focus: () => session.focus(),
      getBuffer: (max?: number) => session.getBuffer(max),
      getSelection: () => session.getSelection(),
      paste: (data: string) => session.paste(data),
    }),
    [session],
  );

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      data-terminal-leaf-id={leafId}
      style={{
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    />
  );
});
