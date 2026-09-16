/**
 * Self-check for sharing in-flight `git_status` / `git_ignored` calls.
 * Run: `npx tsx scripts/scm/git-read-dedupe-verify.ts` (part of `pnpm verify`).
 *
 * Every git view (Explorer, a second Explorer, an extension's folder tree,
 * Source Control) polls the same repository on the same aligned 2.5 s clock, so
 * each tick asked for the same status two to four times in one millisecond, and
 * each ask is four git processes. `scm/api.ts` now lets a caller join a call
 * that is already running. What has to stay true:
 *  1. Concurrent asks for one repo are ONE invoke, and every caller gets it.
 *  2. Only in-flight calls are shared: once settled, the next ask is fresh.
 *  3. A failure reaches every joiner and is not remembered.
 *  4. status and ignored, and two repos, never share with each other.
 *  5. A git command run through the app, or a file write it announces, drops the
 *     shared calls, so a refresh right after it cannot get a pre-mutation status.
 *  6. A lean ask (no line counts) joins a full call, never the other way round,
 *     and while a view that draws the counts is open every ask is full.
 */
/// <reference types="node" />
export {};

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

type Pending = {
  cmd: string;
  args: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};
const calls: Pending[] = [];
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: Record<string, unknown>) =>
      new Promise((resolve, reject) => calls.push({ cmd, args, resolve, reject })),
  },
  dispatchEvent: () => true,
};
const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
const last = (cmd: string) => calls.filter((c) => c.cmd === cmd).at(-1)!;
const tick = () => new Promise((r) => setTimeout(r, 0));

const { gitStatus, gitIgnored, localOps, retainLineCounts } =
  await import("../../src/modules/scm/api");
const { dispatchFsRefresh } = await import("../../src/modules/explorer/lib/fsRefresh");
const REPO = "D:/repo";
const statusOf = (root: string) => ({ isRepo: true, root, changes: [] });

console.log("1. concurrent asks for one repo are one invoke");
{
  const a = gitStatus(REPO);
  const b = gitStatus(REPO);
  const c = gitStatus(REPO);
  assert(count("git_status") === 1, "three callers, one git_status invoke");
  last("git_status").resolve(statusOf(REPO));
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert(ra === rb && rb === rc && ra.root === REPO, "every caller gets that one result");
}

console.log("2. a settled result is never reused");
{
  const before = count("git_status");
  const p = gitStatus(REPO);
  assert(count("git_status") === before + 1, "the next tick starts a fresh invoke");
  last("git_status").resolve(statusOf(REPO));
  await p;
}

console.log("3. a failure reaches every joiner and is forgotten");
{
  const before = count("git_status");
  const a = gitStatus(REPO).catch((e: Error) => e.message);
  const b = gitStatus(REPO).catch((e: Error) => e.message);
  last("git_status").reject(new Error("not a repo"));
  assert((await a) === "not a repo" && (await b) === "not a repo", "both callers see the error");
  const c = gitStatus(REPO);
  assert(count("git_status") === before + 2, "the call after a failure invokes again");
  last("git_status").resolve(statusOf(REPO));
  await c;
}

console.log("4. different commands and different repos do not share");
{
  const s = count("git_status");
  const i = count("git_ignored");
  const p1 = gitStatus(REPO);
  const p2 = gitIgnored(REPO);
  const p3 = gitStatus("D:/other");
  assert(count("git_ignored") === i + 1, "ignored is its own invoke");
  assert(count("git_status") === s + 2, "another repo is its own invoke");
  for (const c of calls.slice(-3))
    c.resolve(c.cmd === "git_ignored" ? [] : statusOf(String(c.args.repoPath)));
  await Promise.all([p1, p2, p3]);
}

console.log("5. an app mutation drops the shared calls");
{
  // A poll is running when the user stages a file.
  const poll = gitStatus(REPO);
  const before = count("git_status");
  const stage = localOps(REPO).stage(["a.txt"]);
  last("git_run").resolve("");
  await stage;
  await tick();
  const refresh = gitStatus(REPO);
  assert(
    count("git_status") === before + 1,
    "a refresh after git_run does not join the older poll",
  );
  last("git_status").resolve(statusOf(REPO));
  calls.filter((c) => c.cmd === "git_status")[before - 1].resolve(statusOf(REPO));
  await Promise.all([poll, refresh]);

  // Same, for a file write the app announces.
  const poll2 = gitStatus(REPO);
  const before2 = count("git_status");
  dispatchFsRefresh("D:/repo/src", "D:/repo/src/a.ts");
  const refresh2 = gitStatus(REPO);
  assert(
    count("git_status") === before2 + 1,
    "a refresh after dispatchFsRefresh does not join the older poll",
  );
  last("git_status").resolve(statusOf(REPO));
  calls.filter((c) => c.cmd === "git_status")[before2 - 1].resolve(statusOf(REPO));
  await Promise.all([poll2, refresh2]);
}

console.log("6. line counts: lean joins full, full never joins lean");
{
  const before = count("git_status");
  const full = gitStatus(REPO);
  const lean = gitStatus(REPO, { lineCounts: false });
  assert(count("git_status") === before + 1, "a lean ask joins a running full call");
  last("git_status").resolve(statusOf(REPO));
  await Promise.all([full, lean]);

  const lean2 = gitStatus(REPO, { lineCounts: false });
  assert(last("git_status").args.lineCounts === false, "a lean ask alone runs lean");
  const full2 = gitStatus(REPO);
  assert(count("git_status") === before + 3, "a full ask does not join a lean call");
  assert(last("git_status").args.lineCounts === true, "it runs its own full call");
  for (const c of calls.filter((c) => c.cmd === "git_status").slice(-2)) c.resolve(statusOf(REPO));
  await Promise.all([lean2, full2]);

  const release = retainLineCounts();
  const lean3 = gitStatus(REPO, { lineCounts: false });
  assert(
    last("git_status").args.lineCounts === true,
    "with a counting view open, a lean ask runs full",
  );
  const full3 = gitStatus(REPO);
  assert(count("git_status") === before + 4, "so the counting view joins it");
  last("git_status").resolve(statusOf(REPO));
  await Promise.all([lean3, full3]);
  release();
  release();
  const lean4 = gitStatus(REPO, { lineCounts: false });
  assert(
    last("git_status").args.lineCounts === false,
    "released (once, however often called): lean again",
  );
  last("git_status").resolve(statusOf(REPO));
  await lean4;
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: git-read-dedupe-verify`);
process.exit(failed === 0 ? 0 : 1);
