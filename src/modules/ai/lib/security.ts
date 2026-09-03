/**
 * Path-safety guards for AI tool calls.
 *
 * Blocks reads of common secret files (.env*, *.pem, id_rsa*, .aws/credentials,
 * .ssh/, .git/, kube/azure config) and writes into the same set plus a few
 * high-risk directories.
 *
 * A layer, not a sandbox: the approval UI is the primary net, and these stop the
 * AUTO-approving read tools from silently exfiltrating an obvious secret.
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
 * Extra guard for recursive destructive ops (delete, move-source): refuses the
 * targets one bad path could wipe - filesystem root, drive root, or a bare
 * top-level dir ("/home", "C:/Users"). `delete_file` recurses, so a slip is
 * unrecoverable; this is the path-only twin of the `rm -rf /` block in
 * `checkShellCommand`. Scope-ancestor protection is layered on by the tool.
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

// ─── Network egress ────────────────────────────────────────────────────

/**
 * First-contact approval for outbound HTTP.
 *
 * The read side is carefully gated - an out-of-scope read asks, secrets are
 * denied, symlinks are resolved - but every one of those guards is about what
 * gets IN. `fetch`, `open_browser` and `navigate_and_read` were the way OUT, and
 * they auto-executed against any host with a model-chosen URL. That is the whole
 * prompt-injection exfiltration path: anything the agent reads (a repo file, a
 * fetched page, an MCP tool's description) can tell it to append the context to
 * a URL, and nothing asked.
 *
 * So: a host the user has not approved this session needs an approval card;
 * after they approve once, that host is quiet for the rest of the session. The
 * tools record the host from inside `execute`, which only runs once approval has
 * been granted - no extra plumbing, and nothing is remembered across a restart.
 *
 * Loopback is pre-trusted: a dev server is the single most common target and
 * cannot leave the machine.
 */
const trustedEgressHosts = new Set<string>();

/** Hostname of a URL, lowercased and de-bracketed, or null if unparseable. */
export function egressHost(rawUrl: string): string | null {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h || null;
  } catch {
    return null;
  }
}

/** Loopback, or a dev TLD that only ever resolves to it. Never leaves the box. */
function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /\.(test|localhost)$/.test(host)
  );
}

/** True when this URL may be requested without an approval card. */
export function isTrustedEgressHost(rawUrl: string): boolean {
  const host = egressHost(rawUrl);
  // Unparseable: let the tool's own validation produce the real error rather
  // than raising an approval card for a URL that will be refused anyway.
  if (!host) return true;
  return isLoopbackHost(host) || trustedEgressHosts.has(host);
}

/** Remember an approved host for the rest of the session. Call from `execute`,
 *  which the SDK runs only after the approval resolved. */
export function trustEgressHost(rawUrl: string): void {
  const host = egressHost(rawUrl);
  if (host && !isLoopbackHost(host)) trustedEgressHosts.add(host);
}

/** Test seam: drop every remembered host. */
export function resetTrustedEgressHosts(): void {
  trustedEgressHosts.clear();
}

// ─── Symlink-resolved guards ───────────────────────────────────────────

/**
 * Canonicalize the nearest EXISTING ancestor of a not-yet-created path, then
 * re-append the unresolved tail. `fs_canonicalize` needs the whole path to
 * exist, so a brand-new file would fall back to the literal string and let a
 * symlinked parent (workspace/link -> /etc) redirect the write out of scope.
 * Null if no ancestor resolves.
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

/**
 * Deny-list the symlink-RESOLVED target, not the path string. A string check is
 * blind to an innocent-looking link (notes.txt -> ~/.ssh/id_rsa) and the backend
 * follows symlinks, so an auto-approved read could otherwise exfiltrate it.
 * Falls back to the literal path when canonicalization fails.
 */
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
 * Write-side twin of checkReadableResolved: resolve symlinks first so an
 * innocent-looking link cannot redirect a write into a protected target
 * (notes.txt -> /etc/hosts). Falls back to the literal check for a path that
 * does not exist yet, the common new-file case.
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
 * Path-looking tokens in a shell command, for the unattended checks below.
 *
 * Heuristic by nature - a shell string is not parseable without a shell. Splits
 * on whitespace and the usual separators, strips quotes and a leading `VAR=`,
 * and keeps anything path-shaped OR whose basename matches a secret pattern, so
 * a bare `.env` is caught and not just `./.env`.
 */
function extractPathTokens(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/[\s;|&<>()]+/)) {
    if (!raw) continue;
    // Strip quotes, a leading `VAR=` assignment, and `--flag=` prefixes.
    let t = raw.replace(/^['"]|['"]$/g, "");
    const eq = t.indexOf("=");
    if (eq > 0 && !t.slice(0, eq).includes("/")) t = t.slice(eq + 1);
    t = t.replace(/^['"]|['"]$/g, "");
    if (!t) continue;
    const looksLikePath =
      /^[~/]/.test(t) ||
      /^\.{1,2}\//.test(t) ||
      /^[A-Za-z]:[\\/]/.test(t) ||
      /\$\{?HOME\}?/.test(t) ||
      t.includes("/") ||
      t.includes("\\");
    if (looksLikePath || SECRET_BASENAME_PATTERNS.some((re) => re.test(basename(t)))) {
      out.push(t);
    }
  }
  return out;
}

/**
 * Heuristic block for destructive shell commands even after approval. The
 * approval UI is the primary gate; this catches obvious model mistakes.
 *
 * `unattended` adds the checks that matter with NO approver: a worker sub-agent
 * auto-approves `bash_run`, which was the one hole in the scope model fs/edit
 * enforce. It refuses secret paths and absolute paths outside the workspace.
 *
 * A layer, not a sandbox - obfuscation (indirection, base64, a helper script)
 * gets through. It raises the bar against a prompt-injected worker.
 */
export function checkShellCommand(
  cmd: string,
  opts: { unattended?: boolean; isOutsideScope?: (path: string) => boolean } = {},
): SafetyResult {
  const c = cmd.trim();

  if (opts.unattended) {
    for (const token of extractPathTokens(c)) {
      const readable = checkReadable(token);
      if (!readable.ok) {
        return {
          ok: false,
          reason: `${readable.reason} (in shell command, and this sub-agent runs without an approval prompt)`,
        };
      }
      if (opts.isOutsideScope?.(token)) {
        return {
          ok: false,
          reason: `Refused: "${token}" is outside the workspace, and this sub-agent runs without an approval prompt.`,
        };
      }
    }
  }

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
    const rootTarget = /(?:^|\s)['"]?(?:\/|~|\$\{?HOME\}?)(?:\/|\*|\.)*['"]?(?:\s|;|&|\||$)/.test(
      c,
    );
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
