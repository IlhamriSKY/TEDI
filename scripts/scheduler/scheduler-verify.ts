/**
 * Self-check for the schedule engine (`src/modules/scheduler/lib/engine.ts`).
 *
 * Run: `npx tsx scripts/scheduler/scheduler-verify.ts` (or `pnpm verify scheduler`).
 *
 * The engine had NO check at all, which is how the boot race below shipped: it
 * only misbehaves when a `create()` lands inside the window where `boot()` is
 * still awaiting the store's first IPC round trip, so nothing a human does by
 * hand reproduces it, and the damage (every OTHER saved schedule erased from
 * disk) is invisible until the next launch.
 *
 * The engine is exercised for real, not modelled: `LazyStore` only touches Tauri
 * when a value is read or written, so an `__TAURI_INTERNALS__.invoke` stub over
 * an in-memory map gives the true persistence path. `setTimeout` is real too -
 * the delays here are tens of milliseconds, and a faked clock would stop testing
 * the one thing this file exists to test.
 */

// Stub Tauri BEFORE the engine's store module loads. `window` has to exist as
// well: `@tauri-apps/api` reads it at import time.
const disk: Record<string, unknown> = {};
/** Set to make the next read throw, for the unreadable-store check below. */
let breakReads = false;
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd.endsWith("load") || cmd.endsWith("get_store")) return "rid";
    if (cmd === "plugin:store|get") {
      if (breakReads) throw new Error("store is locked by another process");
      const key = args.key as string;
      return [disk[key], disk[key] !== undefined];
    }
    if (cmd === "plugin:store|set") {
      disk[args.key as string] = args.value;
      return null;
    }
    return null;
  },
  transformCallback: (cb: unknown) => cb,
};

const { scheduler, setSchedulerBridge } = await import("../../src/modules/scheduler/lib/engine");
import type { Schedule } from "../../src/modules/scheduler/types";

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the bridge was asked to do, in order. */
const sent: string[] = [];
const notices: string[] = [];
setSchedulerBridge({
  listTerminals: () => [],
  injectIntoTerminal: (_target, text) => {
    sent.push(`inject:${text}`);
    return true;
  },
  runInTerminal: (_target, command) => {
    sent.push(`run:${command}`);
    return true;
  },
  notify: (message, level) => notices.push(`${level}:${message}`),
});

const saved = (): Schedule[] => (disk.schedules as Schedule[] | undefined) ?? [];

// ---------------------------------------------------------------------------
// 0. An unreadable store fails loudly and is RETRIED, not cached as dead.
// ---------------------------------------------------------------------------
// Runs first because `boot` is once per process by design, and this is the one
// state a later section cannot get back to. Two halves, both load-bearing: the
// rejection has to reach the caller (a `create` that proceeded on a list that
// never loaded would `persist()` its one row over the real file, turning one
// failed READ into a wiped file), and the failure must not be remembered, or a
// single locked read leaves scheduling dead for the life of the window.
console.log("[unreadable store] boot rejects, and the next call tries again");

breakReads = true;
let bootError: unknown = null;
await scheduler.boot().catch((err: unknown) => {
  bootError = err;
});
if (!bootError) fail("boot resolved even though the store could not be read");
else ok("boot rejects rather than starting on a list that never loaded");

let createError: unknown = null;
await scheduler
  .create({ fireAt: Date.now() + 60_000, command: "never", action: "submit", target: {} })
  .catch((err: unknown) => {
    createError = err;
  });
if (!createError) fail("a create went through on a store that could not be read");
else ok("a create on top of a failed boot is refused, so nothing overwrites the file");
if (saved().length > 0) fail("the failed create still wrote to the store");
else ok("nothing was written");

breakReads = false;

// ---------------------------------------------------------------------------
// 1. THE REGRESSION: a create during boot must not erase what is on disk.
// ---------------------------------------------------------------------------
// This also proves the retry: the boot above rejected, so a cached failure
// would make every call below fail the same way.
console.log("\n[boot race] a schedule created while boot is loading keeps the saved ones");

// One row already on disk, exactly as a previous session left it.
const preexisting: Schedule = {
  id: "sch-preexisting",
  fireAt: Date.now() + 90_000,
  command: "from a previous session",
  action: "submit",
  target: {},
  createdAt: Date.now(),
  status: "pending",
};
// And one whose time passed while TEDI was closed, which boot must still fire.
const overdue: Schedule = {
  id: "sch-overdue",
  fireAt: Date.now() - 60_000,
  command: "echo overdue",
  action: "submit",
  target: {},
  createdAt: Date.now() - 120_000,
  status: "pending",
};
disk.schedules = [preexisting, overdue];

// `create` first, `boot` second, both in flight together - the ordering an
// agent scheduling something during app startup produces.
const created = scheduler.create({
  fireAt: Date.now() + 60_000,
  command: "from this turn",
  action: "submit",
  target: {},
});
const booted = scheduler.boot();
await Promise.all([created, booted]);

const ids = scheduler.getAll().map((s) => s.id);
if (!ids.includes("sch-preexisting")) {
  fail("the schedule already on disk was dropped by a create that raced boot");
} else if (scheduler.getAll().every((s) => s.command !== "from this turn")) {
  fail("the schedule created during boot was dropped when boot loaded the store");
} else ok("both the saved schedule and the one created during boot survive");

