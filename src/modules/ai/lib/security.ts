/**
 * Path-safety guards for AI tool calls.
 *
 * Blocks reads of common secret files (.env*, *.pem, id_rsa*, .aws/credentials,
 * .ssh/, .git/, kube/azure config) and writes/exec into the same set plus a
 * few high-risk directories.
 *
 * A defense layer, not a sandbox. The user-confirmation UI is the primary
 * safety net; these checks stop read tools (which auto-approve) from
 * silently exfiltrating obvious secrets.
 */

import { basename, toForwardSlash } from "@/lib/path";

const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /^.*\.pem$/i,
  /^.*\.key$/i, // private keys
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
  /^htpasswd$/i,
  /^\.netrc$/i,
  /^credentials$/i, // .aws/credentials, gcloud
  /^\.pgpass$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];

const SECRET_PATH_SEGMENTS = [
  "/.ssh/",
  "/.gnupg/",
  "/.aws/",
  "/.azure/",
  "/.kube/",
  "/.docker/",
  "/.config/gh/",
  "/.config/git/",
  "/.git/", // refuse to avoid mutating refs/objects
];

// Compared case-insensitively (see checkWritable), so all entries are lowercase.
// Includes Windows system/program roots since the host may be win32 - the POSIX
// list alone left C:\Windows etc. unguarded for writes.
const FORBIDDEN_PREFIXES = [
  "/etc/",
  "/var/db/",
  "/system/",
  "/library/keychains/",
  "/private/etc/",
  "/private/var/db/",
  "c:/windows/",
  "c:/program files",
  "c:/programdata/",
];

export type SafetyResult = { ok: true } | { ok: false; reason: string };

export function checkReadable(path: string): SafetyResult {
  const norm = toForwardSlash(path);
  const base = basename(norm);

  for (const re of SECRET_BASENAME_PATTERNS) {
    if (re.test(base)) {
      return {
        ok: false,
        reason: `Refused: "${base}" matches a sensitive-file pattern.`,
      };
    }
  }

  for (const seg of SECRET_PATH_SEGMENTS) {
    if (norm.includes(seg)) {
      return {
        ok: false,
        reason: `Refused: path is inside a protected directory (${seg.replace(/\//g, "")}).`,
      };
    }
  }

  return { ok: true };
}

export function checkWritable(path: string): SafetyResult {
  // Writes inherit read restrictions plus system-directory blocks.
  const r = checkReadable(path);
  if (!r.ok) return r;

  const lower = toForwardSlash(path).toLowerCase();
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return {
        ok: false,
        reason: `Refused: writes under "${prefix}" are not allowed.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Extra guard for recursive destructive ops (delete, move-source). On top of
 * the write restrictions, it refuses the catastrophic targets a single bad path
 * could wipe: the filesystem root, a Windows drive root, or a bare top-level
 * directory (e.g. "/home", "C:/Users"). `delete_file` recurses, so a slip here
 * is unrecoverable - this is the path-only equivalent of the `rm -rf /` block in
 * `checkShellCommand`. Workspace/cwd-ancestor protection is layered on top by
 * the tool via `isScopeRootOrAncestor`.
 */
export function checkDeletable(path: string): SafetyResult {
  const w = checkWritable(path);
  if (!w.ok) return w;
  const norm = toForwardSlash(path).replace(/\/+$/, "");
  // Empty, POSIX root, or a drive root like "C:" / "C:/".
  if (norm === "" || norm === "/" || /^[a-zA-Z]:$/.test(norm)) {
    return { ok: false, reason: "Refused: cannot delete a filesystem or drive root." };
  }
  // A single segment under the root ("/home", "/Users", "C:/Users", "/opt").
  // Recursively deleting one of these is almost always a catastrophic mistake;
  // real project work lives deeper. Manual deletion is still available to the user.
  const underRoot = norm.replace(/^[a-zA-Z]:/, "").replace(/^\/+/, "");
  if (underRoot !== "" && !underRoot.includes("/")) {
    return {
      ok: false,
      reason: `Refused: "${norm}" is a top-level directory; recursive delete of it is blocked.`,
    };
  }
  return { ok: true };
}

/**
 * Heuristic block for destructive shell commands even after user approval.
 * The approval UI is the primary gate; this catches obvious model mistakes.
 */
export function checkShellCommand(cmd: string): SafetyResult {
  const c = cmd.trim();
  // rm with recursive AND force flags (any order, combined `-rf` or split
  // `-r -f`) targeting a filesystem-root or home path (`/`, `/*`, `~`, `$HOME`).
  // A relative path or a home subdir (`~/proj/build`, `./build`, `node_modules`)
  // is legitimate and deliberately NOT matched.
  if (/\brm\b/.test(c)) {
    const flagChars = (c.match(/(?:^|\s)-[A-Za-z]+/g) ?? []).join("");
    const recursive = /[rR]/.test(flagChars) || /--recursive\b/.test(c);
    const force = /f/.test(flagChars) || /--force\b/.test(c);
    const rootTarget = /(?:^|\s)(['"]?)(\/|\/\*|~|\$\{?HOME\}?)\1(?:\s|;|&|\||$)/.test(c);
    if (recursive && force && rootTarget) {
      return {
        ok: false,
        reason: "Refused: recursive force-delete of a filesystem-root or home path.",
      };
    }
  }
  if (/--no-preserve-root/.test(c)) {
    return { ok: false, reason: "Refused: --no-preserve-root is not allowed." };
  }
  // dd to a raw disk device
  if (/\bdd\b[^|]*\bof=\/dev\/(disk|sd|nvme|hd)/i.test(c)) {
    return { ok: false, reason: "Refused: dd to a block device is not allowed." };
  }
  // mkfs / fdisk / diskutil eraseDisk
  if (/\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/.test(c) || /\bdiskutil\s+erase/i.test(c)) {
    return { ok: false, reason: "Refused: disk-formatting commands are not allowed." };
  }
  // find ... -delete rooted at the filesystem root
  if (/\bfind\s+\/(?:\s|$)/.test(c) && /\s-delete\b/.test(c)) {
    return { ok: false, reason: "Refused: find -delete at the filesystem root." };
  }
  // overwrite / wipe a raw block device
  if (/>\s*\/dev\/(?:sd|nvme|hd|disk)/i.test(c) || /\b(?:wipefs|shred)\b[^|]*\/dev\//i.test(c)) {
    return { ok: false, reason: "Refused: writing to a raw block device is not allowed." };
  }
  return { ok: true };
}
