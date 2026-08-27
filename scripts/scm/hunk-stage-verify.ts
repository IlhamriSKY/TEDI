/**
 * Partial-staging audit, against REAL git in a throwaway repository.
 *
 * Every other verify script in here drives a recording runner, because the
 * question is "what argument vector did we build". This one cannot: the whole
 * risk of hunk staging is whether `git apply` ACCEPTS the patch we synthesise
 * and writes the index we meant. A unit test comparing patch text to expected
 * patch text would pass on a patch git rejects, and pass on a patch git applies
 * to the wrong place. So this builds a repo in a temp directory, stages hunks
 * through it, and asks git what the index says afterwards.
 *
 * The four things it exists to catch:
 *
 *  1. Staging hunk 2 must stage hunk 2 and leave hunk 1 unstaged. Addressing a
 *     hunk by content instead of by index is how a file with repeated lines
 *     gets the wrong one staged (the bug Zed shipped and fixed).
 *  2. Selecting SOME lines of a hunk needs the `@@` counts recomputed. Emitting
 *     the original counts makes git reject the patch as corrupt, and getting
 *     the arithmetic subtly wrong makes it apply the wrong lines.
 *  3. Unstaging is the same patch REVERSED against the staged diff, and
 *     discarding is the same patch reversed against the working tree.
 *  4. A patch built from a stale diff must FAIL, loudly. That is the reason
 *     `--unidiff-zero` is not passed on the Rust side: it turns off the context
 *     check, which is the only thing that notices.
 *
 * Run: `npx tsx scripts/scm/hunk-stage-verify.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHunkPatch, parseFileDiff, type FileDiff } from "../../src/modules/scm/patch";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}\n          expected ${e}\n          got      ${a}`);
  }
}

function ok(label: string, condition: boolean, detail?: unknown) {
  check(label, condition ? true : (detail ?? false), true);
}

const repo = mkdtempSync(join(tmpdir(), "tedi-hunk-"));
const FILE = "sample.txt";

/** git in the throwaway repo, with the caller's own config kept out of it: a
 *  global `core.autocrlf`, a signing key or a commit template would each change
 *  the answer and none of them are what is under test. */
