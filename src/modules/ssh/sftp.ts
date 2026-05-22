import { invoke } from "@tauri-apps/api/core";

// SFTP IPC wrappers. Each call uses the russh-sftp client on the SSH session
// returned by `ssh_open`. Permission errors come straight from the remote
// kernel and are passed through to the explorer.

export type SftpDirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  /** Unix seconds. Zero if the server did not report mtime. */
  mtime: number;
  /** Like `"rwxr-xr-x"`, or empty if not reported. */
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
