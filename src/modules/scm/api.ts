import { invoke } from "@tauri-apps/api/core";
import type { CommitDetail, GitCommit, GitStatus } from "./types";
import type { FsReadResult } from "@/lib/ipc";

/** Mirrors Rust `fs::file::ReadResult` (git_file_head / git_file_at reuse it). */
export type FileReadResult = FsReadResult;

export function gitStatus(repoPath: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { repoPath });
}

/** `git status` for the repo an SSH terminal is sitting in, run over that
 *  session. Read-only: `added`/`removed`/`binary` are always 0/false because
 *  the line-count enrichment reads the local disk. `cwd` may be empty, which
 *  runs in the remote login directory. */
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

export function gitDiscardFile(repoPath: string, relative: string): Promise<void> {
  return invoke<void>("git_discard_file", { repoPath, relative });
}

export function gitDiscardAll(repoPath: string): Promise<void> {
  return invoke<void>("git_discard_all", { repoPath });
}

export function gitCommit(repoPath: string, message: string): Promise<void> {
  return invoke<void>("git_commit", { repoPath, message });
}

export function gitPush(repoPath: string): Promise<string> {
  return invoke<string>("git_push", { repoPath });
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
