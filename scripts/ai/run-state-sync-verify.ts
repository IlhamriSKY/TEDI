/**
 * The agent's run state has two copies: the SDK's live `chat.status` and the
 * `agentMeta.status` mirror AgentRunBridge derives from it, which the composer
 * (Send vs Stop, the prompt queue, `/goal`) reads. These pin the three places
 * the mirror used to fall out of step with the chat it mirrors.
 * Run: `npx tsx scripts/ai/run-state-sync-verify.ts`.
 *
 * 1. A session switch resets the mirror to idle. Two chats that are both
 *    streaming have the same `status`, so unless the bridge re-derives on the
 *    session id too, the new chat read "idle" mid-turn and Enter started a
 *    second request on it.
 * 2. Stop must not force the mirror to idle while the turn is still aborting.
 *    The queue fires on the busy -> idle EDGE; forcing idle first made the real
 *    edge a no-op, so "Send now (interrupt)" left its prompt stuck in the queue.
 * 3. Every change of the active session bumps `switchSeq`, the instant ones
 *    too, or a slow history load from an earlier click flips you back to it.
 *
 * Source-text checks, like most of this suite: the behaviour lives in effects
 * and an SDK class that need a DOM to run.
 */
import { readFileSync } from "node:fs";

let failed = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

console.log("[bridge] the mirror re-derives when the session changes");
ok(
  "status effect depends on sessionId",
  /\}, \[status, approvalsPending, patch, sessionId\]\);/.test(
    src("src/modules/ai/components/AgentRunBridge.tsx"),
  ),
);

console.log("\n[stop] a running turn reaches idle through the bridge, not by hand");
const composer = src("src/modules/ai/lib/composer.tsx");
const stop = composer.slice(
  composer.indexOf("const stop = useCallback"),
  composer.indexOf("const canSend"),
);
ok("stop no longer calls resetAgentMeta", !/resetAgentMeta/.test(stop));
ok("only a turn that is not running is cleared by hand", /if \(!running\)/.test(stop));
ok("an errored chat is cleared too", /chat\.clearError\(\)/.test(stop));

console.log("\n[switch] every active-session change bumps the token");
const store = src("src/modules/ai/store/chatStore.ts");
const sw = store.slice(
  store.indexOf("switchSession: (id) =>"),
  store.indexOf("deleteSession: (id) =>"),
);
ok(
  "switchSession bumps before the cached fast path",
  sw.indexOf("++switchSeq") > -1 && sw.indexOf("++switchSeq") < sw.indexOf("chats.has(id) ||"),
);
const ns = store.slice(store.indexOf("newSession: () =>"), store.indexOf("switchSession: (id) =>"));
ok("newSession bumps it", /switchSeq\+\+/.test(ns));

if (failed > 0) throw new Error(`run-state-sync-verify: ${failed} FAILED`);
console.log("\nrun-state-sync-verify: OK");
