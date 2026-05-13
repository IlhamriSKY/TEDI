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
};

export type GitStatus = {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  changes: GitChange[];
};
