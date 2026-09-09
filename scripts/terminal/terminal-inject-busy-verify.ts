/**
 * Self-check for the busy guard on the terminal-writing path.
 * Run: `npx tsx scripts/terminal/terminal-inject-busy-verify.ts`.
 *
 * Writing to a terminal that is running a command or showing a full-screen TUI
 * (an AI CLI at its prompt is exactly that) puts the bytes into THAT program's
 * input buffer, appended to whatever the user was already typing - two prompts
 * silently merged into one line. Nothing errors; the line is just wrong.
 *
 * Every write to a terminal now goes through the one `sh` handler on TEDI's
 * in-process MCP server, so the guard has one home and this checks it there.
 *
 * STRUCTURAL, not functional, and not by preference: `tediMcpServer.ts` reaches
 * the extension store, which reaches xterm, which cannot load outside a browser.
 * `shell-transform-verify.ts` is structural for the same reason.
 */
import { readFile } from "node:fs/promises";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${label}`);
    return;
  }
  console.error(`  FAIL: ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const SRC = "src/modules/ai/lib/tediMcpServer.ts";
const src = await readFile(SRC, "utf8");

// The `sh` handler only: a guard somewhere else in the file proves nothing.
const start = src.indexOf("  sh: async");
const handler = start === -1 ? "" : src.slice(start, src.indexOf("\n  wait_for_terminal:", start));

console.log("[sh] the busy guard is in the handler, before anything is written");
check("the sh handler was found", handler.length > 0);

const busyAt = handler.indexOf('bridge<boolean>("termBusy"');
const runAt = handler.indexOf('"termRun"');
const injectAt = handler.indexOf('"termInject"');

check("it asks whether the pane is busy", busyAt !== -1);
check("the refusal says busy", /is busy \(/.test(handler));
// Ordering IS the test. A guard that runs after the write refuses nothing.
check("the check precedes the submit write", busyAt !== -1 && runAt !== -1 && busyAt < runAt, {
  busyAt,
  runAt,
});
check(
  "the check precedes the type-only write",
  busyAt !== -1 && injectAt !== -1 && busyAt < injectAt,
  { busyAt, injectAt },
);

console.log("\n[sh alt-screen] a full-screen program is the half a write may land in");
// "Busy" covers two opposite situations. A command on the NORMAL screen is not
// reading stdin, so a write corrupts whatever the user was typing. A TUI IS
// reading it, and a write is the only way to reach one - refusing both left no
// tool in this server able to type into an AI CLI, and the agent's workaround
// was a third terminal, `Set-Clipboard` and `terminal.paste`.
const altAt = handler.indexOf('bridge<boolean>("termAltScreen"');
const refusalAt = handler.indexOf("is busy (");
check("it asks whether a full-screen program owns the pane", altAt !== -1);
// Ordering IS the test again: asked AFTER the refusal, the answer changes nothing.
check("it asks before refusing", altAt !== -1 && refusalAt !== -1 && altAt < refusalAt, {
  altAt,
  refusalAt,
});
check(
  "the refusal is conditional on it NOT being a TUI",
  /if \(!intoTui\) \{\s*\n\s*return fail\(/.test(handler),
);
// A TUI never returns to a shell prompt, so the prompt-wait loop can only run
// out the clock - 20s of dead time on every keystroke sent to an AI CLI.
check("the TUI path skips the prompt wait", /if \(intoTui\) \{\s*\n\s*await sleep\(/.test(handler));
check("the reply says where the bytes went", handler.includes("intoTui: true"));

console.log("\n[sh launch] a command that opens a TUI ends the wait, it does not time out");
// `sh "claude"` starts a full-screen program: it worked, and no prompt is ever
// coming back. Polling on regardless spent the entire timeout and then reported
// `timedOut` on a successful launch, which is what made the caller take an extra
// `read` round trip to find out the CLI was in fact up.
check("the poll breaks when the pane goes full-screen", /if \(now\.alt\) \{/.test(handler));
check("and says so in the reply", handler.includes("startedTui: true"));

console.log("\n[sh timeout] the prompt wait has a floor");
// `timeout` is milliseconds, and `10` meaning ten seconds is the obvious
// misread. The poll sleeps 150ms, so a 10ms deadline expires before the first
// look and every launch came back `timedOut: true` having actually worked -
// costing the caller a whole extra `read` round trip to discover that.
check("the deadline is floored", /Math\.max\(1000, Number\(timeout\)/.test(handler));

console.log("\n[sh capture] the off-screen run is NOT gated by the busy check");
// Ordering again, in the opposite direction this time. `capture` opens its own
// SSH channel and never touches the pane, so a long foreground command is no
// reason to refuse - that is exactly when reading a file matters most. Put it
// after the busy check and "read this file while the build runs" starts failing
// for a reason that does not apply to it.
const captureAt = handler.indexOf("capture === true");
check("the capture branch exists", captureAt !== -1);
check("it runs before the busy check", captureAt !== -1 && busyAt !== -1 && captureAt < busyAt, {
  captureAt,
  busyAt,
});
// Same guard as every other path: the denylist and the extension transformer
// chain must vet the string before it reaches a shell, remote or not.
check(
  "the captured command is the vetted one",
  /sshExec"[^)]*vetted\.command/.test(handler.slice(captureAt, busyAt === -1 ? undefined : busyAt)),
);

console.log("\n[sh submit:false] a type-only write cannot smuggle a newline");
// `termInject` is a raw PTY write with no bracketed-paste wrapper, so an
// embedded newline auto-runs every following line with no approval at all.
const typeOnly = handler.slice(handler.indexOf("submit === false"), injectAt);
check("the type-only branch exists", handler.includes("submit === false"));
check(
  "it rejects a newline before writing",
  /\/\[\\r\\n\]\/\.test\(/.test(typeOnly),
  typeOnly.slice(0, 200),
);
// Checked against the VETTED string, not the model's: an extension holding
// `shell:transform` rewrites the command, and a transformer-introduced newline
// would otherwise reach the PTY unchecked.
check("the newline check reads the vetted command", /test\(vetted\.command\)/.test(typeOnly));

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
