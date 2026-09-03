/**
 * A terminal read must return LOGICAL lines, not screen rows.
 * Run: `npx tsx scripts/terminal/terminal-buffer-wrap-verify.ts`.
 *
 * `buffer.active` holds one entry per screen ROW, so a line wider than the pane
 * is stored as several. Joining them all with "\n" puts a break wherever the
 * pane happens to end, which is a SILENT WRONG ANSWER - the reader gets text
 * that looks fine and is not what the terminal shows:
 *
 *   ls -la /var/www      <- one command, split mid-path
 *   /html
 *
 * Every consumer of a terminal was affected: `read`, `sh`, `wait_for_terminal`
 * (a needle cut in half by a wrap never matched), and the `<env>` preview.
 * `isWrapped` marks a continuation row, and honouring it is the whole fix.
 *
 * Structural: `useTerminalSession.ts` needs a live xterm and a PTY, so the
 * behaviour is proven against a running app and the SHAPE is pinned here.
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

const SRC = "src/modules/terminal/lib/useTerminalSession.ts";
const src = await readFile(SRC, "utf8");

const from = src.indexOf("const getBuffer = useCallback");
const body = from === -1 ? "" : src.slice(from, src.indexOf("const getSelection", from));

console.log("[getBuffer] wrapped rows are rejoined, not newline-separated");
check("getBuffer was found", body.length > 0);
check("it reads isWrapped at all", /isWrapped/.test(body));
// The join itself. A `push` for every row is the bug; a continuation has to
// append to the line already collected.
check("a continuation row appends to the previous line", /\+=\s*text/.test(body));
check("a non-continuation row starts a new line", /lines\.push\(text\)/.test(body));
// Trimming a row that is CONTINUED eats the column that separates its last
// word from the first word of the next row, so the trim has to be conditional.
check(
  "a continued row is not right-trimmed",
  /translateToString\(!continues\)/.test(body),
  body.match(/translateToString\([^)]*\)/g),
);
// Starting the window mid-wrap leaves a continuation with nothing above it.
// Without this guard that row is appended to a line that does not exist.
check(
  "a continuation with no head still yields a line",
  /isWrapped\s*&&\s*lines\.length/.test(body),
);

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
