import { defaultUrlTransform, type UrlTransform } from "streamdown";

/**
 * URL sanitizer for every Streamdown instance that renders untrusted text
 * (AI model output, reasoning, opened markdown files).
 *
 * Streamdown's internal harden config defaults `allowedImagePrefixes` /
 * `allowedLinkPrefixes` to `["*"]` (allow everything) and does not expose
 * them as props in this version, so a markdown image would fire a zero-click
 * outbound GET the moment it renders (a tracking beacon / data-exfil channel)
 * and links could use arbitrary schemes. There is no CSP `connect-src` /
 * `img-src` net behind it. We use react-markdown's `urlTransform` hook to:
 *   - block ALL remote image loads (rendering never triggers a network fetch), and
 *   - restrict link hrefs to http(s)/mailto (relative + anchor links pass).
 *
 * Note: in the installed Streamdown build `defaultUrlTransform` is the
 * identity function, so it strips nothing. The allowlist BELOW (not the
 * composed default) is what blocks dangerous schemes such as `javascript:`.
 * We still compose `defaultUrlTransform` first so any future Streamdown that
 * adds real default sanitization is inherited rather than bypassed.
 */
export const safeUrlTransform: UrlTransform = (url, key, node) => {
  const sanitized = defaultUrlTransform(url, key, node);
  if (!sanitized) return sanitized;
  const lower = sanitized.trim().toLowerCase();

  // Images / media (`src`): block any remote load so rendering never triggers
  // a network fetch. Inline `data:` URIs are allowed through (this Streamdown
  // build strips them upstream anyway, so it is a harmless no-op here).
  if (key === "src") {
    return lower.startsWith("data:") ? sanitized : "";
  }

  // Links (`href`) and other URLs. Decide whether the URL actually carries a
  // scheme the same way hast-util-sanitize / react-markdown do: a colon only
  // starts a scheme when it precedes the first '/', '?', or '#'. Relative,
  // anchor, and scheme-less URLs (including ones whose path/query/fragment
  // merely contains a colon, e.g. "/search?q=10:30" or "page#a:b") pass
  // through unchanged.
  const colon = lower.indexOf(":");
  if (colon === -1) return sanitized;
  const beforeColon = (i: number) => i !== -1 && i < colon;
  const schemeLess =
    beforeColon(lower.indexOf("/")) ||
    beforeColon(lower.indexOf("?")) ||
    beforeColon(lower.indexOf("#"));
  if (schemeLess) return sanitized;

  // A real scheme is present: allow only the safe ones, block the rest
  // (javascript:, vbscript:, file:, custom schemes, ...).
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return sanitized;
  }
  return "";
};
