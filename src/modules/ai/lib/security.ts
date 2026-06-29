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
import { invoke } from "@tauri-apps/api/core";

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
  /^credentials$/i, // .aws/credentials
  /^application_default_credentials\.json$/i, // gcloud ADC
  /^credentials\.db$/i, // gcloud
  /^\.git-credentials$/i, // plaintext https tokens in $HOME
  /^\.pgpass$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^_netrc$/i, // Windows .netrc
  /^.*\.ovpn$/i, // OpenVPN config with inline private keys
  /^\.\w+_history$/i, // .bash_history / .zsh_history / .psql_history / ...
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
  "/.config/gcloud/",
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

  // Case-insensitive: the OS filesystem is case-insensitive on Windows/macOS,
  // so `~/.SSH/id` or `/.AWS/` must not slip past the lowercase segment list.
  const normLower = norm.toLowerCase();
  for (const seg of SECRET_PATH_SEGMENTS) {
    // seg carries a trailing slash; also match the directory node itself
    // (e.g. ".../.ssh" with no trailing slash, what list_directory resolves to),
    // else its filenames could be enumerated.
    if (normLower.includes(seg) || normLower.endsWith(seg.slice(0, -1))) {
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

// ─── Symlink-resolved guards ───────────────────────────────────────────

/**
 * Run the secret deny-list against the symlink-resolved real target, not the
 * literal path string. A string-only check is blind to an innocuously-named
 * symlink (notes.txt -> ~/.ssh/id_rsa); the backend follows symlinks on read,
 * so without this an auto-approved read could exfiltrate the target. Falls
 * back to the literal path if canonicalization fails (e.g. the path does not
 * exist yet) - the read itself surfaces any real error.
 */
/**
 * Canonicalize the nearest EXISTING ancestor of a not-yet-created path, then
 * re-append the unresolved tail. fs_canonicalize requires the full path to
 * exist, so for a brand-new file it throws and only the literal string would be
 * checked — letting a symlinked parent (workspace/link -> /etc) redirect the
 * write outside scope. Returns null if no ancestor resolves.
 */
async function resolveExistingAncestor(abs: string): Promise<string | null> {
  const parts = toForwardSlash(abs).replace(/\/+$/, "").split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/");
    if (!ancestor) continue;
    try {
      const real = await invoke<string>("fs_canonicalize", { path: ancestor });
      if (real) {
        const tail = parts.slice(i).join("/");
        return `${toForwardSlash(real).replace(/\/+$/, "")}/${tail}`;
      }
    } catch {
      // keep walking up to the next existing ancestor
    }
  }
  return null;
}

export async function checkReadableResolved(
  abs: string,
): Promise<ReturnType<typeof checkReadable>> {
  const literal = checkReadable(abs);
  if (!literal.ok) return literal;
  try {
    const real = await invoke<string>("fs_canonicalize", { path: abs });
    if (real && real !== abs) return checkReadable(real);
  } catch {
    // Path missing / not resolvable: literal check already passed.
  }
  return literal;
}

/**
 * Write-side counterpart of checkReadableResolved: resolve symlinks before the
 * secret + system-dir check so an innocuously-named symlink can't redirect a
 * write into a protected target (e.g. notes.txt -> /etc/hosts, or a link into
 * C:\Windows). Falls back to the literal check when the path doesn't exist yet
 * (the common brand-new-file case).
 */
export async function checkWritableResolved(
  abs: string,
): Promise<ReturnType<typeof checkWritable>> {
  const literal = checkWritable(abs);
  if (!literal.ok) return literal;
  try {
    const real = await invoke<string>("fs_canonicalize", { path: abs });
    if (real && real !== abs) return checkWritable(real);
  } catch {
    // Brand-new path: the leaf doesn't exist yet so canonicalize throws. Resolve
    // the nearest existing ancestor so a symlinked parent can't land the write
    // outside scope (e.g. workspace/link -> /etc, then link/newfile -> /etc/newfile).
    const resolved = await resolveExistingAncestor(abs);
    if (resolved && resolved !== abs) return checkWritable(resolved);
  }
  return literal;
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
    // Token (/, ~, $HOME) optionally followed by /, *, or . — so `~/`, `~/*`,
    // `$HOME/`, `/*`, `/.` are all caught — then a terminator. A home SUBDIR
    // (`~/proj/build`) has a non-terminator after the token, so it stays allowed.
    const rootTarget =
      /(?:^|\s)['"]?(?:\/|~|\$\{?HOME\}?)(?:\/|\*|\.)*['"]?(?:\s|;|&|\||$)/.test(c);
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
