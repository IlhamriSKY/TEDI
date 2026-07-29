/**
 * Source Control write-path audit. Every panel action - stage, unstage,
 * discard, commit, push, branch switching - is composed in `makeOps` from
 * argument vectors handed to `git_run` (local) or `ssh_git` (remote), so this
 * drives the real implementation over a recording runner and asserts the exact
 * commands it emits. The destructive ones are the point: discard has to tell a
 * tracked file from a staged-new one, and restore both sides of a rename.
 * Run: `npx tsx scripts/scm-ops-verify.ts`.
 */
import { invalidBranchName, isBranchSwitch, makeOps } from "../src/modules/scm/api";

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

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failures > 0) throw new Error(`${failures} source-control op failure(s)`);
console.log("\nscm-ops-verify: OK");
