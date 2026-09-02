import { tool } from "ai";
import { z } from "zod";
import { clampForModel } from "./context";
import { proxyOnlyFetch } from "../lib/httpProxy";
import { isTrustedEgressHost, trustEgressHost } from "../lib/security";

/** Block the cloud-metadata / link-local SSRF class on the native-first path
 *  (the Rust proxy fallback re-checks with DNS resolution). Mirrors net.rs's
 *  intent: private LAN stays allowed, only metadata/link-local is refused. */
function isBlockedFetchHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true; // unparseable -> refuse
  }
  if (host === "metadata.google.internal" || host === "metadata") return true;
  if (/^169\.254\./.test(host)) return true; // IPv4 link-local range
  if (host.startsWith("fe80:")) return true; // IPv6 link-local
  return false;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Generic HTTP fetch tool for data retrieval.
 *
 * Use cases:
 * - API calls (JSON endpoints, REST APIs)
 * - Fetching raw text/HTML from URLs
 * - Bulk data retrieval (exchange rates, weather, etc.)
 * - Downloading config files or data feeds
 *
 * NOT for:
 * - Interactive web pages (use browser tools instead)
 * - Pages requiring JavaScript rendering (use open_browser)
 * - Authentication flows (use browser tools)
 */
export function buildFetchTools() {
  return {
    fetch: tool({
      description:
        "Fetch a URL and return its content. For APIs, JSON endpoints, text files, or simple HTML. No JavaScript execution. Use for data retrieval when you don't need browser rendering. For interactive/JS-heavy pages, use open_browser instead. The first request to a given host raises an approval card; after the user allows it, that host is automatic for the rest of the session. localhost and .test dev servers never ask. POST always asks.",
      inputSchema: z.object({
        url: z.string().url().describe("Full http(s) URL to fetch."),
        method: z
          .enum(["GET", "POST"])
          .optional()
          .default("GET")
          .describe("HTTP method. Default GET."),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional request headers as key-value pairs."),
        body: z.string().optional().describe("Request body (for POST). Sent as-is."),
        format: z
          .enum(["text", "json", "auto"])
          .optional()
          .default("auto")
          .describe(
            "Response format. 'text' returns raw text, 'json' parses and returns structured data, 'auto' detects from Content-Type. Default auto.",
          ),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(500_000)
          .optional()
          .describe("Max characters to return. Default 100,000. Increase for large datasets."),
      }),
      // A GET is not safe just because it is a GET: the URL and headers are
      // model-chosen, so it is a write channel pointing off the machine. Ask on
      // first contact with a host, then stay quiet for it this session.
      needsApproval: (input: { method?: string; url?: string }) =>
        (input.method ?? "GET") !== "GET" ||
        !isTrustedEgressHost(typeof input.url === "string" ? input.url : ""),
      execute: async ({ url, method, headers, body, format, max_chars }) => {
        const effectiveMethod = method ?? "GET";
        const effectiveFormat = format ?? "auto";
        const charLimit = max_chars ?? 100_000;

        if (isBlockedFetchHost(url)) {
          return { error: "refused: blocked host (cloud-metadata / link-local)", url };
        }
        // Reached only once approval resolved, so this IS the "remember what the
        // user allowed" step. See lib/security.ts.
        trustEgressHost(url);

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

          const fetchHeaders: Record<string, string> = {};
          if (headers) {
            for (const [k, v] of Object.entries(headers)) {
              if (typeof v === "string") {
                fetchHeaders[k] = v;
              }
            }
          }

          const fetchOpts: RequestInit = {
            method: effectiveMethod,
            headers: fetchHeaders,
            signal: controller.signal,
          };

          if (effectiveMethod === "POST" && body) {
            fetchOpts.body = body;
          }

          // Always the Rust proxy, never the WebView. `isBlockedFetchHost` above
          // can only compare the hostname STRING, so a name that RESOLVES into
          // the metadata range walks straight past it on the native path. The
          // proxy resolves DNS, checks every resolved IP, and re-checks on each
          // redirect hop (net.rs). It also removes the CORS failure mode that
          // made the fallback necessary in the first place.
          const response = await proxyOnlyFetch(url, fetchOpts);

          const contentType = response.headers.get("content-type") ?? "";
          const status = response.status;
          const statusText = response.statusText;

          // Read response with size limit
          const reader = response.body?.getReader();
          if (!reader) {
            return {
              error: "no response body",
              url,
              status,
              statusText,
            };
          }

          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let truncated = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (totalBytes + value.length > MAX_RESPONSE_BYTES) {
              truncated = true;
              // Stop the upstream pull instead of leaving the socket draining
              // into a body nobody reads.
              void reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
            totalBytes += value.length;
          }
          clearTimeout(timeout); // body fully read — only now is the request done

          const decoder = new TextDecoder("utf-8", { fatal: false });

          // Build the full buffer
          let offset = 0;
          const fullBuffer = new Uint8Array(totalBytes);
          for (const chunk of chunks) {
            fullBuffer.set(chunk, offset);
            offset += chunk.length;
          }
          const fullText = decoder.decode(fullBuffer);

          // Parse based on format
          let data: unknown;
          let isJson = false;

          if (
            effectiveFormat === "json" ||
            (effectiveFormat === "auto" && contentType.includes("application/json"))
          ) {
            try {
              data = JSON.parse(fullText);
              isJson = true;
            } catch {
              // Not valid JSON, fall back to text
            }
          }

          // Clamp for model context
          const clampedText = clampForModel(fullText, charLimit);
          const wasClamped = clampedText.length < fullText.length;

          const result: Record<string, unknown> = {
            url,
            status,
            statusText,
            contentType,
            size: totalBytes,
          };

          // `max_chars` used to bound only the text branch, so a 2 MB JSON body
          // came back as a parsed object in full and one call could fill the
          // context window. Over the limit, fall back to the clamped text -
          // structured data that does not fit is worth less than a readable
          // prefix the model can page past, and `wasClamped` below then reports
          // it with the same wording as any other clamped response.
          if (isJson && data !== undefined && !wasClamped) {
            result.data = data;
            result.format = "json";
          } else {
            result.text = clampedText;
            result.format = "text";
          }

          if (truncated) {
            result.truncated = true;
            result.truncatedReason = "response exceeds 2MB limit";
          } else if (wasClamped) {
            result.truncated = true;
            result.truncatedReason = `response clamped to ${charLimit} chars`;
            result.fullSize = fullText.length;
          }

          if (!response.ok) {
            result.warning = `HTTP ${status}: ${statusText}`;
          }

          return result;
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") {
            return {
              error: `request timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
              url,
            };
          }
          return {
            error: e instanceof Error ? e.message : String(e),
            url,
          };
        } finally {
          // Clear the abort timer on every exit path (success, error, timeout).
          // clearTimeout is idempotent, so the duplicate clear on success is safe.
          clearTimeout(timeout);
        }
      },
    }),
  } as const;
}
