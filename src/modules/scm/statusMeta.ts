import type { GitChangeStatus } from "./types";

export const STATUS_LETTER: Record<GitChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
  ignored: "I",
};

export const STATUS_TONE: Record<GitChangeStatus, string> = {
  modified: "text-icon-working",
  added: "text-diff-added",
  deleted: "text-diff-removed",
  renamed: "text-info",
  copied: "text-info",
  untracked: "text-diff-added",
  conflicted: "text-destructive",
  ignored: "text-muted-foreground",
};
