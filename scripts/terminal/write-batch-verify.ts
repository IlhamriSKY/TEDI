/**
 * Self-check for the unfocused-pane write batch (createWriteBatch).
 * Run: `npx tsx scripts/terminal/write-batch-verify.ts`.
 *
 * A pane without keyboard focus hands xterm its output at most every
 * UNFOCUSED_WRITE_MS, so a second agent streaming beside the one you type in
 * repaints ~30 times a second instead of on every chunk. It must:
 *  1. FOCUSED IS IMMEDIATE: a focused pane's bytes are never delayed (typing echo).
 *  2. UNFOCUSED IS BATCHED: chunks wait for one timer, one timer per burst.
 *  3. ORDER: a focused push releases anything held first, so bytes never reorder.
 *  4. STALE: a release after dispose writes nothing.
 * And the host side must actually be told about hidden panes (source text).
 */
import { readFileSync } from "node:fs";
import { createWriteBatch } from "../../src/modules/terminal/lib/writeMeter";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function harness() {
  const written: string[] = [];
  const timers: (() => void)[] = [];
  let stale = false;
  const b = createWriteBatch(
    (bytes) => written.push(dec.decode(bytes)),
    () => stale,
    33,
    (fn) => timers.push(fn),
  );
  return {
    push: (s: string, focused: boolean) => b.push(enc.encode(s), focused),
    written,
    timers,
    fire: () => timers.splice(0).forEach((t) => t()),
    dispose: () => (stale = true),
  };
}

console.log("\nunfocused panes batch their xterm writes\n");

{
  const h = harness();
  h.push("a", true);
  h.push("b", true);
  assert(h.written.join() === "a,b" && h.timers.length === 0, "a focused pane writes at once");
}
{
  const h = harness();
  h.push("a", false);
  h.push("b", false);
  h.push("c", false);
  assert(h.written.length === 0, "an unfocused pane holds its chunks");
  assert(h.timers.length === 1, "one timer per burst, not one per chunk");
  h.fire();
  assert(h.written.join("") === "abc", "the timer releases them in order");
  h.push("d", false);
  assert(h.timers.length === 1, "the next burst arms a fresh timer");
}
{
  const h = harness();
  h.push("1", false);
  h.push("2", false);
  h.push("3", true);
  assert(h.written.join("") === "123", "gaining focus releases held output before the new bytes");
  h.fire();
  assert(h.written.join("") === "123", "the stale timer then writes nothing twice");
}
{
  const h = harness();
  h.push("x", false);
  h.dispose();
  h.fire();
  h.push("y", true);
  assert(h.written.length === 0, "nothing reaches a disposed pane");
}

const pl = readFileSync("src/modules/terminal/lib/pty-lifecycle.ts", "utf8");
assert(
  /batch\.push\(bytes, s\.focused\)/.test(pl),
  "pty-lifecycle routes PTY output through the batch",
);
assert(
  /setVisible\?\.|pty\?\.setVisible/.test(pl),
  "syncPtyVisible tells the host about hidden panes",
);
const bridge = readFileSync("src/modules/terminal/lib/pty-bridge.ts", "utf8");
assert(/invoke\("pty_set_visible"/.test(bridge), "the local PTY bridge calls pty_set_visible");
const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
assert(lib.includes("pty::pty_set_visible"), "pty_set_visible is registered in invoke_handler");

if (failed > 0) throw new Error(`write-batch-verify: ${failed} check(s) failed`);
console.log("\nwrite-batch-verify: all checks passed");
