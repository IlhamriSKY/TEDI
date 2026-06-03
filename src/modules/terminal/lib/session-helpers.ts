import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "@/modules/settings/store";
import { Terminal } from "@xterm/xterm";

export const BACKWARD_KILL_WORD = "\x17";
export const SHIFT_ENTER = "\x1b\r";

// Floor for sizes pushed to the PTY. FitAddon can return 0x0 or 1x1 during
// layout transitions; TUIs break at those sizes. 2x2 is the smallest size
// every supported TUI tolerates.
export const MIN_PTY_DIM = 2;

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
