/**
 * Source Control write-path audit. Every panel action - stage, unstage,
 * discard, commit, push, branch switching - is composed in `makeOps` from
 * argument vectors handed to `git_run` (local) or `ssh_git` (remote), so this
 * drives the real implementation over a recording runner and asserts the exact
 * commands it emits. The destructive ones are the point: discard has to tell a
 * tracked file from a staged-new one, and restore both sides of a rename.
 * Run: `npx tsx scripts/scm/scm-ops-verify.ts`.
 */
import { invalidBranchName, isBranchSwitch, makeOps } from "../../src/modules/scm/api";
import { shouldFetch } from "../../src/modules/scm/branch";
import {
  authorHue,
  dayLabel,
  githubAvatar,
  initials,
  parseRefs,
} from "../../src/modules/scm/historyMeta";

type Reply = string | Error;

/** Records every argument vector and answers from a canned table. A key is
 *  matched as a prefix of the joined args, so `"show-ref"` covers the whole
 *  probe. `Error` values stand in for git's non-zero exits. */
function recorder(replies: Record<string, Reply> = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const [key, value] of Object.entries(replies)) {
      if (joined.startsWith(key)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return "";
  };
  return { calls, run, ops: makeOps(run) };
}

const NO_HEAD = new Error("fatal: Needed a single revision");
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

console.log("\nstaging");
{
  const { calls, ops } = recorder();
  await ops.stage(["src/a.ts", "b.txt"]);
  check("stage adds the paths", calls, [["add", "-A", "--", "src/a.ts", "b.txt"]]);
}
{
  // `-A` matters: without it a deleted file stays in the index and the commit
  // silently keeps the file the user removed.
  const { calls, ops } = recorder();
  await ops.stage([]);
  check("staging nothing runs no git at all", calls, []);
}
{
  const { calls, ops } = recorder();
  await ops.unstage(["src/a.ts"]);
  check("unstage resets against HEAD", calls, [
    ["rev-parse", "--verify", "-q", "HEAD"],
    ["reset", "-q", "HEAD", "--", "src/a.ts"],
  ]);
}
{
  // A fresh repo has no HEAD to reset against; everything in its index is an
  // add, so dropping the cache entry is the same operation.
  const { calls, ops } = recorder({ "rev-parse --verify": NO_HEAD });
  await ops.unstage(["src/a.ts"]);
  check("unstage on an unborn branch drops the cache entry instead", calls[1], [
    "rm",
    "--cached",
    "-r",
    "-q",
    "--",
    "src/a.ts",
  ]);
}

console.log("\ndiscard");
{
  // tracked.ts exists at HEAD; staged-new.ts does not. The old code asked
  // `ls-files --error-unmatch`, which answers about the INDEX, so a staged new
  // file took the `checkout HEAD --` path against a blob HEAD never had and
  // failed with a raw git error instead of being deleted.
  const { calls, ops } = recorder({ "ls-tree": "tracked.ts\0" });
  await ops.discard(["tracked.ts", "staged-new.ts"]);
  check("discard unstages everything first", calls[2], [
    "reset",
    "-q",
    "HEAD",
    "--",
    "tracked.ts",
    "staged-new.ts",
  ]);
  check("a file at HEAD is restored from HEAD", calls[3], [
    "checkout",
    "-q",
    "HEAD",
    "--",
    "tracked.ts",
  ]);
  check("a file HEAD never had is deleted", calls[4], ["clean", "-fdq", "--", "staged-new.ts"]);
}
{
  const { calls, ops } = recorder({ "rev-parse --verify": NO_HEAD });
  await ops.discard(["only.ts"]);
  check("with no HEAD, discard just cleans", calls, [
    ["rev-parse", "--verify", "-q", "HEAD"],
    ["clean", "-fdq", "--", "only.ts"],
  ]);
}
{
  const { calls, ops } = recorder();
  await ops.discard([]);
  check("discarding nothing runs no git at all", calls, []);
}

