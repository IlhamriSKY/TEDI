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
  /** Lines added relative to HEAD. 0 when not applicable / binary. */
  added: number;
  /** Lines removed relative to HEAD. 0 when not applicable / binary. */
  removed: number;
  /** True when git reported this entry as binary (line counts not meaningful). */
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
