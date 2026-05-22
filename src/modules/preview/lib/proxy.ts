import { convertFileSrc } from "@tauri-apps/api/core";

const SCHEME = "tedi-frame";

export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
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

/**
 * Resolves the iframe src. Local dev servers go direct (avoids latency and
 * preserves websockets); remote URLs go through the strip-XFO proxy unless
 * `bypassProxy` is set.
 */
export function resolveIframeSrc(url: string, options: { bypassProxy?: boolean } = {}): string {
  if (!url) return url;
  if (options.bypassProxy) return url;
  if (isLocalUrl(url)) return url;
  return buildProxyUrl(url);
}
