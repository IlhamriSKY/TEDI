/**
 * What a terminal read costs, on the way out of the app.
 * Run: `npx tsx scripts/terminal/terminal-text-reduction-verify.ts`.
 *
 * `usePaneHandles.ts` is where every terminal read is REDUCED before it crosses
 * a transport - the file says so, and `termProbe` was already written that way.
 * `termTails` was not, and neither was fed through anything that trims a TUI's
 * decoration. Both cost real work and real tokens on the hottest path there is:
 * `sh` calls `termTails` at the end of every command, `read terminal` is one
 * call per look, and every answer is then replayed with the history on each
 * later request of the turn.
 *
 * STRUCTURAL, like `terminal-buffer-wrap-verify.ts` beside it and for the same
 * reason: the file is a React hook over xterm and cannot load outside a browser.
 * The regex is the exception - it is READ OUT of the source and executed here,
 * so these are real assertions about the shipped expression rather than a claim
 * that some regex is present.
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

const SRC = "src/app/hooks/usePaneHandles.ts";
const src = await readFile(SRC, "utf8");

console.log("[termTails] one caller wanting one pane does not pay for every pane");
const from = src.indexOf("      termTails:");
const body = from === -1 ? "" : src.slice(from, src.indexOf("      termProbe:", from));
check("termTails was found", body.length > 0);
// The three in-process callers (`read terminal`, the tail `sh` returns,
// `wait_for_terminal`) each pick ONE row out by a leafId they already resolved.
// Unscoped, a fourth open terminal made each of those calls four buffer walks.
check("it takes a leaf to scope to", /onlyLeafId/.test(body));
check(
  "and skips the buffer walk for every other pane",
  /wantsText\s*\?/.test(body) && /getBuffer/.test(body),
  body,
);
// Scoping must not drop the other ROWS: callers `.find()` in this list, and
// `atPrompt`/`running` are two cheap booleans that do not come from the buffer.
check("the other panes still return their flags", /atPrompt: h\.isAtPrompt\(\)/.test(body));

console.log("\n[squeezeRules] a rule is trimmed, a table is not");
const m = /return s\.replace\((\/.+\/[gu]*),/.exec(src);
check("the expression was found in the source", m !== null, src.slice(0, 0));
if (m) {
  const lit = m[1];
  const slash = lit.lastIndexOf("/");
  const re = new RegExp(lit.slice(1, slash), lit.slice(slash + 1));
  const squeeze = (s: string): string => s.replace(re, (_x, c: string) => c.repeat(3));

  // The thing this exists for: an AI CLI's composer border, ~160 box-drawing
  // characters wide, in the `tail` of every `state` call.
  const rule = "─".repeat(160);
  check("a 160-char box rule collapses", squeeze(rule) === "───", squeeze(rule));
  check("so does an ASCII one", squeeze("=".repeat(40)) === "===");
  check("and the text around it survives", squeeze(`a${rule}b`) === "a───b");

  // The reason spaces are excluded. Squeezing them would corrupt data rather
  // than trim decoration, and a column layout is the commonest thing in a
  // terminal.
  const table = "-rw-r--r--  1 me  staff      1234 Jan  1 10:00 app.ts";
  check("column alignment is untouched", squeeze(table) === table, squeeze(table));
  check("a run of spaces is not a rule", squeeze(`a${" ".repeat(40)}b`) === `a${" ".repeat(40)}b`);
  // Short runs are punctuation, not decoration, and must read back exactly.
  check("`...` is left alone", squeeze("wait...") === "wait...");
  check("`--flag` is left alone", squeeze("ls --all") === "ls --all");
  check("a 7-char run is under the floor", squeeze("=======") === "=======");
  // Two different characters in a row are not one repeated character.
  check("a mixed run is not collapsed", squeeze("-=-=-=-=-=-=-=-=") === "-=-=-=-=-=-=-=-=");
  // Word characters are content. A repeated letter is someone's output.
  check("repeated letters survive", squeeze("a".repeat(40)) === "a".repeat(40));
}

console.log("\n[callers] both terminal text sources go through it");
check("termTails squeezes", /squeezeRules\(tailLines\(/.test(src));
// `terminals` is what `state` reads for its per-pane `tail` and what the stdio
// driver reads for a full buffer, so leaving it out would fix one transport.
check("terminals squeezes", /text: squeezeRules\(h\.getBuffer\(maxLines\)/.test(src));
// `editors` returns FILE content, where a run of dashes is the file's own text.
const ed = src.slice(src.indexOf("      editors:"), src.indexOf("      editorSave:"));
check("editors does NOT squeeze", ed.length > 0 && !/squeezeRules/.test(ed));

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
