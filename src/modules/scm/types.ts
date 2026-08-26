export type GitChangeStatus =
  "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "ignored";

export type GitChange = {
  path: string;
  relative: string;
  status: GitChangeStatus;
  /** Path this entry was renamed/copied FROM, else null. Discarding a rename
   *  has to restore both sides, so the source travels with the row. */
  oldRelative: string | null;
  staged: boolean;
  /** Lines added vs HEAD. 0 for binary or not applicable. */
  added: number;
  /** Lines removed vs HEAD. 0 for binary or not applicable. */
  removed: number;
  /** True when git reports the entry as binary. */
  binary: boolean;
};

/** A multi-step git operation the repo is sitting in the middle of. */
export type GitInProgress = "merge" | "rebase" | "cherry-pick" | "revert";

export type GitStatus = {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  /** True when `changes` was cut short because the repo has more of them than
   *  the backend will list. Every row costs a JSON round trip, a sort and a DOM
   *  node, so an unbounded list froze the window; the panel says the list is
   *  partial rather than passing it off as the whole working tree. */
  truncated: boolean;
  /** Set while a merge/rebase/cherry-pick/revert is half-finished, so the panel
   *  can offer Abort and Continue only when they mean something. Always null
   *  over SSH, where the marker files are not read. */
  inProgress: GitInProgress | null;
};

/** One entry of `git stash list`. */
export type GitStash = {
  /** Reflog selector, e.g. `stash@{0}`. What every stash command takes. */
  ref: string;
  /** Reflog subject, e.g. "On main: WIP before the refactor". */
  subject: string;
};

/** One entry from `git for-each-ref` over refs/heads + refs/remotes. */
export type GitBranch = {
  /** Short name: "main" for a local branch, "origin/main" for a remote one. */
  name: string;
  /** True for the checked-out branch (never true for a remote entry). */
  current: boolean;
  remote: boolean;
  /** Tracking branch for a local entry, else null. */
  upstream: string | null;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  parents: string[];
  /** Raw refs with prefixes preserved: "HEAD -> main", "tag: v1", "origin/main". */
  refs: string[];
  authorName: string;
  authorEmail: string;
  /** Author timestamp as Unix seconds. */
  authorTime: number;
  subject: string;
};

/** A single file touched by a commit (vs its first parent / the empty tree). */
export type CommitFile = {
  /** Repo-relative forward-slash path at the commit (the new side). */
  path: string;
  /** Previous path for renames/copies, else null. */
  oldPath: string | null;
  status: GitChangeStatus;
  /** Lines added vs the parent. 0 for binary or not applicable. */
  added: number;
  /** Lines removed vs the parent. 0 for binary or not applicable. */
  removed: number;
  binary: boolean;
};

/** Full metadata + changed-file list for one commit. */
export type CommitDetail = {
  sha: string;
  shortSha: string;
  parents: string[];
  refs: string[];
  authorName: string;
  authorEmail: string;
  /** Author timestamp as Unix seconds. */
  authorTime: number;
  committerName: string;
  committerEmail: string;
  /** Commit timestamp as Unix seconds. */
  commitTime: number;
  subject: string;
  body: string;
  files: CommitFile[];
};

/**
 * Input for opening a diff in a tab. Without the commit fields it's a
 * working-tree diff (HEAD vs working tree). With `commitSha` set it's a
 * per-commit diff: the file at `commitSha` vs `baseRev` (its first parent,
 * or null for the root commit).
 */
export type OpenDiffInput = {
  path: string;
  relative: string;
  repoPath: string;
  changeStatus: GitChangeStatus;
  commitSha?: string;
  baseRev?: string | null;
  /** Previous path for a renamed/copied file (left side at `baseRev`). */
  oldRelative?: string | null;
  /** Short SHA shown in the diff header. */
  commitLabel?: string;
};
