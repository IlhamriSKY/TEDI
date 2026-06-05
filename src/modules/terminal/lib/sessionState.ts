import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import type { TediOpenInput, TediSpawnTabInput } from "./osc-handlers";
import type { PtySession } from "./pty-bridge";
import type { SshStatus } from "@/modules/ssh/status";
import type { AiCliDetector } from "./aiCliDetector";
import type { AiCliStatus } from "./aiCliStatus";

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
};

export const sessions = new Map<number, Session>();
