import { invoke } from "@tauri-apps/api/core";
import type { GitStatus } from "./types";

export function gitStatus(repoPath: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { repoPath });
}

export function gitFileHead(
  repoPath: string,
  relative: string,
): Promise<string> {
  return invoke<string>("git_file_head", { repoPath, relative });
}

export function gitDiscardFile(
  repoPath: string,
  relative: string,
): Promise<void> {
  return invoke<void>("git_discard_file", { repoPath, relative });
}

export function gitDiscardAll(repoPath: string): Promise<void> {
  return invoke<void>("git_discard_all", { repoPath });
}
