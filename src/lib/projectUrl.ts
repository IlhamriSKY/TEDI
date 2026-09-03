/**
 * The url a project declares for itself, read out of its own config.
 *
 * The open-in-browser pill rides on terminal output, so a server started
 * outside TEDI (Laragon's Apache, a container) never fires it. Reading the
 * config beats scanning ports: a scan cannot tell which listening port belongs
 * to THIS project and would offer a database or a sibling checkout on 3000.
 *
 * No Tauri/window imports (the caller owns the IO) so project-url-verify can
 * run it under node.
 */

/** Config files consulted, in priority order. The first that yields a url wins. */
export const PROJECT_URL_FILES = [
  ".env",
  "vite.config.ts",
  "vite.config.js",
  "package.json",
] as const;

/** Cap the regex scan; a generated 10 MB `.env` should not cost a `cd`. */
const MAX_CONFIG_BYTES = 64_000;

/** Hosts that mean "this machine" and can be reached over loopback. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Reserved by RFC 6761, so a name under them can only resolve to this machine. */
const LOCAL_SUFFIXES = [".test", ".localhost"];

/** Hostnames this machine's hosts file maps to loopback, lowercased. */
export type LocalHosts = ReadonlySet<string>;

/** Known limit: first megabyte only - an ad-block hosts file can be tens of MB. */
const MAX_HOSTS_BYTES = 1_000_000;

/**
 * Hostnames `text` (an `/etc/hosts` file) maps to loopback.
 *
 * This is what makes a vhost on a REGISTRABLE domain work. Laragon's default
 * TLD is `.dev` - a real public TLD - so `myapp.dev` and `attacker.dev` are
 * indistinguishable by suffix; only the hosts file separates them, and it is
 * local config the user controls rather than something that came with a repo.
 *
 * `0.0.0.0` is skipped: that is how ad-block lists null-route, and it is not
 * reachable anyway.
 */
export function parseHostsFile(text: string): Set<string> {
  const out = new Set<string>();
  const body = text.length > MAX_HOSTS_BYTES ? text.slice(0, MAX_HOSTS_BYTES) : text;
  for (const rawLine of body.split(/\r?\n/)) {
    // Windows ships `# 127.0.0.1 localhost` commented out, so this matters.
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const parts = line.split(/[ \t]+/);
    const ip = parts[0].toLowerCase();
    if (!/^127\./.test(ip) && ip !== "::1") continue;
    for (const name of parts.slice(1)) {
      if (name) out.add(name.toLowerCase());
    }
  }
  return out;
}

/**
 * `raw` normalised, or null if it does not name a server on this machine.
 *
 * THE security boundary: a config file arrives with a cloned repo, so without
 * this a repo's `.env` could aim TEDI's browser anywhere - unattended, with
 * auto-open on. A host passes only by being loopback by definition or by this
 * machine's hosts file, never on the config's say-so.
 */
export function safeLocalUrl(raw: string, localHosts?: LocalHosts): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const isLocal =
    LOOPBACK_HOSTS.has(host) ||
    LOCAL_SUFFIXES.some((s) => host.endsWith(s)) ||
    localHosts?.has(host) === true;
  if (!isLocal) return null;
  // Credentials would be sent to whatever answers, then sit in the address bar.
  u.username = "";
  u.password = "";
  // The browser cannot navigate to the wildcard bind; loopback reaches it.
  if (host === "0.0.0.0") u.hostname = "127.0.0.1";
  return u.toString();
}

/** A port number, or null when it is out of range / unparseable. */
function toPort(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** Value side of a dotenv line: unquotes, and cuts a trailing `# comment`. */
function unquote(raw: string): string {
  const v = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(v);
  if (quoted) return quoted[2];
  return v.split(/[\s#]/)[0];
}

/** `APP_URL` - the Laravel convention, and what a Laragon vhost writes. */
export function urlFromEnv(text: string): string | null {
  const m = /^[ \t]*(?:export[ \t]+)?APP_URL[ \t]*=(.*)$/m.exec(text);
  if (!m) return null;
  const value = unquote(m[1]);
  return value ? value : null;
}

/**
 * Known limit: first `port:` in the file, not a real parse - that would mean
 * evaluating TS in the webview. A hoisted `preview` block yields the wrong
 * port; anchor to `server\s*:\s*{` if that ever shows up.
 */
export function portFromViteConfig(text: string): number | null {
  const m = /\bport\s*:\s*(\d{1,5})\b/.exec(text);
  return m ? toPort(m[1]) : null;
}

/**
 * A port pinned in the dev script (`--port`, `-p`, `PORT=`). A script that
 * pins none is left alone: a framework default is not a promise that anything
 * is listening.
 */
export function portFromPackageJson(text: string): number | null {
  let scripts: Record<string, unknown> | undefined;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
  } catch {
    return null;
  }
  if (!scripts || typeof scripts !== "object") return null;
  for (const name of ["dev", "start", "serve"]) {
    const script = scripts[name];
    if (typeof script !== "string") continue;
    const m = /(?:--port[= ]|(?:^|\s)-p[= ]|\bPORT=)(\d{1,5})\b/.exec(script);
    const port = m ? toPort(m[1]) : null;
    if (port !== null) return port;
  }
  return null;
}

/**
 * The url `filename` declares, or null. Everything returns through
 * `safeLocalUrl` so one place decides what the pill may point at.
 */
export function urlFromConfig(
  filename: string,
  text: string,
  localHosts?: LocalHosts,
): string | null {
  const t = text.length > MAX_CONFIG_BYTES ? text.slice(0, MAX_CONFIG_BYTES) : text;
  const name = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  if (name === ".env") {
    const raw = urlFromEnv(t);
    return raw ? safeLocalUrl(raw, localHosts) : null;
  }
  const port =
    name === "package.json"
      ? portFromPackageJson(t)
      : name.startsWith("vite.config.")
        ? portFromViteConfig(t)
        : null;
  return port === null ? null : safeLocalUrl(`http://localhost:${port}`);
}