console.log("\npush");
{
  const { calls, ops } = recorder();
  await ops.push("main");
  check("with an upstream, push takes no refspec", calls[1], ["push"]);
}
{
  const { calls, ops } = recorder({ "rev-parse --abbrev-ref": new Error("no upstream") });
  await ops.push("feature/x");
  check("without one, the branch is published and tracked", calls[1], [
    "push",
    "-u",
    "origin",
    "feature/x",
  ]);
}
{
  const { ops } = recorder({ "rev-parse --abbrev-ref": new Error("no upstream") });
  const err = await ops.push(null).then(
    () => null,
    (e: unknown) => String(e),
  );
  check("a detached HEAD cannot be published", err !== null && err.includes("detached HEAD"), true);
}

console.log("\nbranches");
{
  const { calls, ops } = recorder({ "show-ref": new Error("not found") });
  await ops.checkout("origin/feat");
  // Checking out `origin/feat` directly would detach HEAD.
  check("a remote branch becomes a local tracking branch", calls[2], [
    "checkout",
    "-b",
    "feat",
    "--track",
    "origin/feat",
  ]);
}
{
  const { calls, ops } = recorder({
    "show-ref --verify --quiet refs/heads/origin/feat": new Error("not found"),
  });
  await ops.checkout("origin/feat");
  check("...unless that local branch already exists", calls[2], ["checkout", "feat"]);
}
{
  const { calls, ops } = recorder();
  await ops.checkout("main");
  check("an existing local branch is switched to directly", calls[1], ["checkout", "main"]);
}
{
  const { calls, ops } = recorder();
  await ops.checkout("feat/new", true);
  check("create branches from HEAD and switches", calls, [["checkout", "-b", "feat/new"]]);
}
{
  const raw = [
    "refs/heads/main\tmain\t*\torigin/main",
    "refs/heads/feat\tfeat\t \t",
    "refs/remotes/origin/main\torigin/main\t \t",
    // A symref to the remote's default branch, not a branch of its own.
    "refs/remotes/origin/HEAD\torigin/HEAD\t \t",
  ].join("\n");
  const { ops } = recorder({ "for-each-ref": raw });
  const list = await ops.branches();
  check("for-each-ref rows parse, origin/HEAD dropped", list, [
    { name: "main", current: true, remote: false, upstream: "origin/main" },
    { name: "feat", current: false, remote: false, upstream: null },
    { name: "origin/main", current: false, remote: true, upstream: null },
  ]);
}
{
  // A leading dash would be read as an option by `checkout -b` / `branch -d`.
  const bad = ["", "  ", "-x", "a b", "a..b", "a/", "//a", "x.lock", "a~1", "a@{0}"];
  check(
    "check-ref-format rules reject every malformed name",
    bad.filter((n) => invalidBranchName(n) === null),
    [],
  );
  check("a normal name passes", invalidBranchName("feature/add-scm"), null);
}
{
  const { ops } = recorder();
  const err = await ops.deleteBranch("--force").then(
    () => null,
    (e: unknown) => String(e),
  );
  check("a dash-leading branch name never reaches git", err !== null, true);
}

console.log("\ncommit");
{
  const { calls, ops } = recorder();
  await ops.commit("subject\n\nbody");
  check("commit passes the message through -m", calls, [["commit", "-m", "subject\n\nbody"]]);
}
{
  const { calls, ops } = recorder();
  await ops.commit("reworded", true);
  check("amend rewrites the last commit", calls, [["commit", "--amend", "-m", "reworded"]]);
}

