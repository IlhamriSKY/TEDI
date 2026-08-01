/**
 * Self-check for terminal resize correctness.
 * Run: `npx tsx scripts/terminal-resize-verify.ts`.
 *
 * Two things go wrong when a pane changes size, both of them silent - nothing
 * throws, the shell keeps running, the pane just renders soup.
 *
 * 1. CONPTY BUFFER SEMANTICS (`conptyCompat`). xterm's default resize is the
 *    Unix one: growing the row count pulls scrollback back DOWN into the
 *    viewport (`ybase--`, which also shifts `buffer.y`), because a Unix pty
 *    does not repaint on SIGWINCH. ConPTY repaints its whole viewport, so
 *    those pulled-in rows survive wherever the repaint misses and the cursor
 *    row moves out from under the shell. Inline TUIs that draw relative to the
 *    cursor - Claude Code and Codex in their default renderers, which never
 *    touch the alternate screen - then paint every later frame into the wrong
 *    rows. `backend: "conpty"` is what switches xterm to appending blank rows
 *    instead. `buildNumber` is the second, independent knob: it must be
 *    ABSENT rather than 0 when the version does not parse, because a zero
 *    build puts a modern ConPTY back on xterm's legacy last-character
 *    wrapping heuristic - worse than never setting `windowsPty`.
 *
 * 2. THE REPAINT NUDGE (`nudgeResizeRoundTrip`). It resizes the PTY off by one
 *    row and restores it after a gap, to defeat ConPTY's same-size
 *    coalescing. Restoring the size captured BEFORE the gap is the bug: a tab
 *    switch, font-size change or `visible` flip inside those 50ms re-fits
 *    xterm and syncs the PTY directly, so replaying the old numbers leaves the
 *    shell wrapping at a width the pane no longer has - and because the nudge
 *    also stamps `lastSent*`, `syncPtySize` sees nothing to correct and the
 *    pane stays wrong until the next pixel-size change.
 *
 * 3. THE BLAST RADIUS OF (1), asserted against the real xterm. `windowsPty` is a
 *    global terminal option, so "it fixes the shell" is only half the claim: it
 *    must also leave a RUNNING TUI alone. The alternate screen has no scrollback,
 *    so the Unix branch it changes (`ybase--`) is unreachable there and the two
 *    configurations should be byte-identical — but that is xterm's internal
 *    behaviour, not ours, and an xterm upgrade could quietly change it. These
 *    checks pin it: vim/htop/lazygit must resize exactly as before, and column
 *    reflow must be untouched in both directions.
 */

export {};

// The module graph reaches the settings store, which resolves the current
// webview window at import time. Same stand-in as `terminal-webgl-visibility-verify`.
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: async () => undefined,
  },
};

const { conptyCompat, MIN_PTY_DIM, REATTACH_REPAINT_NUDGE_GAP_MS } =
  await import("../src/modules/terminal/lib/session-helpers");
const { nudgeResizeRoundTrip } = await import("../src/modules/terminal/lib/pty-lifecycle");
type Session = Parameters<typeof nudgeResizeRoundTrip>[0];

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\nConPTY compat block: the backend is what fixes the row-growth corruption");
for (const version of ["10.0.26200", "10.0.19045", "10.0.22631", ""]) {
  assert(
    conptyCompat(version).backend === "conpty",
    `"${version || "<unparseable>"}" still declares the conpty backend`,
  );
}

console.log("\nbuild number: parsed from plugin-os's <major>.<minor>.<build>");
assert(
  conptyCompat("10.0.26200").buildNumber === 26200,
  "Windows 11 26200 -> 26200, reflow stays on",
);
assert(
  conptyCompat("10.0.19045").buildNumber === 19045,
  "Windows 10 22H2 -> 19045, legacy wrap heuristic",
);
assert(
  conptyCompat("10.0.21376").buildNumber === 21376,
  "the reflow cutoff itself parses (>= 21376 keeps reflow)",
);

console.log("\nbuild number: ABSENT, never 0, when the version does not parse");
for (const version of ["", "10.0", "not.a.version", "10.0.x"]) {
  assert(
    conptyCompat(version).buildNumber === undefined,
    `"${version}" omits buildNumber rather than sending a falsy one`,
  );
}
assert(
  conptyCompat("10.0.0").buildNumber === undefined,
  "a literal 0 build is treated as unparseable",
);

