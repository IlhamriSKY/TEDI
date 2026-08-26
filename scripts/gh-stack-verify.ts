/**
 * Pull-request / stacked-PR audit. Every action in the PRs tab is composed in
 * `makeGh` from argument vectors handed to `gh_run`, so this drives the real
 * implementation over a recording runner and asserts the exact commands it
 * emits. Three of them are the point:
 *
 *  - `gh stack submit` MUST carry `--auto`. Without it gh opens a full-screen
 *    editor, and with no terminal attached that is a hang rather than a prompt.
 *  - `--auto` alone creates drafts, so a ready-for-review submit has to add
 *    `--open`. Getting that backwards silently ships every PR as a draft.
 *  - `gh stack view --json` prints a plain "not part of a stack" line AND EXITS
 *    ZERO when there is no stack, so the payload has to be recognised rather
 *    than the exit code trusted.
 *
 * The review half of the tab is here too, and its own three:
 *
 *  - `gh pr view` MUST carry the number. Without it gh resolves the current
 *    branch, so the panel would show a different pull request than the one
 *    that was clicked.
 *  - `gh pr merge` MUST name a method. Without one gh prompts, which with no
 *    terminal attached is a hang.
 *  - `statusCheckRollup` mixes two GraphQL shapes that share no field, so
 *    reading only `conclusion` silently drops every external CI result.
 *
 * Run: `npx tsx scripts/gh-stack-verify.ts`.
 */
import {
  checkName,
  checkOutcome,
  friendlyGhError,
  loosePrs,
  makeGh,
  mergeBlockReason,
  normalizePrDetail,
  parseStackView,
  prUrlFrom,
  stackRows,
  summarizeChecks,
  GH_NOT_FOUND,
  type PullRequest,
  type StackView,
} from "../src/modules/scm/gh";
import { splitPatch } from "../src/modules/scm/patch";

type Reply = string | Error;

/** Records every argument vector and answers from a canned table, keyed by a
 *  prefix of the joined args. Mirrors `scm-ops-verify.ts`. */
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
  return { calls, run, gh: makeGh(run) };
}

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

const STACK_JSON = JSON.stringify({
  trunk: "main",
  currentBranch: "feat-b",
  branches: [
    {
      name: "feat-a",
      base: "abc",
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    },
    {
      name: "feat-b",
      base: "def",
      isCurrent: true,
      isMerged: false,
      isQueued: false,
      needsRebase: true,
    },
    {
      name: "feat-c",
      base: "ghi",
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    },
  ],
});

const PRS: PullRequest[] = [
  {
    number: 10,
    title: "auth",
    url: "u10",
    state: "OPEN",
    isDraft: false,
    headRefName: "feat-a",
    baseRefName: "main",
  },
  {
    number: 11,
    title: "api",
    url: "u11",
    state: "OPEN",
    isDraft: true,
    headRefName: "feat-b",
    baseRefName: "feat-a",
  },
  {
    number: 9,
    title: "typo",
    url: "u9",
    state: "OPEN",
    isDraft: false,
    headRefName: "fix-typo",
    baseRefName: "main",
  },
];

console.log("\nstack view parsing");
{
  const view = parseStackView(STACK_JSON);
  check(
    "a real payload parses",
    view?.branches.map((b) => b.name),
    ["feat-a", "feat-b", "feat-c"],
  );
}
{
  // gh exits 0 here, so the exit code says nothing at all. Treating this as a
  // stack would put a "✗ current branch..." string on screen as a branch name.
  check(
    "no stack reads as null",
    parseStackView('✗ current branch "main" is not part of a stack'),
    null,
  );
  check("empty output reads as null", parseStackView(""), null);
  check("truncated json reads as null", parseStackView('{"trunk":"main"'), null);
  check("json without branches reads as null", parseStackView('{"trunk":"main"}'), null);
}

