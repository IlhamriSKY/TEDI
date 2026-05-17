import { invoke } from "@tauri-apps/api/core";
import type { GitStatus } from "./types";

export function gitStatus(repoPath: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { repoPath });
}

export function gitFileHead(repoPath: string, relative: string): Promise<string> {
  return invoke<string>("git_file_head", { repoPath, relative });
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
