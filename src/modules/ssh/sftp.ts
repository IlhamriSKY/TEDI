import { invoke, Channel } from "@tauri-apps/api/core";

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

/** Basename of a local OS path, tolerating both `/` and `\\` separators so a
 *  Windows drop path (`C:\\Users\\me\\file.txt`) resolves correctly. */
export function localBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

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

export function sftpReadFile(sessionId: number, path: string): Promise<string> {
  return invoke<string>("ssh_sftp_read_file", { id: sessionId, path });
}

export function sftpWriteFile(sessionId: number, path: string, contents: string): Promise<void> {
  return invoke("ssh_sftp_write_file", { id: sessionId, path, contents });
}

/** Byte progress for one file's upload; `written === total` means done. */
export type UploadProgress = { written: number; total: number };

/** Upload a local file (by absolute path) to a remote path over SFTP. Bytes are
 *  read on the Rust side so binary files upload intact (never round-tripped as a
 *  JS string). Folders are rejected; write permission is enforced by the remote.
 *  `onProgress` fires per chunk so callers can show a percentage. */
export function sftpUpload(
  sessionId: number,
  localPath: string,
  remotePath: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<void> {
  const onProgressChannel = new Channel<UploadProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke("ssh_sftp_upload", {
    id: sessionId,
    localPath,
    remotePath,
    onProgress: onProgressChannel,
  });
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