console.log("\nstack rows");
{
  const view = parseStackView(STACK_JSON) as StackView;
  const rows = stackRows(view, PRS);
  // Top layer first: the order gh prints, and the order the stack reads on
  // github.com. Rendering bottom-first would invert the whole diagram.
  check(
    "rows run top to bottom",
    rows.map((r) => r.name),
    ["feat-c", "feat-b", "feat-a"],
  );
  // `base` in the JSON is a commit sha, so the parent has to come from the
  // layer's position. Reading `base` would print a sha as a branch name.
  check(
    "each layer targets the one below it",
    rows.map((r) => r.parent),
    ["feat-b", "feat-a", "main"],
  );
  check(
    "pull requests join on the head branch",
    rows.map((r) => r.pr?.number ?? null),
    [null, 11, 10],
  );
  check(
    "the rebase flag survives the join",
    rows.map((r) => r.needsRebase),
    [false, true, false],
  );
  check(
    "a pr outside the stack is listed separately",
    loosePrs(view, PRS).map((p) => p.number),
    [9],
  );
  check(
    "without a stack every pr is loose",
    loosePrs(null, PRS).map((p) => p.number),
    [10, 11, 9],
  );
}

console.log("\nstack commands");
{
  const { calls, gh } = recorder();
  await gh.submitStack(false);
  // `--auto` or it hangs on an editor with no tty; `--open` or every PR in the
  // stack silently ships as a draft.
  check("submit for review is auto + open", calls, [["stack", "submit", "--auto", "--open"]]);
}
{
  const { calls, gh } = recorder();
  await gh.submitStack(true);
  check("submit as draft is auto alone", calls, [["stack", "submit", "--auto"]]);
}
{
  const { calls, gh } = recorder();
  await gh.initStack("feat-a", "develop");
  await gh.addToStack("feat-b");
  await gh.syncStack();
  await gh.mergeStack();
  check("init carries the trunk", calls[0], ["stack", "init", "--base", "develop", "feat-a"]);
  check("add takes the new layer", calls[1], ["stack", "add", "feat-b"]);
  check("sync takes no flags", calls[2], ["stack", "sync"]);
  // gh prompts to confirm a merge; with no terminal that is a failure, not a
  // question, so the confirmation has to be the app's dialog instead.
  check("merge confirms non-interactively", calls[3], ["stack", "merge", "--yes"]);
}
{
  const { calls, gh } = recorder();
  await gh.initStack("feat-a");
  check("init without a trunk omits --base", calls, [["stack", "init", "feat-a"]]);
}

console.log("\npull requests");
{
  const { calls, gh } = recorder({ "pr create": "https://github.com/o/r/pull/12\n" });
  const url = await gh.createPr({
    base: "feat-a",
    head: "feat-b",
    title: "Add the API",
    body: "why",
    draft: false,
  });
  // A base that is another feature branch is the whole stacked-PR mechanism:
  // GitHub derives the stack from this chain.
  check("create targets the given base", calls, [
    [
      "pr",
      "create",
      "--base",
      "feat-a",
      "--head",
      "feat-b",
      "--title",
      "Add the API",
      "--body",
      "why",
    ],
  ]);
  check("create resolves with the url", url, "https://github.com/o/r/pull/12");
}
{
  // gh mixes warnings and update notices into stdout. Opening the first line
  // blindly would send the browser to a warning instead of the new PR.
  const { gh } = recorder({
    "pr create": "Warning: 3 uncommitted changes\nhttps://github.com/o/r/pull/13\n",
  });
  const url = await gh.createPr({ base: "main", head: "x", title: "t", body: "", draft: false });
  check("the url is picked out of chatter", url, "https://github.com/o/r/pull/13");
  check("no url at all resolves empty, not to a warning", prUrlFrom("Warning: nothing\n"), "");
}
{
  const { calls, gh } = recorder({ "pr create": "u" });
  await gh.createPr({ base: "main", head: "x", title: "t", body: "", draft: true });
  check("draft appends --draft", calls[0]?.slice(-1), ["--draft"]);
}
{
  const { calls, gh } = recorder({ "pr list": "[]" });
  await gh.prs(5);
  check("the list is open prs only", calls[0]?.slice(0, 6), [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "5",
  ]);
}