if (!saved().some((s) => s.id === "sch-preexisting")) {
  fail("the saved file was overwritten with only the new schedule - user data lost");
} else ok("the store still holds the pre-existing schedule");

// ---------------------------------------------------------------------------
// 2. A due schedule fires through the bridge, once.
// ---------------------------------------------------------------------------
console.log("\n[fire] a due schedule reaches the terminal bridge and is marked fired");

const run = await scheduler.create({
  fireAt: Date.now() + 30,
  command: "echo submitted",
  action: "submit",
  target: {},
});
await scheduler.create({
  fireAt: Date.now() + 30,
  command: "echo typed",
  action: "inject",
  target: {},
});
await sleep(250);

if (!sent.includes("run:echo submitted")) fail('action "submit" did not run the command');
else ok('action "submit" runs the command in the terminal');
if (!sent.includes("inject:echo typed")) fail('action "inject" did not type the command');
else ok('action "inject" types without running');

const fired = scheduler.getAll().filter((s) => s.status === "fired");
if (fired.length !== 2) fail(`expected 2 fired schedules, got ${fired.length}`);
else ok("both are marked fired");
// A fired schedule must be persisted as fired: a crash between firing and the
// next launch would otherwise re-run it.
if (saved().find((s) => s.id === run.id)?.status !== "fired") {
  fail("a fired schedule is still persisted as pending - it would re-run on next launch");
} else ok("the fired status is written to the store");
if (!notices.some((n) => n.startsWith("success:"))) fail("firing raised no notification");
else ok("firing notifies the user");

// ---------------------------------------------------------------------------
// 3. Cancel disarms the timer.
// ---------------------------------------------------------------------------
console.log("\n[cancel] a cancelled schedule never reaches the bridge");

const doomed = await scheduler.create({
  fireAt: Date.now() + 80,
  command: "echo must not run",
  action: "submit",
  target: {},
});
if (!(await scheduler.cancel(doomed.id))) fail("cancel refused a pending schedule");
await sleep(250);
if (sent.includes("run:echo must not run")) fail("a cancelled schedule still fired");
else ok("a cancelled schedule does not fire");
if (scheduler.getAll().find((s) => s.id === doomed.id)?.status !== "cancelled") {
  fail("the cancelled schedule is not marked cancelled");
} else ok("it is marked cancelled");
if (await scheduler.cancel(doomed.id)) fail("cancelling twice reported success the second time");
else ok("cancelling an already-cancelled schedule reports failure");
if (await scheduler.cancel("sch-nope")) fail("cancelling an unknown id reported success");
else ok("cancelling an unknown id reports failure");

// ---------------------------------------------------------------------------
// 4. A past-due schedule left by a previous session fires after boot.
// ---------------------------------------------------------------------------
// BEFORE the failing bridge is installed below, not after: `sch-overdue` was
// armed by the boot in section 1 for 1.5s from then, and whichever bridge
// happens to be installed when that timer expires is the one it fires into.
console.log("\n[past due] a schedule whose time passed while TEDI was closed still fires");

// The engine holds a past-due schedule 1.5s so terminals can mount. Wait out
// whatever is left of that window from here.
await sleep(1_500);
if (!sent.includes("run:echo overdue")) fail("the past-due schedule from disk never fired");
else ok("a past-due schedule fires shortly after boot");
if (scheduler.getAll().find((s) => s.id === overdue.id)?.status !== "fired") {
  fail("the past-due schedule is not marked fired");
} else ok("it is marked fired");

// ---------------------------------------------------------------------------
// 5. A failing terminal is recorded, not swallowed.
// ---------------------------------------------------------------------------
console.log("\n[failure] no matching terminal is reported as failed, with a reason");

setSchedulerBridge({
  listTerminals: () => [],
  injectIntoTerminal: () => false,
  runInTerminal: () => false,
  notify: (message, level) => notices.push(`${level}:${message}`),
});
const orphan = await scheduler.create({
  fireAt: Date.now() + 30,
  command: "echo nowhere",
  action: "submit",
  target: { ordinal: 99 },
});
await sleep(250);
const orphanRow = scheduler.getAll().find((s) => s.id === orphan.id);
if (orphanRow?.status !== "failed") fail(`expected status "failed", got "${orphanRow?.status}"`);
else if (!orphanRow.error) fail("a failed schedule carries no reason");
else ok(`a schedule with no matching terminal fails with: ${orphanRow.error}`);
if (!notices.some((n) => n.startsWith("error:"))) fail("a failure raised no notification");
else ok("failure notifies the user");

// ---------------------------------------------------------------------------
// 6. History is pruned, pending is never pruned.
// ---------------------------------------------------------------------------
console.log("\n[prune] finished rows age out; pending rows never do");

const pendingBefore = scheduler.getAll().filter((s) => s.status === "pending").length;
await scheduler.pruneHistory(0);
const after = scheduler.getAll();
if (after.some((s) => s.status !== "pending")) fail("pruneHistory(0) left a finished schedule");
else ok("finished schedules are pruned");
if (after.length !== pendingBefore) fail("pruneHistory dropped a pending schedule");
else ok(`all ${pendingBefore} pending schedules survive a prune`);

console.log(`\n${"=".repeat(60)}`);
if (failed > 0) {
  console.error(`scheduler-verify: ${failed} failure(s)`);
  process.exit(1);
}
console.log("scheduler-verify: all checks passed");
process.exit(0);
