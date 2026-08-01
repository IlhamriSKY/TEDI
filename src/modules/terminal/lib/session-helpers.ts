import { IS_WINDOWS } from "@/lib/platform";
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "@/modules/settings/store";
import { version as osVersion } from "@tauri-apps/plugin-os";
import { Terminal, type IWindowsPty } from "@xterm/xterm";

export const BACKWARD_KILL_WORD = "\x17";
export const SHIFT_ENTER = "\x1b\r";

// Floor for sizes pushed to the PTY. FitAddon can return 0x0 or 1x1 during
// layout transitions; TUIs break at those sizes. 2x2 is the smallest size
// every supported TUI tolerates.
export const MIN_PTY_DIM = 2;

/**
 * Build xterm's `windowsPty` compatibility block from `plugin-os`'s version
 * string. Windows reports as `"<major>.<minor>.<build>"`.
 *
 * GROWING the row count is the divergence that matters. xterm's default
 * (Unix) resize pulls scrollback back down into the viewport - `ybase--`,
 * which also shifts `buffer.y` - because a Unix pty does not repaint on
 * SIGWINCH. ConPTY DOES repaint its whole viewport, so those pulled-in lines
 * survive wherever the repaint does not cover them and the cursor row moves
 * out from under the shell. Inline TUIs that redraw relative to the cursor -
 * Claude Code and Codex in their default renderers, which never touch the
 * alternate screen - then paint every later frame into the wrong rows. That is
 * the "make the pane bigger and the CLI turns to soup" report. Setting
 * `backend` alone switches xterm to appending blank rows, which is what ConPTY
 * actually does.
 *
 * `buildNumber` gates the other half: reflow stays enabled on ConPTY >= 21376
 * (which emits real wrap markers) and falls back to xterm's legacy
 * last-character wrapping heuristic below it. An unparseable version omits the
 * field rather than passing 0, because a zero build would put a modern ConPTY
 * on the legacy heuristic - worse than not setting `windowsPty` at all.
 */
export function conptyCompat(version: string): IWindowsPty {
  const build = Number(version.split(".")[2]);
  return Number.isInteger(build) && build > 0
    ? { backend: "conpty", buildNumber: build }
    : { backend: "conpty" };
}

/**
 * Host ConPTY compatibility block, resolved once. Undefined off Windows, where
 * xterm's Unix default is the correct behaviour. Applies to LOCAL terminals
 * only - an SSH leaf's pty lives on the remote host. See `conptyCompat`.
 */
export const WINDOWS_PTY: IWindowsPty | undefined = (() => {
  if (!IS_WINDOWS) return undefined;
  try {
    return conptyCompat(osVersion());
  } catch {
    return conptyCompat("");
  }
})();

export const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;

// PTY exits within this window after spawn are treated as init crashes
// (ConPTY race, profile script error) rather than user `exit`. Hold the
// leaf with a retry banner instead of closing the pane.
export const SPAWN_GRACE_MS = 3_000;

// Hard ceiling on `pty_open`. Workspace restore on Windows can wedge with the
// promise never settling, leaving the leaf with `pty=null` AND `lastPtyError=null`
// so Enter-to-retry can't fire. After this many ms we force the retry-banner
// path. Local spawns normally complete in <300ms.
export const SPAWN_TIMEOUT_MS = 15_000;

/** PTY lifecycle debug toggle. Default on; set `localStorage.TEDI_DEBUG_PTY = "0"` to silence. */
export function isDebugPty(): boolean {
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
export const NO_DATA_WATCHDOG_MS = 8_000;

/**
 * Last-resort recovery for the silent-blank failure mode where attachSession
 * never runs or `s.ready` stays pending. Fires only when there's no live
 * PTY, no pending error, AND no in-flight spawn - an in-flight spawn that
 * is just queued behind `SPAWN_LOCK` in Rust is legitimate progress and
 * `SPAWN_TIMEOUT_MS` already covers genuinely hung pty_open invokes. Sits
 * above worst-case `SPAWN_LOCK` queueing (3-5 splits stacking 1-2.5s of
 * ConPTY init on Windows) and below `SPAWN_TIMEOUT_MS` (15s).
 */
export const STUCK_RECOVERY_MS = 12_000;

/**
 * After an `alive` daemon reattach, the scrollback replay is supposed to
 * reconstruct the screen, but it can net to a BLANK viewport while the idle
 * shell stays silent (the saved tail ended on a screen-clear, the 1 MiB ring
 * was front-trimmed mid-escape, or ConPTY re-rendered at a new size). Because a
 * replay byte arrived, the no-data watchdog is disarmed and - with `s.pty` set -
 * Enter-to-retry and stuck-recovery are inert, so the pane would stay blank
 * forever. This is how long to wait for the one-shot replay Data event to render
 * before checking whether the viewport is still blank. Short enough to feel
 * instant, long enough for xterm to flush the replay.
 */
export const REATTACH_REPAINT_CHECK_MS = 300;

/**
 * Gap between the two halves of the repaint SIGWINCH round-trip used to provoke
 * a prompt redraw after a blank reattach, so ConPTY processes them as distinct
 * resize events instead of coalescing them into a net no-op.
 */
export const REATTACH_REPAINT_NUDGE_GAP_MS = 50;

/**
 * Delay after a program leaves the alternate screen (CSI ?1049l) before TEDI
 * repairs the pane. Long enough for a renderer relaunch (Claude Code's `/tui`
 * fullscreen<->default toggle re-execs the CLI in place) to land its first
 * classic-renderer frame, short enough to feel instant. See
 * `armAltExitRepaintWatchdog`.
 */
export const ALT_EXIT_REPAINT_DELAY_MS = 180;

/**
 * Snapshot the visible xterm viewport as newline-joined text in original
 * case. Returns "" on any buffer API error so a mid-reflow throw doesn't
 * kill the detector loop.
 */
export function readTerminalViewport(term: Terminal): string {
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
export function effectiveTerminalFontSize(base: number, zoom: number): number {
  const raw = Math.round(base * (Number.isFinite(zoom) ? zoom : 1));
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, raw));
}

/**
 * True when the terminal canvas should be semi-transparent, i.e. the single
 * "App opacity" control is active (`data-tedi-glass`). Drives the switch to
 * the DOM renderer + an rgba background (the WebGL renderer dims foreground
 * glyphs when the background has alpha < 1, xterm.js #4054).
 */
export function wallpaperActive(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.tediGlass === "on";
}

export function describeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function isCtrlBackspace(event: KeyboardEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Backspace" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export function isShiftEnter(event: KeyboardEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export function stripTrailingPunct(url: string): string {
  return url.replace(/[.,);\]]+$/, "");
}

export function containsSchemeSeparator(bytes: Uint8Array): boolean {
  const n = bytes.length;
  for (let i = 0; i < n - 2; i++) {
    if (bytes[i] === 0x3a && bytes[i + 1] === 0x2f && bytes[i + 2] === 0x2f) {
      return true;
    }
  }
  return false;
}