console.log("\nbranch-switch toast");
{
  // The panel follows the focused terminal, so `rootPath` stays put while the
  // repository under it changes. Keying the check on the branch name alone made
  // every tab focus onto another repo announce a HEAD switch nobody performed.
  const local = "local:D:/work/app";
  const other = "local:D:/work/other";
  const hostA = "ssh:1:/home/u/app";
  // Two hosts really can have the same path checked out, which is why the
  // transport is in the key and not just the root.
  const hostB = "ssh:2:/home/u/app";

  const CASES: [
    string,
    Parameters<typeof isBranchSwitch>[0],
    Parameters<typeof isBranchSwitch>[1],
    boolean,
  ][] = [
    [
      "someone ran git switch in the same repo",
      { key: local, branch: "main" },
      { key: local, branch: "dev" },
      true,
    ],
    [
      "a poll that changed nothing",
      { key: local, branch: "main" },
      { key: local, branch: "main" },
      false,
    ],
    [
      "focusing a tab on another folder",
      { key: local, branch: "main" },
      { key: other, branch: "dev" },
      false,
    ],
    [
      "focusing an SSH terminal",
      { key: local, branch: "main" },
      { key: hostA, branch: "dev" },
      false,
    ],
    ["back to the local tab", { key: hostA, branch: "dev" }, { key: local, branch: "main" }, false],
    [
      "another host at the same path",
      { key: hostA, branch: "main" },
      { key: hostB, branch: "dev" },
      false,
    ],
    ["the first status of the session", null, { key: local, branch: "main" }, false],
    [
      "a detached HEAD or unreadable repo",
      { key: local, branch: "main" },
      { key: local, branch: null },
      false,
    ],
    [
      "a status that resolved no repo",
      { key: local, branch: "main" },
      { key: "", branch: "dev" },
      false,
    ],
  ];
  for (const [label, prev, next, want] of CASES) {
    check(label, isBranchSwitch(prev, next), want);
  }
}

/**
 * The Workspaces panel labels every terminal row with its folder's branch, and
 * it re-renders constantly (an agent's status flips several times a second).
 * Without this gate that is a `git branch` process per row per render; with it
 * too tight, a `git switch` in the terminal never shows up in the panel.
 */
{
  console.log("\nbranch cache: when to shell out to git");
  const now = 1_000_000;
  const CASES: [string, number | undefined, boolean, boolean][] = [
    ["a directory never asked about", undefined, false, true],
    ["a fresh answer is reused", now - 1_000, false, false],
    ["an answer just past the TTL is refetched", now - 15_000, false, true],
    ["a stale answer is refetched", now - 60_000, false, true],
    // Several panes in one repo render together; without this they would each
    // launch git for the same directory.
    ["a call already in flight is not doubled", undefined, true, false],
    ["not even once it is stale", now - 60_000, true, false],
  ];
  for (const [label, at, busy, want] of CASES) {
    check(label, shouldFetch(now, at, busy), want);
  }
}

console.log("\nstash");
{
  const { calls, ops } = recorder();
  await ops.stash("wip", false);
  // `--include-untracked` is the whole point: a new file is part of "my work
  // in progress" to everyone except git, and a stash without it silently
  // leaves that file behind in the tree.
  check("stashing everything includes untracked", calls, [
    ["stash", "push", "--include-untracked", "-m", "wip"],
  ]);
}
{
  const { calls, ops } = recorder();
  await ops.stash("", true);
  check("staged-only stash, no message", calls, [["stash", "push", "--staged"]]);
}
{
  const { calls, ops } = recorder();
  await ops.stashApply("stash@{1}", false);
  await ops.stashApply("stash@{0}", true);
  await ops.stashDrop("stash@{2}");
  check("apply keeps the entry", calls[0], ["stash", "apply", "stash@{1}"]);
  check("pop removes it", calls[1], ["stash", "pop", "stash@{0}"]);
  check("drop deletes it", calls[2], ["stash", "drop", "stash@{2}"]);
}
{
  // A stash subject is free text full of colons and spaces ("On main: WIP"),
  // so the tab is the only safe separator.
  const { ops } = recorder({
    "stash list": "stash@{0}\tOn main: WIP: fix: the thing\nstash@{1}\tOn dev: other\n",
  });
  check("stash list splits on the first tab only", await ops.stashes(), [
    { ref: "stash@{0}", subject: "On main: WIP: fix: the thing" },
    { ref: "stash@{1}", subject: "On dev: other" },
  ]);
}

