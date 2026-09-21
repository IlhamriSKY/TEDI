/**
 * Self-check for slash commands defined as `.tedi/commands/*.md` files.
 * Run: `npx tsx scripts/ai/file-commands-verify.ts`.
 *
 * The shapes below are the ones a Claude Code command folder already uses
 * (frontmatter `description` / `argument-hint`, `$ARGUMENTS`, `$1`), since
 * `.claude/commands` is read as is. A name the chat marker cannot carry
 * (`[a-z0-9-]`) would render as raw text in the thread, so names are pinned too.
 */
import {
  commandNameFromFile,
  expandCommand,
  parseCommandFile,
} from "../../src/modules/ai/lib/fileCommands";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[names]");
check("plain", commandNameFromFile("review.md"), "review");
check("underscore and case", commandNameFromFile("Fix_Issue.md"), "fix-issue");
check("not markdown", commandNameFromFile("notes.txt"), null);
check("nothing left", commandNameFromFile("__.md"), null);

console.log("\n[file parsing]");
const withMeta = parseCommandFile(
  '---\ndescription: "Review the diff"\nargument-hint: [file]\nallowed-tools: Bash\n---\n\nReview $ARGUMENTS carefully.\n',
);
check("frontmatter description", withMeta.description, "Review the diff");
check("argument hint", withMeta.argHint, "[file]");
check("body without frontmatter", withMeta.body, "Review $ARGUMENTS carefully.");
const bare = parseCommandFile("# Write tests\r\nAdd unit tests for the changed code.\r\n");
check("no frontmatter: first line describes it", bare.description, "Write tests");
check("CRLF normalised", bare.body, "# Write tests\nAdd unit tests for the changed code.");

console.log("\n[expansion]");
check(
  "$ARGUMENTS",
  expandCommand("Fix issue $ARGUMENTS now", "#12 in api"),
  "Fix issue #12 in api now",
);
check("positional", expandCommand("Move $1 to $2", "a.ts b.ts"), "Move a.ts to b.ts");
check("missing positional is empty", expandCommand("Move $1 to $2", "a.ts"), "Move a.ts to ");
check(
  "no placeholder: args appended",
  expandCommand("Review the diff.", "focus on auth"),
  "Review the diff.\n\nfocus on auth",
);
check("no placeholder, no args", expandCommand("Review the diff.", ""), "Review the diff.");

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall file-command checks passed");
