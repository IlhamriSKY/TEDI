/**
 * Worktree audit. Two things are worth asserting and neither needs a repository:
 * the `--porcelain` parser, which has to survive optional attribute lines and
 * paths containing spaces, and the argument vectors `makeWorktreeOps` emits,
 * which are what actually reaches `git`.
 *
 * The parser fixtures are real `git worktree list --porcelain` output, captured
 * from git 2.46 on Windows - including the two attribute lines that carry an
 * OPTIONAL reason (`locked`, `prunable`), which is the shape a naive
 * split-on-space parser gets wrong.
 * Run: `npx tsx scripts/scm/worktree-verify.ts`.
 */
import {
  makeWorktreeOps,
  parseWorktrees,
  suggestWorktreePath,
  mainWorktreePath,
  worktreeConflictMessage,
  worktreeHolding,
  worktreeSlug,
} from "../../src/modules/scm/worktrees";
import { worktreeLaunchLine } from "../../src/modules/scm/worktreeSetup";
import { readFileSync } from "node:fs";

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

/** Records every argument vector and answers with a canned string. */
function recorder(reply = "") {
  const calls: string[][] = [];
  const ops = makeWorktreeOps(async (args) => {
    calls.push(args);
    return reply;
  });
  return { calls, ops };
}

const REPO = "C:/Users/x/AppData/Local/Temp/wtprobe/main";