console.log("\ntags");
{
  const { calls, ops } = recorder();
  await ops.createTag("v1.0.0", "Release 1.0.0");
  await ops.createTag("v1.0.1", "");
  await ops.deleteTag("v1.0.0");
  await ops.pushTag("v1.0.0");
  check("a message makes it annotated", calls[0], ["tag", "-a", "v1.0.0", "-m", "Release 1.0.0"]);
  check("no message makes it lightweight", calls[1], ["tag", "v1.0.1"]);
  check("delete is local", calls[2], ["tag", "-d", "v1.0.0"]);
  // `refs/tags/` and not the bare name: a branch and a tag can share a name,
  // and git would refuse the ambiguous push rather than guess.
  check("push is unambiguous", calls[3], ["push", "origin", "refs/tags/v1.0.0"]);
}
{
  const { ops } = recorder();
  // A tag is a ref, so a name git would read as an option must never reach
  // the command line.
  await ops.createTag("-rf", "").then(
    () => check("a tag named -rf is refused", "resolved", "rejected"),
    () => check("a tag named -rf is refused", "rejected", "rejected"),
  );
}

console.log("\nbranch and history operations");
{
  const { calls, ops } = recorder();
  await ops.merge("feature");
  await ops.rebase("main");
  await ops.abort("rebase");
  await ops.continueOp("merge");
  // `--no-edit` or a merge with no terminal stops to write a message forever.
  check("merge never opens an editor", calls[0], ["merge", "--no-edit", "feature"]);
  check("rebase takes the target", calls[1], ["rebase", "main"]);
  check("abort names the operation", calls[2], ["rebase", "--abort"]);
  check("continue names the operation", calls[3], ["merge", "--continue"]);
}
{
  const { calls, ops } = recorder();
  await ops.renameBranch("old", "new");
  await ops.branchAt("fix", "abc123");
  await ops.tagAt("v2", "abc123");
  check("rename moves the branch", calls[0], ["branch", "-m", "old", "new"]);
  // `checkout -b <name> <sha>` and not plain checkout: branching from a commit
  // in the history is exactly what HEAD-only branching cannot express.
  check("branch at a commit takes the sha", calls[1], ["checkout", "-b", "fix", "abc123"]);
  check("tag at a commit takes the sha", calls[2], ["tag", "v2", "abc123"]);
}
{
  const { calls, ops } = recorder();
  await ops.undoLastCommit();
  await ops.revert("abc123");
  await ops.cherryPick("def456");
  // `--soft`: Undo puts the work back in the index. `--mixed` would unstage it
  // and `--hard` would destroy it, and neither is what "undo" means.
  check("undo keeps the work staged", calls[0], ["reset", "--soft", "HEAD~1"]);
  check("revert never opens an editor", calls[1], ["revert", "--no-edit", "abc123"]);
  check("cherry-pick takes the sha", calls[2], ["cherry-pick", "def456"]);
}
{
  const { calls, ops } = recorder();
  await ops.resetTo("abc", "soft");
  await ops.resetTo("abc", "mixed");
  await ops.resetTo("abc", "hard");
  check("reset modes map to flags", calls, [
    ["reset", "--soft", "abc"],
    ["reset", "--mixed", "abc"],
    ["reset", "--hard", "abc"],
  ]);
}

console.log("\nsync");
{
  const { calls, ops } = recorder();
  await ops.sync("feature");
  check("sync pulls before it pushes", calls, [
    ["pull"],
    ["rev-parse", "--abbrev-ref", "@{u}"],
    ["push"],
  ]);
}
{
  // Sync on a branch that was never pushed has to publish it, not fail. This
  // is the same rule Push follows, and getting it wrong makes Sync useless on
  // exactly the branches that need it most.
  const { calls, ops } = recorder({ "rev-parse --abbrev-ref @{u}": NO_HEAD });
  await ops.sync("feature");
  check("sync publishes a branch with no upstream", calls[2], ["push", "-u", "origin", "feature"]);
}

