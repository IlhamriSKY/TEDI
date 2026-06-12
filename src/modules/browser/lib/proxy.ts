import { convertFileSrc } from "@tauri-apps/api/core";

const SCHEME = "tedi-frame";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

export const SELF_REFERENCE_NOTICE =
  "Refusing to load TEDI inside its own preview (would recurse and leak memory).";

/**
 * True if `url` would load TEDI itself inside the iframe. Catches:
 *   - exact origin match against the running webview (covers dev
 *     `http://localhost:1420` and prod `http(s)://tauri.localhost`,
 *     `tauri://localhost`),
 *   - the `tedi-frame:` proxy scheme in either form (`tedi-frame://...`
 *     and Windows' `http://tedi-frame.localhost/...`),
 *   - any loopback alias that resolves to the same port as the webview
 *     (`127.0.0.1:1420`, `[::1]:1420`, …) - those bypass string-equality
 *     against `location.origin` but still hit the same server.
 */
export function isSelfReferenceUrl(url: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === SCHEME) return true;
  if (u.hostname === `${SCHEME}.localhost` || u.hostname.endsWith(`.${SCHEME}.localhost`)) {
    return true;
  }
  if (typeof window !== "undefined") {
    const here = window.location;
    if (u.origin === here.origin) return true;
    if (
      LOOPBACK_HOSTNAMES.has(u.hostname.toLowerCase()) &&
      LOOPBACK_HOSTNAMES.has(here.hostname.toLowerCase()) &&
      u.port === here.port &&
      u.port !== ""
    ) {
      return true;
    }
  }
  return false;
}

function base64UrlEncode(input: string): string {
  // btoa needs latin1; encodeURIComponent + unescape round-trips multi-byte chars.
  const b64 = btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Build the proxy URL for the iframe. `convertFileSrc` URL-encodes its
 * argument as a path component, so we pass "" to get the platform origin
 * and append the query manually.
 */
export function buildProxyUrl(targetUrl: string): string {
  const origin = convertFileSrc("", SCHEME);
  return `${origin}?u=${base64UrlEncode(targetUrl)}`;
}