console.log("\npreflight");
{
  // Only a missing binary is "not installed". An unauthenticated gh still
  // runs, and sending that user to download gh again would be a dead end.
  const { gh } = recorder({
    "auth status": new Error(GH_NOT_FOUND),
    "extension list": new Error("x"),
  });
  check("a missing binary is reported as such", await gh.probe(), {
    installed: false,
    authenticated: false,
    stackExtension: false,
  });
}
{
  const { gh } = recorder({
    "auth status": new Error(
      "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    ),
    "extension list": "gh stack\tgithub/gh-stack\tv0.1.0",
  });
  check("signed out still counts as installed", await gh.probe(), {
    installed: true,
    authenticated: false,
    stackExtension: true,
  });
}
{
  const { gh } = recorder({ "auth status": "✓ Logged in", "extension list": "" });
  check("no extension disables the stack actions", await gh.probe(), {
    installed: true,
    authenticated: true,
    stackExtension: false,
  });
}
{
  const { gh } = recorder({ "repo view": '{"defaultBranchRef":{"name":"develop"}}' });
  check("the default branch is the first pr's base", await gh.defaultBranch(), "develop");
}
{
  const { gh } = recorder({ "stack view": '✗ current branch "main" is not part of a stack' });
  check("no stack is not an error", await gh.stack(), null);
}

console.log("\nerror messages");
{
  check(
    "missing binary",
    friendlyGhError(new Error(GH_NOT_FOUND)),
    "GitHub CLI (gh) is not installed.",
  );
  check(
    "signed out",
    friendlyGhError(new Error("You are not logged into any GitHub hosts")),
    "Not signed in to GitHub. Run `gh auth login` in a terminal.",
  );
  check(
    "no extension",
    friendlyGhError(new Error('unknown command "stack" for "gh"')),
    "The gh-stack extension is not installed.",
  );
  check("unknown errors pass through", friendlyGhError(new Error("boom")), "boom");
}

console.log("\npull-request review: the argument vectors");
{
  const { calls, gh } = recorder({ "pr view": "{}" });
  await gh.prDetail(12);
  const argv = calls[0] ?? [];
  check("prDetail addresses the pull request by NUMBER", argv.slice(0, 4), [
    "pr",
    "view",
    "12",
    "--json",
  ]);
  // Without an explicit number gh resolves the CURRENT branch, which would show
  // a different pull request than the one that was clicked.
  const fields = (argv[4] ?? "").split(",");
  for (const f of ["reviews", "comments", "statusCheckRollup", "mergeStateStatus", "files"]) {
    check(`the one view call asks for ${f}`, fields.includes(f), true);
  }
}
{
  const { calls, gh } = recorder();
  await gh.prDiff(12);
  check("prDiff reads the patch without touching the working tree", calls[0], ["pr", "diff", "12"]);
}
{
  const { calls, gh } = recorder();
  await gh.reviewPr(12, "approve", "   ");
  // GitHub takes a bare approval; sending `--body ""` is a usage error.
  check("an approval with no message sends no --body", calls[0], [
    "pr",
    "review",
    "12",
    "--approve",
  ]);
}
{
  const { calls, gh } = recorder();
  await gh.reviewPr(12, "request-changes", " fix the guard ");
  check("a verdict that needs a message carries it trimmed", calls[0], [
    "pr",
    "review",
    "12",
    "--request-changes",
    "--body",
    "fix the guard",
  ]);
}
{
  const { calls, gh } = recorder();
  await gh.mergePr(12, "squash", true);
  // A method is mandatory: without one gh prompts, and a prompt with no
  // terminal attached is a hang.
  check("merge names its method and the branch cleanup", calls[0], [
    "pr",
    "merge",
    "12",
    "--squash",
    "--delete-branch",
  ]);
}
{
  const { calls, gh } = recorder();
  await gh.mergePr(12, "rebase", false);
  check("keeping the branch omits the flag", calls[0], ["pr", "merge", "12", "--rebase"]);
}
{
  const { calls, gh } = recorder();
  await gh.markReady(12);
  check("a draft can leave draft without the browser", calls[0], ["pr", "ready", "12"]);
}

console.log("\ncheck rollup: gh mixes two GraphQL shapes in one array");
{
  const rollup = [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "ci/external", state: "FAILURE" },
    { __typename: "CheckRun", name: "slow", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "CheckRun", name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
  ];
  // Reading only `conclusion` would drop the external status entirely, which
  // reads as "all green" on a red pull request.
  check("both shapes are counted", summarizeChecks(rollup), {
    total: 4,
    passed: 1,
    failed: 1,
    pending: 1,
    state: "failure",
  });
  check("a name comes from either field", checkName(rollup[1]), "ci/external");
  // A path filter skipping a job is the normal case, not a failure.
  check("SKIPPED is neutral, not red", checkOutcome(rollup[3]), "neutral");
  // A run still going is pending whatever its (empty) conclusion says.
  check("IN_PROGRESS outranks the conclusion", checkOutcome(rollup[2]), "pending");
  check("no checks is not a failure", summarizeChecks(null).state, "none");
}

console.log("\nmerge gating, answered locally");
{
  const base = normalizePrDetail({
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
  });
  check("a clean open pull request merges", mergeBlockReason(base), null);
  check(
    "a draft says what to do first",
    mergeBlockReason({ ...base, isDraft: true }),
    "This is a draft. Mark it ready for review first.",
  );
  check(
    "a conflict is named",
    mergeBlockReason({ ...base, mergeable: "CONFLICTING" }),
    "It conflicts with the base branch.",
  );
  check(
    "a blocked branch protection is named",
    mergeBlockReason({ ...base, mergeStateStatus: "BLOCKED" }),
    "GitHub is blocking the merge (a required review or check has not passed).",
  );
  check(
    "a merged pull request offers nothing",
    mergeBlockReason({ ...base, state: "MERGED" }),
    "This pull request is merged.",
  );
  // One missing key in gh's answer must not crash the view on `.map`.
  check("an empty answer still has arrays", normalizePrDetail({}).files, []);
}

console.log("\npatch splitting");
{
  const PATCH = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const x = 1;",
    "-const y = 2;",
    "+const y = 3;",
    "+const z = 4;",
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "diff --git a/logo.png b/logo.png",
    "index 333..444 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-one",
    "-two",
    "",
  ].join("\n");
  const files = splitPatch(PATCH);
  check(
    "one block per file",
    files.map((f) => f.path),
    ["src/a.ts", "new.txt", "logo.png", "gone.ts"],
  );
  // The counting bug this guards: `+++ b/src/a.ts` and `--- a/src/a.ts` both
  // start with a change sign, so a naive counter reports 3/2 instead of 2/1.
  check(
    "the file headers are not counted as changes",
    [files[0].additions, files[0].deletions],
    [2, 1],
  );
  check("the hunk header survives for the view to colour", files[0].lines[0], "@@ -1,3 +1,4 @@");
  check("a rename keeps both names", [files[1].oldPath, files[1].path], ["old.txt", "new.txt"]);
  check(
    "a binary file is flagged, not rendered",
    [files[2].binary, files[2].lines.length],
    [true, 0],
  );
  // `+++ /dev/null` must not blank the path of a deleted file.
  check("a deletion keeps the path it removed", files[3].path, "gone.ts");
  check("a deletion counts only its removals", [files[3].additions, files[3].deletions], [0, 2]);
  check("the trailing newline is not a blank row", files[3].lines.at(-1), "-two");
  check("an empty patch is an empty list", splitPatch(""), []);
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failures > 0) throw new Error(`${failures} gh / stacked-PR failure(s)`);
console.log("\ngh-stack-verify: OK");