console.log("\nhistory day separators");
{
  // Fixed "now" so the boundaries are testable at all: Today/Yesterday are
  // relative, and a naive `diff < 86400` would call 23:00 yesterday "today".
  const now = new Date(2026, 7, 12, 9, 0, 0); // Wed 12 Aug 2026, 09:00 local
  const at = (y: number, m: number, d: number, h = 12) =>
    Math.floor(new Date(y, m, d, h).getTime() / 1000);

  check("same calendar day is Today", dayLabel(at(2026, 7, 12, 1), now), "Today");
  check("late last night is Yesterday, not Today", dayLabel(at(2026, 7, 11, 23), now), "Yesterday");
  // 10 hours earlier than `now`, but a different calendar day: an elapsed-time
  // check would get this wrong, a date-bucket check cannot.
  check("early yesterday is still Yesterday", dayLabel(at(2026, 7, 11, 0), now), "Yesterday");
  check("this year omits the year", dayLabel(at(2026, 7, 9), now).includes("2026"), false);
  check("another year includes it", dayLabel(at(2025, 11, 9), now).includes("2025"), true);
}

console.log("\nauthor dots");
{
  check("two names give two initials", initials("Ilham Riski"), "IR");
  check("one name gives two letters", initials("ilhamrisky"), "IL");
  check("middle names are skipped, first and last kept", initials("Ada B C Lovelace"), "AL");
  check("an empty name never crashes the row", initials("   "), "?");
  // Stable across calls, or the same person changes colour on every render.
  check("the hue is deterministic", authorHue("dev@t.t"), authorHue("dev@t.t"));
  check("different people differ", authorHue("dev@t.t") === authorHue("dewi@t.t"), false);
  check("the hue is a legal degree", authorHue("x".repeat(200)) < 360, true);

  check(
    "a bare noreply address resolves to the account",
    githubAvatar("ilhamrisky@users.noreply.github.com", 32),
    "https://avatars.githubusercontent.com/ilhamrisky?s=32",
  );
  // The id form outlives a rename, so it wins when git recorded one.
  check(
    "the id form is preferred over the login",
    githubAvatar("18723904+ilhamrisky@users.noreply.github.com", 32),
    "https://avatars.githubusercontent.com/u/18723904?s=32",
  );
  // Everything below must stay null: the row falls back to the initials dot
  // rather than firing a request that can only 404, and a real address is
  // never handed to a third party.
  check("a real address is not sent anywhere", githubAvatar("dev@example.com"), null);
  check("a lookalike host is rejected", githubAvatar("x@users.noreply.github.com.evil.co"), null);
  check("an empty email never builds a URL", githubAvatar(""), null);
}

console.log("\nref chips");
{
  const labels = (refs: string[]) => parseRefs(refs).map((c) => `${c.kind}:${c.label}`);

  check("HEAD -> main splits into two chips", labels(["HEAD -> main"]), [
    "head:HEAD",
    "branch:main",
  ]);
  check("a tag keeps its own kind", labels(["tag: v0.4.23"]), ["tag:v0.4.23"]);
  // The row overflowed because git lists a pushed branch twice. They can only
  // share a commit when they are in sync, so the remote copy adds nothing.
  check(
    "a pushed branch shows once, not local + remote",
    labels(["HEAD -> feat/x", "origin/feat/x"]),
    ["head:HEAD", "branch:feat/x"],
  );
  // Unpushed work: the remote is behind on a different commit, so nothing is
  // collapsed and the remote chip still gets its own row.
  check("a remote with no local twin survives", labels(["origin/feat/x"]), [
    "remote:origin/feat/x",
  ]);
  check("a symref is always a duplicate", labels(["origin/HEAD", "origin/main"]), [
    "remote:origin/main",
  ]);
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failures > 0) throw new Error(`${failures} source-control op failure(s)`);
console.log("\nscm-ops-verify: OK");
