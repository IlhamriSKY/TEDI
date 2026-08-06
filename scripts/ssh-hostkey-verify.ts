/**
 * Self-check for when an SSH host key is TRUSTED, and for which saved host.
 * Run: `npx tsx scripts/ssh-hostkey-verify.ts`.
 *
 * The bug this exists to prevent, reported twice by users on the same day:
 * "Verify SSH host key" kept coming back for a host they had already trusted.
 * Both reports were the same root cause. Trusting the key was only recorded
 * after a FULLY successful connect, so a rejected password threw the answer
 * away and asked again on the next attempt, and a key accepted during the
 * dialog's Test was gone by the time the connection was saved. `openssh` writes
 * `known_hosts` the moment you answer yes, before any credential is sent, which
 * is the behaviour being matched: verifying the server and proving who you are
 * are two different steps and only the first one is being answered here.
 *
 * So the two things pinned down: the accept hook runs on accept ONLY, and it
 * runs BEFORE the backend is told (a failing IPC must not lose the trust), and
 * a prompt is attributed to the right saved connection, since one connect can
 * be dialling a whole ProxyJump chain and the prompt only names a host.
 */
import { hostKeyOwners, useHostKeyPrompt } from "../src/modules/ssh/hostKeyPrompt";
import type { SshHostKeyPrompt } from "../src/modules/ssh/bridge";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

console.log("[owners] a prompt names a host; the pin belongs on the connection(s) using it");
const target = { host: "db.internal", connectionId: "c-target" };
const bastion = { host: "bastion.example.com", connectionId: "c-bastion" };
const relay = { host: "relay.example.com", connectionId: "c-relay" };

check("the target's own key", hostKeyOwners("db.internal", target, []), ["c-target"]);
check(
  "a jump host's key lands on the JUMP, not the target",
  hostKeyOwners("bastion.example.com", target, [bastion]),
  ["c-bastion"],
);
check(
  "the target's key, dialled through a chain",
  hostKeyOwners("db.internal", target, [bastion, relay]),
  ["c-target"],
);
check("the deeper hop in a chain", hostKeyOwners("relay.example.com", target, [bastion, relay]), [
  "c-relay",
]);
// A host TEDI is not dialling in this connect has no row to pin: recording it
// against the target would write another machine's key onto it, and the next
// connect would then refuse as a key mismatch, which reads as an attack.
check("an unrelated host pins nothing", hostKeyOwners("evil.example.com", target, [bastion]), []);
// Two different saved hosts can point at the same machine (one as a jump, one
// as a target). Same machine means the same key, so both rows are right, and
// pinning both spares the other one a prompt it would answer identically.
check(
  "one machine saved twice gets both rows",
  hostKeyOwners("bastion.example.com", { host: "bastion.example.com", connectionId: "c-direct" }, [
    bastion,
  ]),
  ["c-direct", "c-bastion"],
);
check(
  "the same hop twice in a chain is not pinned twice",
  hostKeyOwners("bastion.example.com", target, [bastion, bastion]),
  ["c-bastion"],
);

console.log("\n[queue] trust is recorded on accept, and only on accept");
const prompt = (id: string): SshHostKeyPrompt => ({
  promptId: id,
  fingerprint: `SHA256:${id}`,
  host: "db.internal",
});
const store = () => useHostKeyPrompt.getState();

{
  let pinned = 0;
  store().enqueue(prompt("p1"), () => pinned++);
  check("queued", store().queue.length, 1);
  store().enqueue(prompt("p1"), () => pinned++);
  check("the same prompt is not queued twice", store().queue.length, 1);

  // `confirmHostKey` reaches Tauri, which does not exist here. That is the
  // point of the ordering: the hook has already run by the time the IPC blows
  // up, so a dead backend cannot cost the user the answer they just gave.
  try {
    store().resolve("p1", true);
  } catch {
    // ignored: no Tauri in a node script
  }
  assert(pinned === 1, "accepting runs the pin hook exactly once");
  check("and dequeues", store().queue.length, 0);
}

{
  let pinned = 0;
  store().enqueue(prompt("p2"), () => pinned++);
  try {
    store().resolve("p2", false);
  } catch {
    // ignored
  }
  assert(pinned === 0, "rejecting never pins");
  check("but still dequeues", store().queue.length, 0);
}

{
  // A handshake that died on its own (connect failed, confirm timed out) drops
  // its prompt without answering. Nothing was trusted, so nothing is pinned.
  let pinned = 0;
  store().enqueue(prompt("p3"), () => pinned++);
  store().dismiss("p3");
  assert(pinned === 0, "dismissing a dead prompt never pins");
  check("and leaves an empty queue", store().queue.length, 0);
}

console.log(failed === 0 ? "\nAll ssh-hostkey checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
