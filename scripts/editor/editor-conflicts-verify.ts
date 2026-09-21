/**
 * Self-check for the editor's merge-conflict resolver and inline blame text.
 * Run: `npx tsx scripts/editor/editor-conflicts-verify.ts`.
 *
 * A wrong resolution is silent data loss: the file saves with half a side
 * missing or a marker left in. So every choice is checked against the exact
 * text it must leave, including diff3's base section, a conflict at the very
 * end of the file, and an unfinished block that must be left alone.
 */
import { Text } from "@codemirror/state";
import {
  findConflicts,
  resolveChange,
  type Resolution,
} from "../../src/modules/editor/lib/conflicts";
import { formatBlame } from "../../src/modules/editor/lib/inlineBlame";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

function resolve(src: string, pick: Resolution, index = 0): string {
  const doc = Text.of(src.split("\n"));
  const block = findConflicts(doc)[index];
  if (!block) return "<no conflict found>";
  const c = resolveChange(doc, block, pick);
  return doc.replace(c.from, c.to, Text.of(c.insert.split("\n"))).toString();
}

const MERGE = [
  "before",
  "<<<<<<< HEAD",
  "ours 1",
  "ours 2",
  "=======",
  "theirs 1",
  ">>>>>>> feature",
  "after",
].join("\n");

console.log("[plain merge conflict]");
const blocks = findConflicts(Text.of(MERGE.split("\n")));
check("one block found", blocks.length, 1);
check("labels", [blocks[0]?.oursLabel, blocks[0]?.theirsLabel], ["HEAD", "feature"]);
check("accept current", resolve(MERGE, "ours"), "before\nours 1\nours 2\nafter");
check("accept incoming", resolve(MERGE, "theirs"), "before\ntheirs 1\nafter");
check("accept both", resolve(MERGE, "both"), "before\nours 1\nours 2\ntheirs 1\nafter");

console.log("\n[diff3 style, base section dropped]");
const DIFF3 = [
  "<<<<<<< ours",
  "a",
  "||||||| base",
  "orig",
  "=======",
  "b",
  ">>>>>>> theirs",
  "tail",
].join("\n");
check("accept current", resolve(DIFF3, "ours"), "a\ntail");
check("accept incoming", resolve(DIFF3, "theirs"), "b\ntail");
check("accept both", resolve(DIFF3, "both"), "a\nb\ntail");

console.log("\n[edges]");
const AT_END = ["x", "<<<<<<< HEAD", "mine", "=======", "yours", ">>>>>>> other"].join("\n");
check("at end of file, no trailing blank line", resolve(AT_END, "theirs"), "x\nyours");
const EMPTY_SIDE = ["<<<<<<< HEAD", "=======", "added", ">>>>>>> b", "z"].join("\n");
check("an empty side resolves to nothing", resolve(EMPTY_SIDE, "ours"), "z");
check("the other side of it", resolve(EMPTY_SIDE, "theirs"), "added\nz");
const TWO = `${MERGE}\n${MERGE}`;
check("two blocks, second resolved", resolve(TWO, "ours", 1).split("\n").slice(-4), [
  "before",
  "ours 1",
  "ours 2",
  "after",
]);
const UNFINISHED = ["<<<<<<< HEAD", "a", "=======", "b"].join("\n");
check(
  "an unfinished block is not a conflict",
  findConflicts(Text.of(UNFINISHED.split("\n"))).length,
  0,
);
const MARKDOWN_RULE = ["title", "=======", "text"].join("\n");
check(
  "a setext heading is not a conflict",
  findConflicts(Text.of(MARKDOWN_RULE.split("\n"))).length,
  0,
);

console.log("\n[inline blame text]");
const sha = "b9408ce5956bdc8d2122b457c735b0b1e62e98ff";
const porcelain = [
  `${sha} 3 3 1`,
  "author ilham",
  "author-mail <x@y>",
  `author-time ${Math.floor(Date.now() / 1000) - 3 * 86_400}`,
  "summary fix(git): refresh on change",
  "filename a.ts",
  "\tcode",
].join("\n");
check(
  "author, age and summary",
  formatBlame(porcelain),
  "ilham, 3d ago · fix(git): refresh on change",
);
check(
  "uncommitted line",
  formatBlame(`${"0".repeat(40)} 1 1 1\nauthor Not Committed Yet`),
  "Not committed yet",
);
check("garbage", formatBlame("fatal: no such path"), null);
const long = formatBlame(porcelain.replace("fix(git): refresh on change", "x".repeat(400))) ?? "";
check("a very long subject is cut short", long.length < 110 && long.endsWith("…"), true);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall conflict and blame checks passed");
