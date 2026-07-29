/**
 * Self-check for the xterm write flow control (createWriteMeter).
 * Run: `npx tsx scripts/write-meter-verify.ts`.
 *
 * The meter exists because Chromium throttles xterm's nested-setTimeout drain
 * to 1/s (1/min past five minutes) while the page is hidden, and it marks every
 * window occluded when Windows locks. Script execution is not throttled, so PTY
 * output keeps arriving into a parser that has effectively stopped. The meter
 * must:
 *  1. PASS-THROUGH: while the parser keeps up, every chunk reaches xterm in
 *     order and nothing is held back.
 *  2. HOLD WHEN STALLED: once the un-parsed backlog passes WRITE_HIGH_WATER,
 *     further chunks stop reaching xterm (this is the unbounded-growth bug).
 *  3. BOUNDED HOLD: the held tail never exceeds STALL_CAP no matter how much
 *     arrives during the stall.
 *  4. DROP IS A RESET, NOT A SPLICE: if the hold overflowed, the flush leads
 *     with a hard reset + notice rather than resuming mid-escape-sequence.
 *  5. FLUSH ON RECOVERY: when the parser catches up, the held tail is written
 *     and the meter returns to pass-through.
 *  6. STALE SESSION: a parser callback arriving after dispose must not write.
 */
import {
  createWriteMeter,
  STALL_CAP,
  STALL_NOTICE,
  WRITE_HIGH_WATER,
} from "../src/modules/terminal/lib/writeMeter";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

/**
 * Stand-in for `Terminal.write(data, callback)`. Records what xterm was handed
 * and defers every parse callback so a test can decide when the parser "runs" —
 * that deferral is the hidden-window behaviour being modelled.
 */
function fakeTerminal() {
  const written: (Uint8Array | string)[] = [];
  const pending: (() => void)[] = [];
  return {
    written,
    write(chunk: Uint8Array | string, done: () => void) {
      written.push(chunk);
      pending.push(done);
    },
    /** Let the parser finish everything queued so far (a visible, unthrottled page). */
    parseAll() {
      // Draining can enqueue more work (the held tail), so loop to a fixed point.
      for (let guard = 0; pending.length > 0 && guard < 1000; guard++) {
        pending.shift()!();
      }
    },
    bytesWritten() {
      return written.reduce((n, c) => n + (typeof c === "string" ? c.length : c.byteLength), 0);
    },
  };
}

const chunk = (n: number, fill = 65) => new Uint8Array(n).fill(fill);

console.log("1. pass-through while the parser keeps up");
{
  const term = fakeTerminal();
  const m = createWriteMeter(term.write.bind(term), () => false);
  for (let i = 0; i < 5; i++) {
    m.push(chunk(1024, i));
    term.parseAll();
  }
  assert(term.written.length === 5, "every chunk reached xterm");
  assert(m.held() === 0, "nothing held back");
  assert(m.outstanding() === 0, "no outstanding bytes once parsed");
  assert(
    term.written.every((c, i) => (c as Uint8Array)[0] === i),
    "chunks arrived in order",
  );
}

console.log("2. holds once the un-parsed backlog passes the high water mark");
{
  const term = fakeTerminal();
  const m = createWriteMeter(term.write.bind(term), () => false);
  // Parser never runs: this is the locked-screen state.
  while (m.outstanding() <= WRITE_HIGH_WATER) m.push(chunk(64 * 1024));
  const writtenAtStall = term.written.length;
  for (let i = 0; i < 100; i++) m.push(chunk(64 * 1024));
  assert(term.written.length === writtenAtStall, "no further chunks handed to xterm while stalled");
  assert(m.held() > 0, "the tail is held instead");
}

console.log("3. the hold stays bounded by STALL_CAP");
{
  const term = fakeTerminal();
  const m = createWriteMeter(term.write.bind(term), () => false);
  while (m.outstanding() <= WRITE_HIGH_WATER) m.push(chunk(64 * 1024));
  let maxHeld = 0;
  // 128 MB of output during the stall — the case that used to reach xterm's own
  // 50 MB ceiling and make `Terminal.write` throw.
  for (let i = 0; i < 2048; i++) {
    m.push(chunk(64 * 1024));
    maxHeld = Math.max(maxHeld, m.held());
  }
  assert(maxHeld <= STALL_CAP, `held never exceeded STALL_CAP (peak ${maxHeld} <= ${STALL_CAP})`);
}

console.log("4. an overflowed hold flushes as a reset, not a spliced stream");
{
  const term = fakeTerminal();
  const m = createWriteMeter(term.write.bind(term), () => false);
  while (m.outstanding() <= WRITE_HIGH_WATER) m.push(chunk(64 * 1024));
  const writtenAtStall = term.written.length;
  for (let i = 0; i < 200; i++) m.push(chunk(64 * 1024)); // forces at least one drop
  term.parseAll();
  const flushed = term.written.slice(writtenAtStall);
  assert(flushed[0] === STALL_NOTICE, "flush leads with the hard-reset notice");
  assert(
    flushed.slice(1).every((c) => c instanceof Uint8Array),
    "the rest of the flush is whole chunks",
  );
}

console.log("5. flushes the held tail and returns to pass-through");
{
  const term = fakeTerminal();
  const m = createWriteMeter(term.write.bind(term), () => false);
  while (m.outstanding() <= WRITE_HIGH_WATER) m.push(chunk(64 * 1024));
  const tail = chunk(8 * 1024, 7);
  m.push(tail);
  assert(m.held() === tail.byteLength, "tail is held while stalled");
  term.parseAll();
  assert(m.held() === 0, "hold is empty after the parser catches up");
  assert(m.outstanding() === 0, "backlog fully drained");
  assert(term.written.includes(tail), "the held tail reached xterm");
  // Back to normal: the next chunk goes straight through.
  const after = chunk(16, 9);
  m.push(after);
  assert(term.written[term.written.length - 1] === after, "pass-through resumed");
}

console.log("6. a stale session never writes its held tail");
{
  const term = fakeTerminal();
  let disposed = false;
  const m = createWriteMeter(term.write.bind(term), () => disposed);
  while (m.outstanding() <= WRITE_HIGH_WATER) m.push(chunk(64 * 1024));
  m.push(chunk(8 * 1024, 7));
  const writtenAtStall = term.written.length;
  disposed = true;
  term.parseAll();
  assert(term.written.length === writtenAtStall, "no writes into a disposed terminal");
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`write-meter-verify: ${failed} check(s) failed`);
console.log("\nwrite-meter-verify: all checks passed");
