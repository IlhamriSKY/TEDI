/**
 * The four-word run state TEDI's own agent reports per chat session, which the
 * Board groups on and the pane icon tints.
 *
 * Two properties are easy to get wrong and silent when they are:
 *
 * 1. `blocking` must win over everything. A turn that is streaming AND has a
 *    tool waiting on the user is BLOCKED - reporting `working` would bury the
 *    approval in the wrong Board column, which is precisely the column the user
 *    is watching.
 * 2. `done` is an EDGE, not a status. No chat ever reports "done"; it is the
 *    working -> quiet transition, and only that. Deriving it from "quiet with
 *    messages" instead would mark every idle chat done forever, and the column
 *    that means "this finished while you were away" would stop meaning it.
 *
 * Run: `npx tsx scripts/ai/session-status-verify.ts`.
 */
import { deriveAiState } from "../../src/modules/ai/lib/sessionStatus";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
    failures++;
  }
}

console.log("\n[state] a chat's run state, in the terminal agent's vocabulary");

check("a quiet chat that was quiet is idle", deriveAiState("ready", 0, false), "idle");
check("a submitted turn is working", deriveAiState("submitted", 0, false), "working");
check("a streaming turn is working", deriveAiState("streaming", 0, false), "working");

console.log("\n[blocking] anything waiting on the user outranks the rest");

check("a pending approval blocks", deriveAiState("ready", 1, false), "blocking");
check("and outranks streaming", deriveAiState("streaming", 2, false), "blocking");
check("and outranks a just-finished turn", deriveAiState("ready", 1, true), "blocking");
check("an error needs the user too", deriveAiState("error", 0, false), "blocking");

console.log("\n[done] the working -> quiet EDGE, never a standing state");

check("a turn that just ended is done", deriveAiState("ready", 0, true), "done");
check("a chat that was already quiet is not", deriveAiState("ready", 0, false), "idle");
// The edge is consumed by the caller resetting its flag, so a second quiet
// render must not re-report done - that is what would pin the badge on forever.
check("and does not repeat once consumed", deriveAiState("ready", 0, false), "idle");

if (failures > 0) throw new Error(`session-status-verify: ${failures} FAILED`);
console.log("\nsession-status-verify: OK");
