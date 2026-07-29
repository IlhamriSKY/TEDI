import { invoke } from "@tauri-apps/api/core";
import type { CommitDetail, GitBranch, GitCommit, GitStatus } from "./types";
import type { FsReadResult } from "@/lib/ipc";

/** Mirrors Rust `fs::file::ReadResult` (git_file_head / git_file_at reuse it). */
export type FileReadResult = FsReadResult;

export function gitStatus(repoPath: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { repoPath });
}

/** `git status` for the repo an SSH terminal is sitting in, run over that
 *  session. `added`/`removed`/`binary` are always 0/false because the
 *  line-count enrichment reads the local disk. `cwd` may be empty, which runs
 *  in the remote login directory. */
export function gitStatusSsh(sessionId: number, cwd: string): Promise<GitStatus> {
  return invoke<GitStatus>("ssh_git_status", { id: sessionId, cwd });
}

/** Gitignored working-tree entries as forward-slash absolute paths (fully
 *  ignored directories collapsed to the directory). Drives explorer dimming. */
export function gitIgnored(repoPath: string): Promise<string[]> {
  return invoke<string[]>("git_ignored", { repoPath });
}

export function gitFileHead(repoPath: string, relative: string): Promise<FileReadResult> {
  return invoke<FileReadResult>("git_file_head", { repoPath, relative });
}

/** Read a file's blob at an arbitrary commit (`rev` is a hex SHA). */
export function gitFileAt(
  repoPath: string,
  rev: string,
  relative: string,
): Promise<FileReadResult> {
  return invoke<FileReadResult>("git_file_at", { repoPath, rev, relative });
}

export function gitDiffFull(repoPath: string, maxBytes?: number): Promise<string> {
  return invoke<string>("git_diff_full", { repoPath, maxBytes });
}

export function gitLog(repoPath: string, limit?: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { repoPath, limit });
}

export function gitCommitDetail(repoPath: string, sha: string): Promise<CommitDetail> {
  return invoke<CommitDetail>("git_commit_detail", { repoPath, sha });
}

/** Runs one whitelisted git subcommand and resolves with its stdout. Rejects
 *  with the command's stderr on a non-zero exit. */
type Runner = (args: string[]) => Promise<string>;

/**
 * Every write the panel can perform. Both transports share one implementation
 * (`makeOps`) so a remote repository behaves like a local one instead of
 * tracking a second, drifting code path.
 */
export type GitOps = {
  /** Add paths to the index. Also stages a deletion. */
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  /**
   * Restore paths to HEAD and delete the ones HEAD never had. Pass BOTH sides
   * of a rename or the new file is deleted and the old one stays gone.
   */
  discard(paths: string[]): Promise<void>;
  discardAll(): Promise<void>;
  commit(message: string, amend?: boolean): Promise<void>;
  /** `branch` is only used to publish a branch that has no upstream yet. */
  push(branch: string | null, force?: boolean): Promise<void>;
  pull(): Promise<void>;
  fetch(): Promise<void>;
  /** Combined diff vs HEAD, capped, for the AI commit-message generator. */
  diff(maxBytes: number): Promise<string>;
  branches(): Promise<GitBranch[]>;
  /** Switch to `name`, creating it from HEAD when `create` is set. A remote
   *  ref checks out (or creates) the local branch that follows it. */
  checkout(name: string, create?: boolean): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
};

/**
 * git's own rules from `check-ref-format`, applied before the name reaches a
 * command line. The leading-dash case is the one that matters: `git branch -d`
 * would read such a name as an option rather than a ref.
 */
export function invalidBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a branch name.";
  if (n.startsWith("-")) return "A branch name cannot start with '-'.";
  if (/[\s~^:?*[\\]/.test(n)) return "A branch name cannot contain spaces or ~^:?*[\\.";
  if (n.includes("..") || n.includes("@{")) return "A branch name cannot contain '..' or '@{'.";
  if (n.startsWith("/") || n.endsWith("/") || n.includes("//")) {
    return "A branch name cannot start or end with '/', or contain '//'.";
  }
  if (n.endsWith(".") || n.endsWith(".lock"))
    return "A branch name cannot end with '.' or '.lock'.";
  return null;
}

/**
 * Whether a status update is a real HEAD switch worth announcing, rather than
 * the panel being pointed at another repository.
 *
 * `key` identifies the repository the branch was read from (transport plus
 * resolved root). Comparing branch names alone made every tab focus that moved
 * the panel to a different repo - any SSH terminal, or back to the local one -
 * look like someone had run `git switch`.
 */
export function isBranchSwitch(
  prev: { key: string; branch: string } | null,
  next: { key: string; branch: string | null },
): boolean {
  if (!next.branch || !next.key || prev === null) return false;
  return prev.key === next.key && prev.branch !== next.branch;
}