/** Minimal session: everything `nudgeResizeRoundTrip` actually reads/writes. */
function session(cols: number, rows: number, sent: number[][]) {
  return {
    disposed: false,
    ptySpawnEpoch: 1,
    term: { cols, rows },
    lastSentCols: cols,
    lastSentRows: rows,
    pty: {
      resize: (c: number, r: number) => {
        sent.push([c, r]);
        return Promise.resolve();
      },
    },
  } as unknown as Session;
}

const settle = () => new Promise((r) => setTimeout(r, REATTACH_REPAINT_NUDGE_GAP_MS + 40));

console.log("\nthe nudge round-trip itself");
{
  const sent: number[][] = [];
  const s = session(120, 40, sent);
  nudgeResizeRoundTrip(s, 1);
  assert(
    sent.length === 1 && sent[0][1] === 39,
    "first half sends rows-1 so ConPTY cannot coalesce",
  );
  await settle();
  assert(sent.length === 2, "second half lands after the gap");
  assert(
    sent[1][0] === 120 && sent[1][1] === 40,
    "and restores the real size when nothing moved in between",
  );
  assert(s.lastSentCols === 120 && s.lastSentRows === 40, "lastSent* ends up matching xterm");
}

console.log("\nthe restore reads the LIVE size, not the one captured before the gap");
{
  const sent: number[][] = [];
  const s = session(120, 40, sent);
  nudgeResizeRoundTrip(s, 1);
  // A tab switch / font-size change inside the gap: xterm re-fits and the
  // direct `syncPtySize` path already pushed the new size.
  (s.term as { cols: number; rows: number }).cols = 80;
  (s.term as { cols: number; rows: number }).rows = 24;
  s.lastSentCols = 80;
  s.lastSentRows = 24;
  await settle();
  assert(
    sent[1][0] === 80 && sent[1][1] === 24,
    "restores 80x24 (the pane's size now), not the stale 120x40",
  );
  assert(
    s.lastSentCols === 80 && s.lastSentRows === 24,
    "and leaves lastSent* agreeing with xterm, so syncPtySize has nothing to un-do",
  );
}

console.log("\nthe nudge stays inside the floor and bails on a dead/replaced session");
{
  const sent: number[][] = [];
  const s = session(MIN_PTY_DIM, MIN_PTY_DIM, sent);
  nudgeResizeRoundTrip(s, 1);
  assert(sent[0][1] === MIN_PTY_DIM + 1, "at the floor it nudges UP, never below MIN_PTY_DIM");
  await settle();
  assert(sent[1][1] === MIN_PTY_DIM, "and restores back to the floor");
}
{
  const sent: number[][] = [];
  const s = session(120, 40, sent);
  nudgeResizeRoundTrip(s, 1);
  s.ptySpawnEpoch = 2; // a respawn superseded this spawn
  await settle();
  assert(sent.length === 1, "a superseded spawn never gets the restore resize");
}
{
  const sent: number[][] = [];
  const s = session(120, 40, sent);
  nudgeResizeRoundTrip(s, 1);
  s.disposed = true;
  await settle();
  assert(sent.length === 1, "a disposed session never gets the restore resize");
}

// --- what `windowsPty` actually changes, against the real xterm ------------
// Deep-imported ESM build: the bare `@xterm/xterm` specifier resolves to the CJS
// `main` here and yields no named `Terminal`. This needs the REAL implementation,
// not a stand-in, since the whole point is to pin xterm's own resize behaviour.
const { Terminal } = (await import("@xterm/xterm/lib/xterm.mjs")) as unknown as {
  Terminal: new (opts: Record<string, unknown>) => ProbeTerm;
};

