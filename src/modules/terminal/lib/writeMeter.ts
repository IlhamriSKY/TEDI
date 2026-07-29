/**
 * Flow control for the xterm write path.
 *
 * xterm drains its write buffer through a nested `setTimeout`, and Chromium
 * throttles those to one per second — one per MINUTE past five minutes — once
 * the page is hidden. Chromium's occlusion tracker marks every window occluded
 * while the Windows session is locked, so a lock screen hits exactly that path.
 * Script execution is NOT throttled, so the PTY keeps pushing at full rate
 * through the Tauri channel while the parser is effectively stopped: the
 * backlog grows unbounded behind the lock screen (hundreds of MB of retained
 * chunks), `Terminal.write` eventually throws at its own 50 MB ceiling — taking
 * the rest of the data handler with it — and unlocking pays for the whole
 * backlog in one parse storm. That is the "lock the PC, come back, TEDI is
 * frozen" report.
 *
 * Past `WRITE_HIGH_WATER` bytes accepted-but-not-yet-parsed we stop feeding
 * xterm and hold the tail here instead, capped at `STALL_CAP`, resuming once
 * the parser has caught up to `WRITE_LOW_WATER`.
 */

export const WRITE_HIGH_WATER = 2 * 1024 * 1024;
export const WRITE_LOW_WATER = 256 * 1024;
export const STALL_CAP = 512 * 1024;

/**
 * Hard reset (ESC c) + dim notice, written when a held backlog had to be
 * dropped. Mirrors the daemon-side `OVERFLOW_NOTICE`: trimming a prefix would
 * slice a CSI sequence in half and corrupt xterm's screen state, so the whole
 * held buffer goes and the screen is reset instead of half-updated.
 */
export const STALL_NOTICE =
  "\x1bc\x1b[2m[tedi: dropped output while the window was hidden]\x1b[0m\r\n";

export type WriteMeter = {
  /** Feed PTY bytes: written through while the parser keeps up, held otherwise. */
  push: (bytes: Uint8Array) => void;
  /** Bytes accepted by the parser but not yet reported done. Test/diagnostic. */
  outstanding: () => number;
  /** Bytes currently held back waiting for the parser. Test/diagnostic. */
  held: () => number;
};

/**
 * @param write  Writes a chunk and invokes `done` once it has been parsed —
 *               i.e. xterm's `Terminal.write(data, callback)`.
 * @param isStale Aborts a pending drain once the session is disposed or its
 *               spawn superseded, so a late parser callback can't write into a
 *               dead terminal.
 */
export function createWriteMeter(
  write: (chunk: Uint8Array | string, done: () => void) => void,
  isStale: () => boolean,
): WriteMeter {
  let outstanding = 0;
  let stalled: Uint8Array[] = [];
  let stalledBytes = 0;
  let stalledDropped = false;

  const writeMetered = (chunk: Uint8Array | string): void => {
    const n = typeof chunk === "string" ? chunk.length : chunk.byteLength;
    outstanding += n;
    write(chunk, () => {
      outstanding -= n;
      drain();
    });
  };

  function drain(): void {
    if (isStale()) return;
    if (outstanding > WRITE_LOW_WATER || stalled.length === 0) return;
    // Clear before writing: `writeMetered`'s callbacks re-enter this, and an
    // empty `stalled` makes those re-entries no-ops instead of double-writes.
    const batch = stalled;
    const dropped = stalledDropped;
    stalled = [];
    stalledBytes = 0;
    stalledDropped = false;
    if (dropped) writeMetered(STALL_NOTICE);
    for (const chunk of batch) writeMetered(chunk);
  }

  return {
    push(bytes: Uint8Array): void {
      if (outstanding > WRITE_HIGH_WATER) {
        // The parser is not keeping up — a hidden window with throttled timers,
        // or output outrunning xterm. Hold the tail instead of queueing without
        // bound; `drain` flushes it when the parser catches up.
        if (stalledBytes + bytes.byteLength > STALL_CAP) {
          stalled = [];
          stalledBytes = 0;
          stalledDropped = true;
        }
        stalled.push(bytes);
        stalledBytes += bytes.byteLength;
        return;
      }
      writeMetered(bytes);
    },
    outstanding: () => outstanding,
    held: () => stalledBytes,
  };
}
