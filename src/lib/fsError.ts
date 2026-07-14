export type FsErrorKind = "denied" | "missing" | "other";

export type FriendlyFsError = {
  /** Coarse class the UI can theme: a lock for `denied`, muted for `missing`. */
  kind: FsErrorKind;
  /** Short, human-readable message. Equals `raw` for `other`. */
  message: string;
  /** Original error string, kept for a title/tooltip. */
  raw: string;
};

/**
 * Map a raw filesystem / SFTP error string to a short, friendly message plus a
 * kind the UI can theme. Covers the remote SFTP phrasings ("permission denied",
 * "no such file or directory") and the local OS strings across platforms:
 *   - Windows: "Access is denied. (os error 5)",
 *              "The system cannot find the path specified. (os error 3)"
 *   - Unix:    "Permission denied (os error 13)", "No such file ... (os error 2)"
 * so the same helper works whether the tree is local or remote.
 */
export function humanizeFsError(raw: string): FriendlyFsError {
  const s = (raw ?? "").toLowerCase();
  const errnoMatch = /os error (\d+)/.exec(s);
  const errno = errnoMatch ? Number(errnoMatch[1]) : null;

  const denied =
    s.includes("permission denied") ||
    s.includes("access is denied") ||
    s.includes("eacces") ||
    errno === 13 || // EACCES (unix)
    errno === 5; // ERROR_ACCESS_DENIED (windows)
  if (denied) {
    return { kind: "denied", message: "You don't have permission to open this folder.", raw };
  }

  const missing =
    s.includes("no such file") ||
    s.includes("cannot find the path") ||
    s.includes("cannot find the file") ||
    s.includes("enoent") ||
    errno === 2 || // ENOENT (unix)
    errno === 3; // ERROR_PATH_NOT_FOUND (windows)
  if (missing) {
    return { kind: "missing", message: "This folder no longer exists.", raw };
  }

  return { kind: "other", message: raw, raw };
}
