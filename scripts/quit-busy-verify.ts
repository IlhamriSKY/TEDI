/**
 * Busy-terminal audit for the quit prompt. `isSessionBusy` decides whether
 * closing the window (or a tab) asks first, so a false negative silently kills a
 * running build and a false positive nags on every quit. Verifies the four ways
 * a session reads busy and the two that must not.
 * Run: `npx tsx scripts/quit-busy-verify.ts`.
 *
 * sessionState.ts is type-only at runtime (no xterm import), so this runs under
 * plain node with hand-built session stubs.
 */
import {
  busyTerminalCount,
  isSessionBusy,
  sessions,
  type Session,
} from "../src/modules/terminal/lib/sessionState";

type Stub = {
  disposed?: boolean;
  bufferType?: "normal" | "alternate";
  commandRunning?: boolean;
  aiState?: "idle" | "working" | "blocking" | "done";
  /** Make `term.buffer.active` throw, as a disposed xterm does. */
  termThrows?: boolean;
};

function session(s: Stub = {}): Session {
  return {
    disposed: s.disposed ?? false,
    commandRunning: s.commandRunning ?? false,
    aiCliStatus: s.aiState ? { tool: "claude", state: s.aiState, since: 0 } : null,
    term: {
      get buffer(): { active: { type: string } } {
        if (s.termThrows) throw new Error("term disposed");
        return { active: { type: s.bufferType ?? "normal" } };
      },
    },
  } as unknown as Session;
}

const CASES: [string, Session, boolean][] = [
  ["idle shell at a prompt", session(), false],
  ["a finished agent turn (done)", session({ aiState: "done" }), false],
  ["a TUI on the alt-screen", session({ bufferType: "alternate" }), true],
  ["an in-flight OSC 133 command", session({ commandRunning: true }), true],
  ["an agent mid-turn", session({ aiState: "working" }), true],
  ["an agent waiting for approval", session({ aiState: "blocking" }), true],
  // A disposed session is already gone; it must never hold the quit up.
  ["a disposed session still running", session({ disposed: true, commandRunning: true }), false],
  // A disposed xterm throws on buffer access: fall through to the flags, don't crash.
  [
    "a torn-down term with a live command",
    session({ termThrows: true, commandRunning: true }),
    true,
  ],
];

let failures = 0;
for (const [name, s, want] of CASES) {
  const got = isSessionBusy(s);
  if (got === want) {
    console.log(`  ok    ${name} -> ${got ? "busy" : "idle"}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}: expected ${want}, got ${got}`);
  }
}

// busyTerminalCount spans every workspace's sessions, counting only the busy ones.
sessions.set(1, session());
sessions.set(2, session({ commandRunning: true }));
sessions.set(3, session({ aiState: "working" }));
sessions.set(4, session({ disposed: true, commandRunning: true }));
const count = busyTerminalCount();
if (count === 2) {
  console.log("  ok    busyTerminalCount counts only busy, non-disposed sessions -> 2");
} else {
  failures++;
  console.error(`  FAIL  busyTerminalCount: expected 2, got ${count}`);
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failures > 0) throw new Error(`${failures} busy-detection failure(s)`);
console.log("\nquit-busy-verify: OK");
