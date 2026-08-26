import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetail,
  GitBranch,
  GitCommit,
  GitInProgress,
  GitStash,
  GitStatus,
} from "./types";
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

function gitDiffFull(repoPath: string, maxBytes?: number): Promise<string> {
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
  /**
   * One file's unified diff, which is what partial staging is built on.
   * `staged` reads index-vs-HEAD (what unstaging a hunk undoes), otherwise
   * worktree-vs-index (what staging a hunk records).
   */
  fileDiff(relative: string, staged: boolean): Promise<string>;
  /**
   * Apply a patch this app synthesised - one hunk, or part of one.
   *
   * `cached` writes the INDEX (stage / unstage), otherwise the WORKING TREE
   * (discard); `reverse` undoes instead of applies. LOCAL REPOSITORIES ONLY:
   * the patch travels on stdin and `ssh_git` has no stdin, so the remote
   * transport rejects it rather than silently doing nothing.
   */
  applyPatch(patch: string, cached: boolean, reverse: boolean): Promise<void>;
  branches(): Promise<GitBranch[]>;
  /** Switch to `name`, creating it from HEAD when `create` is set. A remote
   *  ref checks out (or creates) the local branch that follows it. */
  checkout(name: string, create?: boolean): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  renameBranch(from: string, to: string): Promise<void>;
  /** Pull then push, the one button VSCode calls Sync. */
  sync(branch: string | null): Promise<void>;
  /** Merge `name` INTO the current branch. Never opens an editor. */
  merge(name: string): Promise<void>;
  /** Replay the current branch on top of `name`. */
  rebase(name: string): Promise<void>;
  /** Abandon a half-finished merge/rebase/cherry-pick/revert. */
  abort(op: GitInProgress): Promise<void>;
  /** Resume one after its conflicts were staged. */
  continueOp(op: GitInProgress): Promise<void>;
  /** Move HEAD back one commit, keeping the change staged. */
  undoLastCommit(): Promise<void>;
  revert(sha: string): Promise<void>;
  cherryPick(sha: string): Promise<void>;
  /** `soft` keeps the work staged, `mixed` unstages it, `hard` destroys it. */
  resetTo(sha: string, mode: "soft" | "mixed" | "hard"): Promise<void>;
  stashes(): Promise<GitStash[]>;
  /** `staged` stashes only the index; otherwise everything, untracked included. */
  stash(message: string, staged?: boolean): Promise<void>;
  /** `pop` drops the entry after restoring it; otherwise it is kept. */
  stashApply(ref: string, pop: boolean): Promise<void>;
  stashDrop(ref: string): Promise<void>;
  tags(): Promise<string[]>;
  /** Annotated when a message is given, lightweight otherwise. */
  createTag(name: string, message: string): Promise<void>;
  deleteTag(name: string): Promise<void>;
  pushTag(name: string): Promise<void>;
  /** Create `name` pointing at `sha` and switch to it. `checkout` only ever
   *  branches from HEAD, so branching off a commit in the history needs this. */
  branchAt(name: string, sha: string): Promise<void>;
  /** Tag an arbitrary commit rather than HEAD. */
  tagAt(name: string, sha: string): Promise<void>;
  /** Turn the folder into a repository. The only op that runs outside one. */
  init(): Promise<void>;
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

/**
 * `git stash list --format=%gd%x09%gs` rows. Tab-separated because a stash
 * subject is free text that routinely contains colons and spaces ("On main:
 * WIP"), so splitting on anything narrower would truncate it.
 */
export function parseStashes(raw: string): GitStash[] {
  const out: GitStash[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    out.push({ ref: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return out;
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
    renameBranch: async (from, to) => {
      const bad = invalidBranchName(to);
      if (bad) throw new Error(bad);
      await ok(["branch", "-m", from, to]);
    },

    sync: async (branch) => {
      await ok(["pull"]);
      // Reuses the publish path rather than a bare `push`, so a Sync on a
      // branch that has no upstream yet sets one instead of failing.
      const flags: string[] = [];
      if (await succeeds(["rev-parse", "--abbrev-ref", "@{u}"])) {
        await ok(["push", ...flags]);
        return;
      }
      if (!branch) throw new Error("No current branch to publish (detached HEAD).");
      await ok(["push", "-u", "origin", branch]);
    },
    // `--no-edit` on top of GIT_EDITOR=true: belt and braces, because a merge
    // that stops to write a message would hang a worker with no terminal.
    merge: (name) => ok(["merge", "--no-edit", name]),
    rebase: (name) => ok(["rebase", name]),
    abort: (op) => ok([op, "--abort"]),
    continueOp: (op) => ok([op, "--continue"]),
    // `--soft`, so the commit's content lands back in the index rather than
    // being thrown away. This is Undo, not Discard.
    undoLastCommit: () => ok(["reset", "--soft", "HEAD~1"]),
    revert: (sha) => ok(["revert", "--no-edit", sha]),
    cherryPick: (sha) => ok(["cherry-pick", sha]),
    resetTo: (sha, mode) => ok(["reset", `--${mode}`, sha]),

    stashes: async () => parseStashes(await run(["stash", "list", "--format=%gd%x09%gs"])),
    stash: (message, staged) =>
      ok([
        "stash",
        "push",
        // Untracked files are part of "my work in progress" to everyone except
        // git; leaving them behind is how a stash silently loses a new file.
        ...(staged ? ["--staged"] : ["--include-untracked"]),
        ...(message.trim() ? ["-m", message.trim()] : []),
      ]),
    stashApply: (ref, pop) => ok(["stash", pop ? "pop" : "apply", ref]),
    stashDrop: (ref) => ok(["stash", "drop", ref]),

    tags: async () =>
      (await run(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)", "refs/tags"]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    createTag: async (name, message) => {
      // A tag is a ref, so it is held to the same name rules as a branch.
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      await ok(message.trim() ? ["tag", "-a", name, "-m", message.trim()] : ["tag", name]);
    },
    deleteTag: async (name) => {
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      await ok(["tag", "-d", name]);
    },
    pushTag: async (name) => {
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      await ok(["push", "origin", `refs/tags/${name}`]);
    },

    branchAt: async (name, sha) => {
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      await ok(["checkout", "-b", name, sha]);
    },
    tagAt: async (name, sha) => {
      const bad = invalidBranchName(name);
      if (bad) throw new Error(bad);
      await ok(["tag", name, sha]);
    },

    init: () => ok(["init"]),

    // `--no-ext-diff` / `--no-textconv` are not tidiness: a user with
    // `diff.external` or a textconv filter configured would otherwise get a
    // rendering instead of a patch, and every hunk offered would be a fiction.
    // `-U3` pins the context so the patch we build is the patch we parsed
    // whatever `diff.context` says.
    fileDiff: (relative, staged) =>
      run([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "-U3",
        ...(staged ? ["--cached"] : []),
        "--",
        relative,
      ]),

    applyPatch: () =>
      Promise.reject(new Error("Staging part of a file needs a local repository, not an SSH one.")),
  };
}

/** Operate on the workspace repository containing `repoPath`. */
export function localOps(repoPath: string): GitOps {
  const base = makeOps((args) => invoke<string>("git_run", { repoPath, args }));
  // The local reader is richer: it appends the untracked-file list, which is
  // what tells the AI generator a new file was added at all. `applyPatch` is
  // its own command because the patch goes in on STDIN, which `git_run` closes.
  return {
    ...base,
    diff: (maxBytes) => gitDiffFull(repoPath, maxBytes),
    applyPatch: (patch, cached, reverse) =>
      invoke<void>("git_apply_patch", { repoPath, patch, cached, reverse }),
  };
}

/** Operate on `root` over an SSH session. `root` comes from `gitStatusSsh`, so
 *  it is already the remote repository's top level. */
export function remoteOps(sessionId: number, root: string): GitOps {
  return makeOps((args) => invoke<string>("ssh_git", { id: sessionId, cwd: root, args }));
}
