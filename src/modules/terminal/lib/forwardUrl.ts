/**
 * Url math for the SSH `-L` auto-forward: read the port a remote shell's
 * `http://localhost:PORT` announcement points at, and re-point that url at the
 * local end of the tunnel opened for it.
 *
 * Deliberately free of xterm/Tauri imports (unlike its caller and
 * `session-helpers`, both of which touch `window` at module scope) so
 * `scripts/ssh/ssh-forward-url-verify.ts` can exercise it under plain node.
 */

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The port `url` refers to ON THE REMOTE HOST, or null when it is not a
 * parseable http(s) url. A url with no port still names one: `http://localhost/`
 * is port 80 on the server, and tunnelling it to "no port" would be a no-op.
 */
export function remotePortOf(url: string): number | null {
  const u = parse(url);
  if (!u) return null;
  if (u.port !== "") {
    const port = Number(u.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  }
  if (u.protocol === "https:") return 443;
  if (u.protocol === "http:") return 80;
  return null;
}

/**
 * `url` with its authority swapped for the local end of the tunnel, keeping
 * path, query and fragment intact - those are the parts that make a dev
 * server's url worth clicking (`/#/route`, `?token=…`).
 */
export function toLocalUrl(url: string, boundPort: number): string | null {
  const u = parse(url);
  if (!u) return null;
  u.hostname = "127.0.0.1";
  u.port = String(boundPort);
  return u.toString();
}
