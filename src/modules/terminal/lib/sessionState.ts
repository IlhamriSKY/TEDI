import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import type { TediOpenInput, TediSpawnTabInput } from "./osc-handlers";
import type { PtySession } from "./pty-bridge";
import type { SshStatus } from "@/modules/ssh/status";
import type { AiCliDetector } from "./aiCliDetector";
import type { AiCliStatus } from "./aiCliStatus";
import type { TerminalPalette } from "@/modules/settings/terminalPalette";

export type Callbacks = {
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

// Lives outside React so split/unsplit can re-parent the DOM without
// disposing the term or PTY. Real disposal happens in `disposeSession`.
export type Session = {
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
  /**
   * Optional tap on raw PTY output bytes, set while this leaf is mirrored into
   * a floating window (see modules/panes/floatHost). Called right after the
   * bytes are written to the local xterm so the float sees identical output.
   * Null when no float is open.
   */
  onOutputTap?: ((bytes: Uint8Array) => void) | null;
  initialCwd: string | undefined;
  /** Bound saved SSH connection id, if any. */
  sshConnectionId: string | undefined;
  /**
   * Per-leaf terminal theme override palette (resolved from the leaf's
   * `terminalThemeId`). When set, `applyTheme` and the opacity-drag refresh
   * build the xterm theme from this palette instead of the global
   * `--tedi-term-*` tokens, so this pane is themed independently. Null =
   * follow the global terminal theme.
   */
  terminalThemeOverride: TerminalPalette | null;
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
   * Spawn epoch for which a one-shot blank-viewport repaint check has already
   * been armed (see `armBlankViewportRepaint`). Guards against arming it twice
   * for the same spawn (the reattach path and the first-byte path both call
   * it), so at most one SIGWINCH repaint nudge fires per spawn.
   */
  blankRepaintEpoch: number;
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
  /**
   * Open for the one macrotask that follows an IME `compositionend` - the
   * window in which xterm flushes the composed text. While open, `onData`
   * NFC-normalizes the composed input (CJK, Vietnamese, etc.) before it reaches
   * the PTY; pasted/typed input - which never fires `compositionend` - is left
   * byte-for-byte intact (incl. macOS NFD filenames). Opened by the
   * `compositionend` listener and closed by its `setTimeout(0)` backstop in
   * `useTerminalSession.ts`.
   */
  imeJustEnded: boolean;
  // ---- Command lifecycle (OSC 133 C/D + Enter-synthesis) ----
  /**
   * True while a foreground command is executing: set on OSC 133;C
   * (pre-exec) or a synthesized Enter-submit, cleared on OSC 133;D
   * (command-end) or a fresh prompt (133;A). Backs the close-confirmation
   * "process running" check. Independent of the `isAtPrompt` PS1 heuristic
   * so a custom prompt (oh-my-posh, starship) can't produce false positives.
   */
  commandRunning: boolean;
  /**
   * Set once any OSC 133 marker is seen, i.e. shell integration is live.
   * Gates the Enter-synthesis fallback (Windows pwsh emits no 133;C) so a
   * non-integrated shell (cmd.exe) never gets stuck reporting "running".
   */
  sawShellIntegration: boolean;
  /**
   * Printable input typed since the last prompt/submit. Lets the Enter
   * keystroke synthesize a command-start on shells without OSC 133;C, while
   * an empty Enter (no pending input) stays idle.
   */
  pendingCommandInput: boolean;
  /**
   * Terminal-originated bytes (xterm `onData`) produced while `pty` is still
   * null. The daemon can stream a DSR cursor-position query (`ESC[6n`) before
   * `invoke("pty_open")` resolves and assigns `pty`; PSReadLine (and other line
   * editors) block on the reply before painting their prompt. xterm
   * auto-replies through `onData`, so dropping it when `pty` is null hangs the
   * shell and leaves a blank pane. We stash those bytes here and flush them via
   * `flushPendingInput` the instant the PTY goes live.
   */
  pendingInput: string[];
};

export const sessions = new Map<number, Session>();