type ProbeTerm = {
  write(d: string, cb?: () => void): void;
  resize(c: number, r: number): void;
  rows: number;
  buffer: {
    active: {
      type: string;
      baseY: number;
      cursorY: number;
      length: number;
      getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
};

const CONPTY = { backend: "conpty", buildNumber: 26200 };
const mkTerm = (windowsPty?: unknown) =>
  new Terminal({ cols: 20, rows: 5, scrollback: 100, ...(windowsPty ? { windowsPty } : {}) });
const feed = (t: ProbeTerm, s: string) => new Promise<void>((r) => t.write(s, r));

/** Everything a resize can disturb: the visible rows, where the viewport starts,
 *  and which row the cursor is on (what an inline redraw is measured from). */
function shape(t: ProbeTerm): string {
  const b = t.buffer.active;
  const lines: string[] = [];
  for (let y = b.baseY; y < b.baseY + t.rows; y++) {
    lines.push(b.getLine(y)?.translateToString(true) ?? "");
  }
  return JSON.stringify({ type: b.type, baseY: b.baseY, cursorY: b.cursorY, lines });
}

/** Run `act` on a plain terminal and on a ConPTY one; return both shapes. */
async function bothWays(act: (t: ProbeTerm) => Promise<void>): Promise<[string, string]> {
  const out: string[] = [];
  for (const opt of [undefined, CONPTY]) {
    const t = mkTerm(opt);
    await act(t);
    out.push(shape(t));
  }
  return [out[0], out[1]];
}

// 8 lines of history in a 5-row viewport, so baseY = 3 and the Unix branch that
// `windowsPty` replaces (pull scrollback back down) is actually reachable.
const fillHistory = (t: ProbeTerm) => feed(t, "s1\r\ns2\r\ns3\r\ns4\r\ns5\r\ns6\r\ns7\r\nPROMPT>");
const enterTui = async (t: ProbeTerm) => {
  await feed(t, "\x1b[?1049h");
  await feed(t, "\x1b[H TUI-A\r\n TUI-B\r\n TUI-C");
};

console.log("\nthe shell case it is meant to fix (normal buffer, MORE rows)");
{
  const [plain, conpty] = await bothWays(async (t) => {
    await fillHistory(t);
    t.resize(20, 8);
    await feed(t, "");
  });
  assert(plain !== conpty, "growing rows behaves differently — the option is doing something");
  assert(
    JSON.parse(conpty).cursorY === 4 && JSON.parse(conpty).baseY === 3,
    "ConPTY: cursor row and viewport start HOLD (blank rows are appended below)",
  );
  assert(
    JSON.parse(plain).cursorY === 7 && JSON.parse(plain).baseY === 0,
    "default: scrollback is pulled down and the cursor row shifts — the reported corruption",
  );
}

console.log("\na RUNNING TUI on the alternate screen must not notice (vim, htop, lazygit)");
for (const [what, cols, rows] of [
  ["more rows", 20, 8],
  ["fewer rows", 20, 3],
  ["narrower", 10, 5],
] as const) {
  const [plain, conpty] = await bothWays(async (t) => {
    await fillHistory(t);
    await enterTui(t);
    t.resize(cols, rows);
    await feed(t, "");
  });
  assert(
    plain === conpty,
    `alt-screen resize (${what}) is byte-identical with and without the option`,
  );
  assert(
    JSON.parse(conpty).type === "alternate",
    `alt-screen resize (${what}) stayed on the alt buffer`,
  );
}

console.log("\nreflow is untouched, so no rewrap path changes (shrink and grow back)");
{
  const wide = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh\r\ntail";
  const [narrowPlain, narrowConpty] = await bothWays(async (t) => {
    await feed(t, wide);
    t.resize(10, 5);
    await feed(t, "");
  });
  assert(narrowPlain === narrowConpty, "narrowing a wrapped line reflows identically");
  const [backPlain, backConpty] = await bothWays(async (t) => {
    await feed(t, wide);
    t.resize(10, 5);
    await feed(t, "");
    t.resize(20, 5);
    await feed(t, "");
  });
  assert(backPlain === backConpty, "widening it back reflows identically");
  const [shrinkPlain, shrinkConpty] = await bothWays(async (t) => {
    await fillHistory(t);
    t.resize(20, 3);
    await feed(t, "");
  });
  assert(shrinkPlain === shrinkConpty, "FEWER rows on the normal buffer is identical too");
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`terminal-resize-verify: ${failed} check(s) failed`);
console.log("\nterminal-resize-verify: all checks passed");
