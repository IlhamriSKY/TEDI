import { invoke, Channel } from "@tauri-apps/api/core";

// SFTP IPC wrappers. Each call uses the russh-sftp client on the SSH session
// returned by `ssh_open`. Permission errors come straight from the remote
// kernel and are passed through to the explorer.

export type SftpDirEntry = {
  name: string;
  /** For a symlink this is what the link RESOLVES to, so a linked directory
   *  still expands in the tree. `symlink` says whether it is a link. */
  kind: "file" | "dir" | "symlink";
  size: number;
  /** Unix seconds. Zero if the server did not report mtime. */
  mtime: number;
  /** Like `"drwxr-xr-x"` (`ls -l` form), or empty if not reported. */
  permissions: string;
  symlink: boolean;
};

/** Full metadata for one remote path, behind the Properties dialog. */
export type SftpStat = {
  kind: "file" | "dir" | "symlink";
  /** What a symlink resolves to, or `"broken"` when it points at nothing. */
  targetKind: "file" | "dir" | "symlink" | "broken";
  size: number;
  mtime: number;
  /** Permission plus setuid/setgid/sticky bits. Null when the server reported
   *  no mode, which is what disables the permission editor. */
  mode: number | null;
  uid: number | null;
  gid: number | null;
  user: string | null;
  group: string | null;
  linkTarget: string | null;
};

/** How far a chmod reaches. The files/dirs split is what stops a recursive
 *  `644` from stripping `x` off every directory in the tree. */
export type ChmodScope = "none" | "all" | "files" | "dirs";

export type ChmodSummary = { changed: number; failed: number };

/** Byte progress for a multi-file transfer. `written`/`total` track the file
 *  named by `name`; `bytesDone`/`bytesTotal` track the whole job. */
export type TransferProgress = {
  index: number;
  count: number;
  name: string;
  written: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
};

/** Per-file outcome of a transfer. Failures never abort the rest. */
export type TransferSummary = { ok: number; failed: string[] };

/** Basename of a local OS path, tolerating both `/` and `\\` separators so a
 *  Windows drop path (`C:\\Users\\me\\file.txt`) resolves correctly. */
export function localBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Join a remote POSIX directory and a name. Remote paths use `/` whatever
 *  the local OS does. */
export function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Parent of a remote POSIX path; `/` for anything at the root. */
export function remoteDirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
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

export function sftpStat(sessionId: number, path: string): Promise<SftpStat> {
  return invoke<SftpStat>("ssh_sftp_stat", { id: sessionId, path });
}

export function sftpChmod(
  sessionId: number,
  path: string,
  mode: number,
  recurse: ChmodScope = "none",
): Promise<ChmodSummary> {
  return invoke<ChmodSummary>("ssh_sftp_chmod", { id: sessionId, path, mode, recurse });
}

/** Whether a remote path exists, links not followed. Used to catch a name
 *  collision before an upload or a move overwrites something. */
export function sftpExists(sessionId: number, path: string): Promise<boolean> {
  return invoke<boolean>("ssh_sftp_exists", { id: sessionId, path });
}

function progressChannel(onProgress?: (p: TransferProgress) => void) {
  const channel = new Channel<TransferProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return channel;
}

/** Upload local files and/or folders into a remote directory. Bytes stream on
 *  the Rust side, so binary files transfer intact and a huge file never lands
 *  in memory whole. Folders are walked and recreated remotely. Write
 *  permission is enforced by the remote. */
export function sftpUpload(
  sessionId: number,
  localPaths: string[],
  remoteDir: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<TransferSummary> {
  return invoke<TransferSummary>("ssh_sftp_upload", {
    id: sessionId,
    localPaths,
    remoteDir,
    onProgress: progressChannel(onProgress),
  });
}

/** Download remote files and/or folders into a local directory. Mirror image
 *  of `sftpUpload`, down to the per-file failure list. */
export function sftpDownload(
  sessionId: number,
  remotePaths: string[],
  localDir: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<TransferSummary> {
  return invoke<TransferSummary>("ssh_sftp_download", {
    id: sessionId,
    remotePaths,
    localDir,
    onProgress: progressChannel(onProgress),
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