console.log("\nporcelain parsing");
{
  const raw = [
    `worktree ${REPO}`,
    "HEAD 66da9154fa0298c3a0a708575a082832f532f18e",
    "branch refs/heads/master",
    "",
    `worktree ${REPO}/.worktrees/det`,
    "HEAD 66da9154fa0298c3a0a708575a082832f532f18e",
    "detached",
    "locked busy",
    "",
    `worktree ${REPO}/.worktrees/has space`,
    "HEAD 66da9154fa0298c3a0a708575a082832f532f18e",
    "branch refs/heads/feat-y",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");
  const list = parseWorktrees(raw);

  check("three records", list.length, 3);
  check(
    "the first is the main worktree, on a short branch name",
    { path: list[0].path, branch: list[0].branch, main: list[0].main },
    { path: REPO, branch: "master", main: true },
  );
  // `detached` and `bare` are bare words; `locked` carries an OPTIONAL reason.
  check(
    "a detached, locked worktree keeps its reason and has no branch",
    {
      detached: list[1].detached,
      branch: list[1].branch,
      locked: list[1].locked,
      lockReason: list[1].lockReason,
      main: list[1].main,
    },
    { detached: true, branch: null, locked: true, lockReason: "busy", main: false },
  );
  // The bug a whitespace-splitting parser has: the path ends at the first space.
  check("a path containing a space survives whole", list[2].path, `${REPO}/.worktrees/has space`);
  check("a registration whose folder is gone is prunable", list[2].prunable, true);
}

{
  // `locked` with no reason is a lock, not an attribute to ignore.
  const list = parseWorktrees(
    [`worktree ${REPO}/wt`, "HEAD abc", "branch refs/heads/x", "locked", ""].join("\n"),
  );
  check(
    "a reasonless lock still reads as locked",
    [list[0].locked, list[0].lockReason],
    [true, null],
  );
}

{
  // A bare repository prints `bare` and no HEAD at all.
  const list = parseWorktrees([`worktree ${REPO}`, "bare", ""].join("\n"));
  check(
    "a bare repository parses with no HEAD and no branch",
    { bare: list[0].bare, head: list[0].head, branch: list[0].branch },
    { bare: true, head: "", branch: null },
  );
}

{
  check("empty output is an empty list, not one blank entry", parseWorktrees(""), []);
  // CRLF is what a Windows shell hands back through some paths; a parser that
  // keeps the \r puts it inside the branch name and nothing ever matches.
  const list = parseWorktrees(`worktree ${REPO}\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n`);
  check("CRLF output does not leak a \\r into the branch", list[0].branch, "main");
  // Defensive: a stream with no blank separators must not merge into one entry.
  const merged = parseWorktrees(`worktree ${REPO}/a\nworktree ${REPO}/b\n`);
  check("a missing blank line still closes the record", merged.length, 2);
}

console.log("\nbranch lookup");
{
  const list = parseWorktrees(
    [
      `worktree ${REPO}`,
      "HEAD a",
      "branch refs/heads/main",
      "",
      `worktree ${REPO}/.worktrees/fix`,
      "HEAD b",
      "branch refs/heads/fix",
      "",
    ].join("\n"),
  );
  check(
    "a branch held elsewhere is found",
    worktreeHolding(list, "fix")?.path,
    `${REPO}/.worktrees/fix`,
  );
  // The panel's OWN branch is not a conflict - excluding it is what stops the
  // branch menu marking the branch you are standing on as "in a worktree".
  check(
    "the current worktree's own branch is not a conflict",
    worktreeHolding(list, "main", REPO),
    null,
  );
  check("a branch no worktree holds is null", worktreeHolding(list, "other"), null);
  // Windows hands paths back with backslashes from some callers.
  check(
    "self is compared in forward-slash form",
    worktreeHolding(list, "main", REPO.replace(/\//g, "\\")),
    null,
  );
}

console.log("\npaths");
{
  check("a slash in a branch becomes one folder, not two", worktreeSlug("feat/x"), "feat-x");
  check("nested slashes collapse", worktreeSlug("a/b/c"), "a-b-c");
  check("surrounding slashes are dropped", worktreeSlug("/lead/"), "lead");
  check("whitespace is trimmed", worktreeSlug("  fix-login  "), "fix-login");
  check(
    "the suggested path lands under .worktrees",
    suggestWorktreePath(REPO, "feat/x"),
    `${REPO}/.worktrees/feat-x`,
  );
  check(
    "a backslash root is normalised first",
    suggestWorktreePath("C:\\repo", "fix"),
    "C:/repo/.worktrees/fix",
  );
}

console.log("\nargument vectors");
{
  const { calls, ops } = recorder();
  await ops.add({ path: "/r/.worktrees/f", branch: "f", create: true });
  check("a new branch uses -b", calls.pop(), ["worktree", "add", "/r/.worktrees/f", "-b", "f"]);

  await ops.add({ path: "/r/.worktrees/f", branch: "f", create: true, startPoint: "origin/main" });
  check("a start point follows the branch", calls.pop(), [
    "worktree",
    "add",
    "/r/.worktrees/f",
    "-b",
    "f",
    "origin/main",
  ]);

  await ops.add({ path: "/r/.worktrees/f", branch: "f", create: false });
  check("an existing branch is positional", calls.pop(), [
    "worktree",
    "add",
    "/r/.worktrees/f",
    "f",
  ]);

  // The PR path: no branch is named, because gh puts the right one in after.
  await ops.add({ path: "/r/.worktrees/pr", detach: true });
  check("detach names no branch", calls.pop(), ["worktree", "add", "--detach", "/r/.worktrees/pr"]);

  await ops.remove("/r/.worktrees/f");
  check("remove is unforced by default", calls.pop(), ["worktree", "remove", "/r/.worktrees/f"]);
  await ops.remove("/r/.worktrees/f", true);
  check("force is a flag before the path", calls.pop(), [
    "worktree",
    "remove",
    "--force",
    "/r/.worktrees/f",
  ]);

  await ops.prune();
  check("prune takes nothing", calls.pop(), ["worktree", "prune"]);

  await ops.list();
  check("list asks for porcelain", calls.pop(), ["worktree", "list", "--porcelain"]);
}

{
  // A branch is required unless detached, or git would be handed `undefined`.
  const { ops } = recorder();
  let threw = false;
  await ops.add({ path: "/r/x" }).catch(() => (threw = true));
  check("a worktree with neither a branch nor --detach is refused", threw, true);
}

console.log("\nthe second-checkout refusal");
{
  // Both wordings, because git uses a different one per command.
  const checkout = `fatal: 'feat-x' is already used by worktree at '${REPO}/.worktrees/feat-x'`;
  const del = `error: cannot delete branch 'feat-x' used by worktree at '${REPO}/.worktrees/feat-x'`;
  check(
    "checkout's refusal is recognised",
    worktreeConflictMessage(checkout)?.includes(REPO),
    true,
  );
  check("delete's refusal is recognised", worktreeConflictMessage(del)?.includes(REPO), true);
  // Saying so matters: the delete dialog offers a force that cannot work.
  check(
    "it says forcing will not help",
    worktreeConflictMessage(del)?.includes("forcing will not help"),
    true,
  );
  check(
    "an unrelated error is left alone",
    worktreeConflictMessage("fatal: not a git repository"),
    null,
  );
}

console.log("\nthe launch line");
{
  check("setup and agent are chained", worktreeLaunchLine("pnpm i", "claude"), "pnpm i && claude");
  check("setup alone runs alone", worktreeLaunchLine("pnpm i", ""), "pnpm i");
  check("an agent alone runs alone", worktreeLaunchLine("", "claude"), "claude");
  // Null, not "", so the caller leaves the shell at its prompt instead of
  // typing a bare newline into it.
  check("nothing to run is null", worktreeLaunchLine("  ", " "), null);
}

// The rules above are PURE functions, but getting them right is a WIRING
// question: several call sites have both roots in scope and passing the wrong
// one is silent. Every one of these was a real bug during the build - a worktree
// created from inside another nested under it, and the setup command saved
// itself per worktree instead of per repository - so the call sites are pinned
// as source text, the way the other panel verifies pin theirs.
console.log("\nevery WRITE is rooted at the MAIN worktree");
{
  const create = readFileSync("src/modules/scm/worktreeCreate.ts", "utf8");
  // The one that matters most, and the reason the create moved out of the panel
  // at all: it resolves main from whatever root it was handed instead of
  // trusting the caller. TWO panels offer this action now, so a rule that lived
  // in one of them was a rule the second could forget.
  check(
    "the shared create resolves main itself",
    create.includes("mainWorktreePath(await localWorktreeOps(repoRoot).list(), repoRoot)"),
    true,
  );
  check(
    "the .gitignore is written to main",
    create.includes("ignoreWorktreesFolder(mainRoot, path)"),
    true,
  );
  // Turning "Run setup first" off must not FORGET the repository's command:
  // `setSetupCommand` treats an empty string as "delete this entry", so the text
  // to remember and the decision to run it have to stay two separate facts.
  check(
    "the typed setup command is saved per REPOSITORY even when it is not run",
    create.includes("setSetupCommand(mainRoot, setup)"),
    true,
  );
  check(
    "and only RUNS when the toggle is on",
    create.includes('worktreeLaunchLine(runSetup ? setup : ""'),
    true,
  );

  const panel = readFileSync("src/modules/scm/SourceControlPanel.tsx", "utf8");
  check(
    "the create dialog is rooted at main, or a new worktree nests inside the current one",
    /<WorktreeDialog[\s\S]*?repoRoot=\{mainRoot\}/.test(panel),
    true,
  );
  check(
    "the panel's own writes are built on mainRoot",
    panel.includes("mainRoot ? localWorktreeOps(mainRoot) : null"),
    true,
  );

  // The Workspaces panel offers the same create from a project row, and the root
  // it starts from is a TERMINAL's cwd - routinely a linked worktree once anyone
  // has opened one. It has to resolve main BEFORE the dialog, which derives the
  // suggested folder from what it is given.
  const ws = readFileSync("src/modules/workspaces/WorkspacesPanel.tsx", "utf8");
  check(
    "the workspace project row resolves main before opening the dialog",
    ws.includes("mainWorktreePath(fresh, cwd)"),
    true,
  );
  // The right-click belongs to a ROW, not to the workspace: one workspace
  // routinely holds panes in two different projects, so its own row cannot say
  // which repository "New Worktree" would mean.
  check(
    "worktrees are keyed to a row's own folder, never to the workspace",
    ws.includes("function localTerminalCwd") && !ws.includes("function workspaceRepoPath"),
    true,
  );
  check(
    "and hands the dialog that root, not the terminal's cwd",
    /<WorktreeDialog[\s\S]*?repoRoot=\{newWorktreeFor\.repoRoot\}/.test(ws),
    true,
  );
  // A worktree row addresses a live tab by cwd, so the comparison has to be in
  // the same slash form the porcelain list is parsed into.
  check(
    "a worktree row matches an open tab in forward-slash form",
    ws.includes("toForwardSlash(r.entry.cwd) === wt.path"),
    true,
  );

  // A prunable entry is a registration git kept after the folder was deleted.
  // BOTH panels list one, so the refusal to open it lives in the bridge they
  // both call rather than in whichever of them remembered.
  const bridge = readFileSync("src/modules/scm/worktreeBridge.ts", "utf8");
  check("opening a worktree refuses a missing folder", bridge.includes("worktree.prunable"), true);
  check(
    "and the workspace row opens through that guard, not the raw bridge",
    ws.includes("openWorktree(wt, list)") && !ws.includes("openWorktreeTab("),
    true,
  );
  // A worktree already open IS one of the tab rows above it. Listing it again
  // put the same checkout on screen twice under two different icons, which is
  // what made the panel read as confusing.
  check(
    "a worktree already open as a tab is not listed a second time",
    ws.includes("!open.has(x.path)"),
    true,
  );
  // A worktree folder is named after the BRANCH, so a tab left to label itself
  // drops the only word saying which project it belongs to.
  const bridge2 = readFileSync("src/modules/scm/worktreeBridge.ts", "utf8");
  const ws2 = readFileSync("src/modules/scm/worktreeAutomation.ts", "utf8");
  check(
    "a worktree tab is named after the PROJECT, not the branch folder",
    create.includes("title: basename(mainRoot)") && bridge2.includes("basename(main)"),
    true,
  );

  // The PR flow is the third writer, and the one the source-text checks used to
  // miss: it resolved main for the RUNNER but derived the new worktree's PATH
  // from the focused checkout, so a PR reviewed from inside a worktree nested
  // under it and was later deleted with the outer one, rc=0 and silent.
  const pr = readFileSync("src/modules/scm/prWorktree.ts", "utf8");
  check(
    "the PR checkout derives its path from main, not from the focused checkout",
    pr.includes("suggestWorktreePath(mainRoot, headRefName)") &&
      pr.includes("ignoreWorktreesFolder(mainRoot, path)"),
    true,
  );

  // Removing a worktree a terminal is sitting in deregisters it and then FAILS
  // to delete the folder on Windows, leaving a directory git no longer knows
  // about. `--force` cannot help - the lock is the open handle. So every removal
  // in the app goes through one guard that checks first.
  // The rollback inside `checkoutPrInWorktree` is deliberately NOT here: it
  // removes a worktree it created seconds earlier, before any tab exists, so
  // there is nothing for the guard to find and a failure there must stay silent.
  check(
    "every USER-facing removal goes through the busy-terminal guard",
    bridge2.includes("export async function removeWorktreeAt") &&
      pr.includes("removeWorktreeAt(repoRoot, path, true)") &&
      ws2.includes("removeWorktreeAt(main, hit.path"),
    true,
  );

  const menu = readFileSync("src/modules/scm/components/WorktreeMenu.tsx", "utf8");
  // Removing a worktree an agent has been working in is the one destructive
  // action here, so the confirmation names the work rather than the folder.
  check(
    "the remove confirmation names the uncommitted work it would destroy",
    menu.includes("pendingChanges > 0"),
    true,
  );
  check(
    "the menu shortens paths against main",
    menu.includes("(list ?? []).find((w) => w.main)?.path ?? root"),
    true,
  );
  // git refuses `worktree remove --force` on a locked worktree, so a Remove
  // button there failed, turned into "Delete anyway", and failed identically.
  check(
    "a locked worktree gets no Remove button, like the main one",
    menu.includes("!w.main && !w.locked ?"),
    true,
  );
}

if (failures > 0) throw new Error(`${failures} worktree failure(s)`);
console.log("\nworktree-verify: OK");