/** `git for-each-ref` rows: refname, short name, `*` for HEAD, upstream. */
function parseBranches(raw: string): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [refname = "", short = "", head = "", upstream = ""] = line.split("\t");
    // `origin/HEAD` is a symref pointing at the remote's default branch, not a
    // branch of its own; checking it out would detach HEAD.
    if (!short || short.endsWith("/HEAD")) continue;
    out.push({
      name: short,
      current: head.trim() === "*",
      remote: refname.startsWith("refs/remotes/"),
      upstream: upstream || null,
    });
  }
  return out;
}

/** Exported so `scripts/scm-ops-verify.ts` can drive the real sequencing over a
 *  recording runner instead of a live repository. */
export function makeOps(run: Runner): GitOps {
  const ok = async (args: string[]) => {
    await run(args);
  };
  const succeeds = (args: string[]) =>
    run(args).then(
      () => true,
      () => false,
    );
  const hasHead = () => succeeds(["rev-parse", "--verify", "-q", "HEAD"]);

  const discard: GitOps["discard"] = async (paths) => {
    if (paths.length === 0) return;
    const head = await hasHead();
    // Which paths exist at HEAD decides how each is undone: a tracked file is
    // restored from HEAD, anything else (untracked, or staged-new) is deleted.
    // This used to ask `ls-files --error-unmatch`, which answers about the
    // INDEX - so discarding a staged new file ran `checkout HEAD --` against a
    // path HEAD has never seen, and failed with a raw git error instead of
    // removing the file.
    const atHead = head
      ? new Set(
          (await run(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...paths]))
            .split("\0")
            .filter(Boolean),
        )
      : new Set<string>();
    // Unstage first so a staged edit, rename or deletion is undone too.
    if (head) await ok(["reset", "-q", "HEAD", "--", ...paths]);
    const tracked = paths.filter((p) => atHead.has(p));
    if (tracked.length > 0) await ok(["checkout", "-q", "HEAD", "--", ...tracked]);
    const rest = paths.filter((p) => !atHead.has(p));
    // `clean` ignores tracked files, so the untracked-only list is exact.
    if (rest.length > 0) await ok(["clean", "-fdq", "--", ...rest]);
  };

  return {
    stage: (paths) => (paths.length ? ok(["add", "-A", "--", ...paths]) : Promise.resolve()),
    unstage: async (paths) => {
      if (paths.length === 0) return;
      // A repo with no commits has no HEAD to reset against, and everything in
      // its index is an add, so dropping the cache entry is the same operation.
      await ok(
        (await hasHead())
          ? ["reset", "-q", "HEAD", "--", ...paths]
          : ["rm", "--cached", "-r", "-q", "--", ...paths],
      );
    },
    discard,
    discardAll: async () => {
      if (await hasHead()) await ok(["reset", "-q", "--hard", "HEAD"]);
      await ok(["clean", "-fdq"]);
    },
    commit: (message, amend) =>
      ok(amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message]),
    push: async (branch, force) => {
      const flags = force ? ["--force-with-lease"] : [];
      // `@{u}` failing is the only signal git gives for "no upstream yet";
      // publishing then sets one, which is what VSCode's Publish Branch does.
      if (await succeeds(["rev-parse", "--abbrev-ref", "@{u}"])) {
        await ok(["push", ...flags]);
        return;
      }
      if (!branch) throw new Error("No current branch to publish (detached HEAD).");
      await ok(["push", ...flags, "-u", "origin", branch]);
    },
    pull: () => ok(["pull"]),
    fetch: () => ok(["fetch", "--prune"]),
    diff: async (maxBytes) =>
      (await run(["diff", "HEAD", "--no-color", "--unified=3"])).slice(0, maxBytes),
    branches: async () =>
      parseBranches(
        await run([
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)",
          "refs/heads",
          "refs/remotes",
        ]),
      ),
    checkout: async (name, create) => {
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      if (create) {
        await ok(["checkout", "-b", name]);
        return;
      }
      if (await succeeds(["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) {
        await ok(["checkout", name]);
        return;
      }
      // A remote-tracking ref: switch to the local branch that follows it, or
      // create it. Checking out `origin/x` directly would detach HEAD.
      const local = name.replace(/^[^/]+\//, "");
      await ok(
        (await succeeds(["show-ref", "--verify", "--quiet", `refs/heads/${local}`]))
          ? ["checkout", local]
          : ["checkout", "-b", local, "--track", name],
      );
    },
    deleteBranch: async (name, force) => {
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      await ok(["branch", force ? "-D" : "-d", name]);
    },
  };
}

/** Operate on the workspace repository containing `repoPath`. */
export function localOps(repoPath: string): GitOps {
  const base = makeOps((args) => invoke<string>("git_run", { repoPath, args }));
  // The local reader is richer: it appends the untracked-file list, which is
  // what tells the AI generator a new file was added at all.
  return { ...base, diff: (maxBytes) => gitDiffFull(repoPath, maxBytes) };
}

/** Operate on `root` over an SSH session. `root` comes from `gitStatusSsh`, so
 *  it is already the remote repository's top level. */
export function remoteOps(sessionId: number, root: string): GitOps {
  return makeOps((args) => invoke<string>("ssh_git", { id: sessionId, cwd: root, args }));
}