function git(args: string[], input?: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=tedi",
      "-c",
      "user.email=tedi@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      ...args,
    ],
    { cwd: repo, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** True when git REFUSED. Used where the refusal is the assertion. */
function gitFails(args: string[], input?: string): boolean {
  try {
    git(args, input);
    return false;
  } catch {
    return true;
  }
}

const write = (lines: string[], trailingNewline = true) =>
  writeFileSync(join(repo, FILE), lines.join("\n") + (trailingNewline ? "\n" : ""), "utf8");
const read = () => readFileSync(join(repo, FILE), "utf8");

const base = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`);

function reset(lines = base) {
  git(["reset", "-q"]);
  git(["checkout", "-q", "--", FILE]);
  write(lines);
}

function worktreeDiff(): FileDiff {
  const raw = git(["diff", "--no-ext-diff", "--no-textconv", "-U3", "--", FILE]);
  const parsed = parseFileDiff(raw);
  if (!parsed) throw new Error("expected a diff with hunks, got none");
  return parsed;
}

function stagedDiff(): FileDiff | null {
  return parseFileDiff(
    git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "-U3", "--", FILE]),
  );
}

try {
  git(["init", "-q", "-b", "main"]);
  write(base);
  git(["add", FILE]);
  git(["commit", "-qm", "base"]);

  console.log("two separate edits produce two hunks");
  {
    const edited = [...base];
    edited[2] = "line 03 CHANGED";
    edited[14] = "line 15 CHANGED";
    write(edited);
    const diff = worktreeDiff();
    check("git splits them", diff.hunks.length, 2);

    // Stage ONLY the second hunk.
    git(["apply", "--cached", "-"], buildHunkPatch(diff, 1, null));
    const staged = git(["diff", "--cached"]);
    const rest = git(["diff"]);
    ok("the chosen hunk is in the index", staged.includes("+line 15 CHANGED"));
    ok("the other hunk is NOT", !staged.includes("+line 03 CHANGED"));
    ok("and is still in the working tree", rest.includes("+line 03 CHANGED"));
    ok("which no longer shows the staged one", !rest.includes("+line 15 CHANGED"), rest);

    console.log("\nunstaging is the same patch, reversed against the staged diff");
    const sd = stagedDiff();
    ok("there is a staged diff to reverse", sd !== null);
    git(["apply", "--cached", "-R", "-"], buildHunkPatch(sd!, 0, null));
    check("the index is clean again", git(["diff", "--cached"]).trim(), "");
    ok("and the edit survived in the working tree", git(["diff"]).includes("+line 15 CHANGED"));
  }

  console.log("\nselecting SOME lines of one hunk");
  {
    reset();
    const edited = [...base];
    // Two additions in one hunk: adjacent, so -U3 cannot split them.
    edited.splice(10, 0, "inserted A", "inserted B");
    write(edited);
    const diff = worktreeDiff();
    check("one hunk", diff.hunks.length, 1);

    const addIndices = diff.hunks[0].lines
      .map((l, i) => (l.startsWith("+") ? i : -1))
      .filter((i) => i >= 0);
    check("with two additions", addIndices.length, 2);

    // Only the FIRST addition. The `@@` counts have to shrink by one on the new
    // side; leaving the original counts makes git call the patch corrupt.
    const patch = buildHunkPatch(diff, 0, new Set([addIndices[0]]));
    ok("the rewritten header is not the original", !patch.includes(diff.hunks[0].header), patch);
    git(["apply", "--cached", "-"], patch);

    const staged = git(["diff", "--cached"]);
    ok("the chosen line is staged", staged.includes("+inserted A"));
    ok("the other one is not", !staged.includes("+inserted B"), staged);
    ok("and is still unstaged", git(["diff"]).includes("+inserted B"));
    ok("the working tree was not touched", read().includes("inserted B"));
  }

  console.log("\nselecting SOME deletions of one hunk");
  {
    reset();
    const edited = base.filter((_, i) => i !== 5 && i !== 6); // drop lines 06 and 07
    write(edited);
    const diff = worktreeDiff();
    const delIndices = diff.hunks[0].lines
      .map((l, i) => (l.startsWith("-") ? i : -1))
      .filter((i) => i >= 0);
    check("two deletions in one hunk", delIndices.length, 2);

    // An UNCHOSEN deletion has to become CONTEXT, not disappear: the index
    // still contains that line, so a patch that omits it describes a file that
    // does not exist and git rejects it.
    git(["apply", "--cached", "-"], buildHunkPatch(diff, 0, new Set([delIndices[0]])));
    const staged = git(["diff", "--cached"]);
    ok("the chosen deletion is staged", staged.includes("-line 06"));
    ok("the other line survives in the index", !staged.includes("-line 07"), staged);
  }

  console.log("\ndiscarding a hunk writes the WORKING TREE, not the index");
  {
    reset();
    const edited = [...base];
    edited[2] = "line 03 CHANGED";
    edited[14] = "line 15 CHANGED";
    write(edited);
    const diff = worktreeDiff();
    git(["apply", "-R", "-"], buildHunkPatch(diff, 0, null));
    const after = read();
    ok("the discarded change is gone from the file", !after.includes("line 03 CHANGED"));
    ok("the other one is untouched", after.includes("line 15 CHANGED"));
    check("nothing was staged", git(["diff", "--cached"]).trim(), "");
  }

  console.log("\na patch built from a STALE diff must be refused");
  {
    // Which tree has to move depends on the flag, and getting this backwards is
    // itself worth writing down: `--cached` matches the INDEX, so editing the
    // file on disk does NOT invalidate a staging patch (it applied fine, which
    // is correct). What invalidates it is the index moving underneath it.
    reset();
    const edited = [...base];
    edited[2] = "line 03 CHANGED";
    write(edited);
    const stale = buildHunkPatch(worktreeDiff(), 0, null);

    const moved = [...base];
    moved[2] = "line 03 SOMETHING ELSE ENTIRELY";
    write(moved);
    git(["add", FILE]); // the index now says something else about line 03
    ok("staging: git rejects it rather than guessing", gitFails(["apply", "--cached", "-"], stale));

    // The discard path writes the WORKING TREE, so there it is the file moving
    // that must be caught.
    reset();
    write(edited);
    const staleWorktree = buildHunkPatch(worktreeDiff(), 0, null);
    write(moved);
    ok("discard: git rejects it too", gitFails(["apply", "-R", "-"], staleWorktree));
    ok("and the file was left alone", read().includes("line 03 SOMETHING ELSE ENTIRELY"));
  }

  console.log("\na file with no trailing newline stages whole");
  {
    reset();
    write(base, false);
    git(["add", FILE]);
    git(["commit", "-qm", "no trailing newline"]);
    const edited = [...base];
    edited[edited.length - 1] = "line 20 CHANGED";
    write(edited, false);
    const diff = worktreeDiff();
    ok("the marker is seen", diff.hunks[0].hasNoNewline, diff.hunks[0].lines);
    // Verbatim, so the marker keeps describing the line it was written for.
    git(["apply", "--cached", "-"], buildHunkPatch(diff, 0, null));
    ok("it applies", git(["diff", "--cached"]).includes("+line 20 CHANGED"));

    // Line selection would have to re-sign the line the marker belongs to, so
    // it is refused instead of silently corrupting the final newline.
    git(["reset", "-q"]);
    const changeIdx = diff.hunks[0].lines.findIndex((l) => l.startsWith("+"));
    let refused = false;
    try {
      buildHunkPatch(diff, 0, new Set([changeIdx]));
    } catch {
      refused = true;
    }
    ok("a partial selection is refused", refused);
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures > 0) throw new Error(`${failures} hunk-staging failure(s)`);
console.log("\nhunk-stage-verify: OK");
