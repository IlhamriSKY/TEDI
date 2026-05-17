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
  // btoa needs latin1; encodeURIComponent → unescape round-trips multi-byte
  // chars safely. (`Uint8Array` + `Array.from` would also work but this keeps
  // the line short and avoids the buffer alloc.)
  const b64 = btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Build the proxy URL that the iframe should load. `convertFileSrc` URL-encodes
 * its argument as a path component, so passing `?u=…` would become `%3Fu%3D…`
 * and the Rust handler would never see a real query string. Call it with `""`
 * just to get the platform-correct origin, then append the query manually.
 */
export function buildProxyUrl(targetUrl: string): string {
  const origin = convertFileSrc("", SCHEME);
  return `${origin}?u=${base64UrlEncode(targetUrl)}`;
}

/**
 * Resolve the URL the iframe should actually load. Local dev servers go
 * direct (proxying would just add latency + lose websockets). Remote URLs go
 * through the strip-XFO proxy unless the caller explicitly opts out.
 */
export function resolveIframeSrc(url: string, options: { bypassProxy?: boolean } = {}): string {
  if (!url) return url;
  if (options.bypassProxy) return url;
  if (isLocalUrl(url)) return url;
  return buildProxyUrl(url);
}
