/**
 * Self-check for the edit line stats behind the chat card's `+N -M` badge.
 * Run: `npx tsx scripts/ai/line-stats-verify.ts`.
 *
 * These numbers are what the user reads instead of opening the diff, so a
 * silent off-by-one is worse than no badge at all. Two traps this pins down:
 * a CRLF file must not double-count (`\r\n` is ONE line break), and an empty
 * `new_string` must report 1 line, not 0 - deleting a substring shortens a
 * line, it does not remove the line.
 */
import {
  lineAt,
  lineSpan,
  MAX_REPORTED_HUNKS,
  parseHunks,
  totalLines,
  type EditHunk,
} from "../../src/modules/ai/lib/lineStats";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const LF = "alpha\nbravo\ncharlie\ndelta";
const CRLF = "alpha\r\nbravo\r\ncharlie\r\ndelta";

console.log("[lineAt] 1-based, and the offset AT a newline still belongs to the line it ends");
check("offset 0 is line 1", lineAt(LF, 0), 1);
check("last char of line 1", lineAt(LF, 4), 1);
check("first char of line 2", lineAt(LF, LF.indexOf("bravo")), 2);
check("first char of line 4", lineAt(LF, LF.indexOf("delta")), 4);
check("CRLF counts one break per line", lineAt(CRLF, CRLF.indexOf("charlie")), 3);

console.log("\n[lineAt guards] a bad offset clamps instead of throwing or running off the end");
check("negative offset", lineAt(LF, -10), 1);
check("offset past the end", lineAt(LF, 9999), 4);
check("empty text", lineAt("", 5), 1);

console.log("\n[lineSpan] how many lines a replacement occupies");
check("empty string still occupies its line", lineSpan(""), 1);
check("single line", lineSpan("hello"), 1);
check("two lines", lineSpan("a\nb"), 2);
check("CRLF two lines, not four", lineSpan("a\r\nb"), 2);
check("a trailing newline opens a new line", lineSpan("a\n"), 2);

console.log("\n[realistic edits] the numbers a user would check against git diff --stat");
// Replacing one word on one line reads as -1 +1, exactly like a line diff.
check(
  "one word on one line",
  { removed: lineSpan("bravo"), added: lineSpan("BRAVO") },
  {
    removed: 1,
    added: 1,
  },
);
// Collapsing two lines into one.
check(
  "two lines become one",
  { removed: lineSpan("a\nb"), added: lineSpan("ab") },
  {
    removed: 2,
    added: 1,
  },
);
// Expanding one line into four.
check(
  "one line becomes four",
  { removed: lineSpan("x"), added: lineSpan("w\nx\ny\nz") },
  {
    removed: 1,
    added: 4,
  },
);

console.log("\n[totalLines] the summary badge sums every hunk, keyed for the wire shape");
const hunks: EditHunk[] = [
  { line: 12, removed: 1, added: 3 },
  { line: 40, removed: 2, added: 2 },
  { line: 91, removed: 5, added: 0 },
];
check("sums all three hunks", totalLines(hunks), { linesAdded: 5, linesRemoved: 8 });
check("no hunks totals zero so the badge hides", totalLines([]), {
  linesAdded: 0,
  linesRemoved: 0,
});

console.log("\n[parseHunks] the result comes back through model context and saved history");
check("a well-formed array survives", parseHunks([{ line: 7, added: 2, removed: 1 }]), [
  { line: 7, added: 2, removed: 1 },
]);
check("a session recorded before hunks existed yields none", parseHunks(undefined), []);
check("a non-array never throws", parseHunks("+3 -1"), []);
check("entries without a line number are dropped", parseHunks([{ added: 2 }, { line: 9 }]), [
  { line: 9, added: 0, removed: 0 },
]);
check(
  "junk entries are skipped, not fatal",
  parseHunks([null, 5, { line: "12" }, { line: 3, added: 1, removed: 1 }]),
  [{ line: 3, added: 1, removed: 1 }],
);
check("nonsense numbers are clamped rather than rendered", parseHunks([{ line: 4.7, added: -3 }]), [
  { line: 4, added: 0, removed: 0 },
]);
check("a line number below 1 is dropped", parseHunks([{ line: 0 }, { line: -2 }]), []);
check(
  "the cap holds even if a result claims more",
  parseHunks(Array.from({ length: 50 }, (_, i) => ({ line: i + 1 }))).length,
  MAX_REPORTED_HUNKS,
);

console.log(failed === 0 ? "\nAll line-stats checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
