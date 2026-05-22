export type GitChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "ignored";

export type GitChange = {
  path: string;
  relative: string;
  status: GitChangeStatus;
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
