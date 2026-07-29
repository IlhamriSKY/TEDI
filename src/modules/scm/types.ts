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

export type GitStatus = {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
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
