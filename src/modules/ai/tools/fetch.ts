import { tool } from "ai";
import { z } from "zod";
import { clampForModel } from "./context";

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
 * - Pages requiring JavaScript rendering (use Open Preview)
 * - Authentication flows (use browser tools)
 */
export function buildFetchTools() {
  return {
    fetch: tool({
      description:
        "Fetch a URL and return its content. For APIs, JSON endpoints, text files, or simple HTML. No JavaScript execution. Use for data retrieval when you don't need browser rendering. For interactive/JS-heavy pages, use Open Preview instead. Auto for GET; approval for POST.",
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
        body: z
          .string()
          .optional()
          .describe("Request body (for POST). Sent as-is."),
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
          .describe(
            "Max characters to return. Default 100,000. Increase for large datasets.",
          ),
      }),
      needsApproval: (input: { method?: string }) =>
        (input.method ?? "GET") !== "GET",
      execute: async ({ url, method, headers, body, format, max_chars }) => {
        const effectiveMethod = method ?? "GET";
        const effectiveFormat = format ?? "auto";
        const charLimit = max_chars ?? 100_000;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            FETCH_TIMEOUT_MS,
          );

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

          const response = await fetch(url, fetchOpts);
          clearTimeout(timeout);

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
              break;
            }
            chunks.push(value);
            totalBytes += value.length;
          }

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
            (effectiveFormat === "auto" &&
              contentType.includes("application/json"))
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

          if (isJson && data !== undefined) {
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
        }
      },
    }),
  } as const;
}
