import { invoke } from "@tauri-apps/api/core";

/// SFTP IPC wrappers. Each call routes to the russh-sftp client riding on
/// the live SSH session identified by `sessionId` (the russh handle
/// returned by `ssh_open`). The remote SSH user owns the channel, so any
/// `permission denied` error here means the kernel rejected the syscall —
/// we surface it as-is to the explorer instead of papering over it.

export type SftpDirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  /** Unix seconds. Zero when the server didn't report mtime. */
  mtime: number;
  /** `"rwxr-xr-x"` or empty when permissions weren't reported. */
  permissions: string;
};

export type SftpStat = {
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  permissions: string;
};

export function sftpHome(sessionId: number): Promise<string> {
  return invoke<string>("ssh_sftp_home", { id: sessionId });
}

export function sftpReadDir(
  sessionId: number,
  path: string,
  includeHidden: boolean,
): Promise<SftpDirEntry[]> {
  return invoke<SftpDirEntry[]>("ssh_sftp_read_dir", {
    id: sessionId,
    path,
    includeHidden,
  });
}

export function sftpStat(sessionId: number, path: string): Promise<SftpStat> {
  return invoke<SftpStat>("ssh_sftp_stat", { id: sessionId, path });
}

export function sftpReadFile(sessionId: number, path: string): Promise<string> {
  return invoke<string>("ssh_sftp_read_file", { id: sessionId, path });
}

export function sftpWriteFile(sessionId: number, path: string, contents: string): Promise<void> {
  return invoke("ssh_sftp_write_file", { id: sessionId, path, contents });
}

export function sftpCreateFile(sessionId: number, path: string): Promise<void> {
  return invoke("ssh_sftp_create_file", { id: sessionId, path });
}

export function sftpCreateDir(sessionId: number, path: string): Promise<void> {
  return invoke("ssh_sftp_create_dir", { id: sessionId, path });
}

export function sftpRename(sessionId: number, from: string, to: string): Promise<void> {
  return invoke("ssh_sftp_rename", { id: sessionId, from, to });
}

export function sftpDelete(sessionId: number, path: string): Promise<void> {
  return invoke("ssh_sftp_delete", { id: sessionId, path });
}
