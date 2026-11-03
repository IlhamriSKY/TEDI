/**
 * The `sftp` tool: a connected SSH pane's files, for an agent. Resolving the pane
 * and its private flag happens in the capability; this only has a session.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  joinRemote,
  sftpCreateDir,
  sftpCreateFile,
  sftpDelete,
  sftpDownload,
  sftpExists,
  sftpHome,
  sftpReadDir,
  sftpReadFile,
  sftpRename,
  sftpStat,
  sftpUpload,
  sftpWriteFile,
} from "./sftp";

export type SftpArgs = {
  action?: string;
  remote?: string;
  to?: string;
  local?: string;
  content?: string;
  hidden?: boolean;
  maxChars?: number;
  confirm?: boolean;
};

/** Same cap as the other reads: a whole log in a tool result helps nobody. */
const DEFAULT_MAX_CHARS = 20000;
/** A folder like `/usr/lib` runs to thousands of rows. */
const MAX_LIST_ROWS = 500;

function need(value: string | undefined, what: string, action: string): string {
  if (!value) throw new Error(`sftp ${action} needs \`${what}\`.`);
  return value;
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const localExists = (path: string): Promise<boolean> =>
  invoke("fs_canonicalize", { path }).then(
    () => true,
    () => false,
  );

export async function runSftp(id: number, a: SftpArgs): Promise<unknown> {
  const action = String(a.action);
  const remote = () => need(a.remote, "remote", action);
  /** Replacing something is the one mistake here that cannot be undone. */
  const refuseOverwrite = (exists: boolean, path: string) => {
    if (exists && a.confirm !== true) {
      throw new Error(`${path} already exists. Pass \`confirm: true\` to replace it.`);
    }
  };
  switch (action) {
    case "home":
      return await sftpHome(id);
    case "list": {
      const rows = await sftpReadDir(id, a.remote || (await sftpHome(id)), a.hidden === true);
      return { total: rows.length, entries: rows.slice(0, MAX_LIST_ROWS) };
    }
    case "read": {
      const text = await sftpReadFile(id, remote());
      const cap = a.maxChars && a.maxChars > 0 ? a.maxChars : DEFAULT_MAX_CHARS;
      return text.length > cap ? `${text.slice(0, cap)}\n\n[truncated at ${cap} chars]` : text;
    }
    case "write":
      if (typeof a.content !== "string") throw new Error("sftp write needs `content`.");
      refuseOverwrite(await sftpExists(id, remote()), remote());
      await sftpWriteFile(id, remote(), a.content);
      return `wrote ${a.remote}`;
    case "stat":
      return await sftpStat(id, remote());
    case "touch":
      await sftpCreateFile(id, remote());
      return `created ${a.remote}`;
    case "mkdir":
      await sftpCreateDir(id, remote());
      return `created ${a.remote}`;
    case "rename": {
      const to = need(a.to, "to", action);
      refuseOverwrite(await sftpExists(id, to), to);
      await sftpRename(id, remote(), to);
      return `renamed ${a.remote} to ${to}`;
    }
    case "delete":
      if (a.confirm !== true) {
        throw new Error(`sftp delete needs \`confirm: true\` for ${remote()}.`);
      }
      await sftpDelete(id, remote());
      return `deleted ${a.remote}`;
    case "upload": {
      const local = need(a.local, "local", action);
      const target = joinRemote(remote(), baseName(local));
      refuseOverwrite(await sftpExists(id, target), target);
      return await sftpUpload(id, [local], remote());
    }
    case "download": {
      const local = need(a.local, "local", action);
      const target = `${local.replace(/[\\/]+$/, "")}/${baseName(remote())}`;
      refuseOverwrite(await localExists(target), target);
      return await sftpDownload(id, [remote()], local);
    }
    default:
      throw new Error(`Unknown action "${action}".`);
  }
}
