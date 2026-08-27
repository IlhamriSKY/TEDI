/**
 * Self-check for the model-facing tool-output shaping.
 * Run: `npx tsx scripts/ai/tool-output-verify.ts`.
 *
 * These helpers decide what an edit/grep/glob result costs on every subsequent
 * request, so the invariant that matters is not "it looks nicer" but "nothing
 * the model needs went missing while the ballast went away":
 *
 *  1. An edit result keeps the line numbers and counts, and drops ONLY the
 *     before/after text that exists to draw the chat card.
 *  2. An error result passes through untouched - `toModelOutput` runs on the
 *     success channel, and TEDI returns `{error}` as a normal value there.
 *  3. grep states each file path ONCE instead of once per hit, and never emits
 *     a bare relative path (read_file resolves those against the terminal cwd,
 *     which is not always the search root).
 *  4. files/count modes still say how many matches there were and still warn
 *     when the result was truncated - a silently short file list reads as a
 *     complete answer.
 *  5. A pathological line (minified bundle) is capped.
 */
import { convertToModelMessages } from "ai";
import { buildEditTools, leanEditOutput } from "../../src/modules/ai/tools/edit";
import { buildSearchTools, formatGrep, truncateText } from "../../src/modules/ai/tools/search";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

const ROOT = "D:\\repo";
const A = "D:\\repo\\src\\a.ts";
const B = "D:\\repo\\src\\b.ts";
const hit = (path: string, rel: string, line: number, text: string) => ({ path, rel, line, text });

console.log("[edit] the diff text is UI ballast; the line numbers are not");
const editOut = {
  ok: true,
  path: A,
  replacements: 1,
  bytesWritten: 42,
  linesAdded: 3,
  linesRemoved: 2,
  hunks: [
    {
      line: 10,
      removed: 2,
      added: 3,
      removedText: "x".repeat(12_000),
      addedText: "y".repeat(12_000),
      previewClipped: true,
    },
  ],
};
const lean = leanEditOutput(editOut);
const leanParsed = JSON.parse(lean) as { hunks: Record<string, unknown>[]; linesAdded: number };
assert(!lean.includes("xxxx") && !lean.includes("yyyy"), "before/after text is gone");
assert(leanParsed.hunks[0].line === 10, "hunk line number survives");
assert(leanParsed.hunks[0].removed === 2 && leanParsed.hunks[0].added === 3, "hunk counts survive");
assert(leanParsed.linesAdded === 3, "top-level line totals survive");
assert(!("removedText" in leanParsed.hunks[0]), "removedText key not merely emptied");
assert(lean.length < 200, `24KB of hunk text collapsed to ${lean.length} chars`);

console.log("\n[edit] failures must not be reshaped into a fake success");
const err = leanEditOutput({ error: "old_string not found", path: A });
assert(JSON.parse(err).error === "old_string not found", "error passes through verbatim");
assert(
  typeof leanEditOutput(undefined) === "string",
  "a missing output still yields a string part",
);

console.log("\n[grep] one path per FILE, not one per hit");
const res = {
  root: ROOT,
  hits: [
    hit(A, "src/a.ts", 1, "import x"),
    // Indented, and with the trailing \r a CRLF file leaves behind (grep.rs
    // strips only '\n').
    hit(A, "src/a.ts", 9, "  useEffect(() => {\r"),
    hit(B, "src/b.ts", 4, "useEffect"),
  ],
  truncated: false,
  files_scanned: 120,
};
const content = formatGrep(res, "content");
assert(content.split(A).length - 1 === 1, "path A appears exactly once for its 2 hits");
assert(
  content.includes("1: import x") && content.includes("9:   useEffect(() => {"),
  "line numbers and text kept",
);
assert(!/^src\/a\.ts$/m.test(content), "no bare relative path is emitted");
assert(content.includes("2 file(s), 3 match(es)"), "header states files and matches");
assert(content.length < JSON.stringify(res).length, "smaller than the raw JSON it replaces");
assert(content.includes("9:   useEffect"), "leading indentation survives (nesting is signal)");
assert(!content.includes("\r"), "a CRLF file's stray \\r is stripped");

console.log("\n[grep] files / count modes");
const files = formatGrep(res, "files");
assert(files.includes(A) && files.includes(B), "both files listed");
assert(!files.includes("useEffect"), "match text dropped in files mode");
assert(files.includes("3 match(es)"), "files mode still reports the match count");
const count = formatGrep(res, "count");
assert(count.includes(`2\t${A}`), "count mode reports 2 hits for A");
assert(count.includes(`1\t${B}`), "count mode reports 1 hit for B");

console.log("\n[grep] truncation must stay visible, and empty is not an error");
const cut = formatGrep({ ...res, truncated: true }, "files");
assert(cut.includes("truncated"), "a truncated file list says so");
assert(
  formatGrep({ root: ROOT, hits: [] }, "content").startsWith("no matches"),
  "empty result is stated plainly",
);
assert(
  formatGrep({ root: ROOT, hits: res.hits, redacted_secret_files: 2 }, "content").includes(
    "secret",
  ),
  "redacted secret hits are still reported",
);

console.log("\n[grep] a minified-bundle line cannot blow up the request");
const huge = "a".repeat(500_000);
assert(
  truncateText(huge).length < 500,
  `${huge.length} chars capped to ${truncateText(huge).length}`,
);
assert(truncateText(huge).endsWith("[line truncated]"), "the cut is announced, not silent");
assert(truncateText("short line") === "short line", "a normal line is untouched");

// The whole point of the exercise: a `toModelOutput` only reaches REPLAYED
// history if `agent.ts` passes `tools` to convertToModelMessages. Drop that one
// argument and every saving above silently reverts on turn 2, with no type
// error and no failing unit assertion - so pin it here, through the real SDK.
console.log("\n[wiring] convertToModelMessages must be given `tools`, or none of this applies");
const tools = { ...buildEditTools({} as never), ...buildSearchTools({} as never) };
const replay = [
  {
    id: "1",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-edit" as const,
        toolCallId: "c1",
        state: "output-available" as const,
        input: { path: A },
        output: editOut,
      },
      {
        type: "tool-grep" as const,
        toolCallId: "c2",
        state: "output-available" as const,
        input: { pattern: "x" },
        output: res,
      },
      {
        type: "tool-grep" as const,
        toolCallId: "c3",
        state: "output-available" as const,
        input: { pattern: "x", output_mode: "files" },
        output: res,
      },
    ],
  },
];
async function replayed(opts?: { tools: typeof tools }): Promise<Record<string, string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await convertToModelMessages(replay as any, opts as any);
  const found: Record<string, string> = {};
  for (const m of out) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; toolCallId: string; output: unknown }[]) {
      if (p.type === "tool-result") found[p.toolCallId] = JSON.stringify(p.output);
    }
  }
  return found;
}
const without = await replayed();
const withTools = await replayed({ tools });
assert(
  without.c1.length > 15_000,
  `without tools the edit replays FAT (${without.c1.length} chars)`,
);
assert(withTools.c1.length < 400, `with tools it replays lean (${withTools.c1.length} chars)`);
assert(!withTools.c1.includes("xxxx"), "the replayed edit carries no diff text");
assert(without.c2.includes('"rel"'), "without tools grep replays the raw duplicated shape");
assert(!withTools.c2.includes('"rel"'), "with tools grep replays grouped, no duplicate paths");
assert(
  withTools.c3.length < withTools.c2.length,
  "output_mode is read back off the replayed tool INPUT (files < content)",
);

console.log(failed === 0 ? "\nAll tool-output checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
