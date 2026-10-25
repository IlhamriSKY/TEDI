/**
 * Self-check for OSC 52 (registerClipboardHandler).
 * Run: `npx tsx scripts/terminal/osc52-clipboard-verify.ts`.
 *
 * tmux, nvim and a remote shell copy to the LOCAL clipboard with
 * `ESC ] 52 ; c ; <base64> BEL`, the only way they can over SSH. The handler
 * must copy that text, and must REFUSE the read form (`52;c;?`): answering it
 * would hand any program in the terminal whatever the user last copied.
 */
import type { Terminal } from "@xterm/xterm";
import {
  OSC52_MAX_B64,
  registerClipboardHandler,
} from "../../src/modules/terminal/lib/osc-handlers";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

let handler: ((data: string) => boolean) | null = null;
const fakeTerm = {
  parser: {
    registerOscHandler(code: number, fn: (data: string) => boolean) {
      if (code === 52) handler = fn;
      return { dispose() {} };
    },
  },
} as unknown as Terminal;

const copied: string[] = [];
registerClipboardHandler(fakeTerm, (t) => copied.push(t));
const send = (data: string) => handler!(data);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

console.log("\nOSC 52 copies into the clipboard, never out of it\n");

assert(handler !== null, "the handler registers on OSC 52");
assert(send(`c;${b64("hello")}`) && copied.at(-1) === "hello", "a plain copy lands");
send(`;${b64("no target")}`);
assert(copied.at(-1) === "no target", "an empty target list still copies (tmux sends it)");
send(`c;${b64("héllo ✓")}`);
assert(copied.at(-1) === "héllo ✓", "UTF-8 survives the base64 round trip");

const before = copied.length;
assert(
  send("c;?") === true && copied.length === before,
  "the read query is swallowed, not answered",
);
send("c;" + "A".repeat(OSC52_MAX_B64 + 4));
assert(copied.length === before, "an oversized payload is dropped");
send("c;");
send("c;@@@not-base64@@@");
send("nosemicolon");
assert(copied.length === before, "empty, malformed and non-base64 payloads copy nothing");

if (failed > 0) throw new Error(`osc52-clipboard-verify: ${failed} check(s) failed`);
console.log("\nosc52-clipboard-verify: all checks passed");
