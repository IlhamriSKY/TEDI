/**
 * Self-check for `/loop`: the interval parser, and that a tick enqueues into the
 * prompt queue only for its own active session and never stacks copies. The
 * `/loop` command itself is a thin parser over these; it lives in
 * slashCommands, whose import chain needs a browser (xterm).
 * Run: `npx tsx scripts/ai/loop-verify.ts`.
 */
import {
  formatInterval,
  loopOf,
  parseInterval,
  startLoop,
  stopLoop,
} from "../../src/modules/ai/lib/loop";

// A stand-in for the chat store slice the loop reads.
const state = {
  sessions: [] as { id: string }[],
  activeSessionId: null as string | null,
  promptQueue: [] as { text: string; sessionId: string | null }[],
  enqueuePrompt: (text: string, sessionId?: string | null) =>
    void state.promptQueue.push({ text, sessionId: sessionId ?? state.activeSessionId }),
};
const host = () => state;
const useChatStore = {
  getState: () => state,
  setState: (p: Partial<typeof state>) => Object.assign(state, p),
};

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

console.log("[interval] parsed strictly, bounded");
assert(parseInterval("10m") === 600_000, "10m");
assert(parseInterval("1h30m") === 5_400_000, "1h30m");
assert(parseInterval("90s") === 90_000, "90s is over the 1m floor");
assert(parseInterval("30s") === null, "under a minute is refused");
assert(parseInterval("8d") === null, "over a week is refused");
assert(parseInterval("5") === null, "a bare number has no unit");
assert(parseInterval("5 minutes") === null, "prose is not an interval");
assert(formatInterval(600_000) === "10m" && formatInterval(7_200_000) === "2h", "formats back");

console.log("\n[tick] enqueues for its own active session only, never stacks");
{
  const S = "s-loop";
  useChatStore.setState({
    sessions: [{ id: S, title: "t", createdAt: 0, updatedAt: 0 }],
    activeSessionId: S,
    promptQueue: [],
  });
  startLoop(S, 600_000, "check the build", host);
  assert(useChatStore.getState().promptQueue.length === 1, "runs once right away");
  assert(loopOf(S)?.runs === 1, "and counts it");
  stopLoop(S);
  startLoop(S, 600_000, "check the build", host);
  assert(
    useChatStore.getState().promptQueue.length === 1,
    "a copy still waiting in the queue is not stacked again",
  );
  stopLoop(S);
  assert(loopOf(S) === null, "stop ends it");

  useChatStore.setState({ activeSessionId: "s-other", promptQueue: [] });
  startLoop(S, 600_000, "check the build", host);
  const q = useChatStore.getState().promptQueue;
  assert(
    q.length === 1 && q[0].sessionId === S,
    "a tick while another chat is open is queued for ITS OWN chat, never the open one",
  );
  stopLoop(S);
}

console.log(failed === 0 ? "\nAll loop checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
