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
