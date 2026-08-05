import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadable } from "../lib/security";
import { isReadOutsideScope, resolvePath, scrubErrorPath, type ToolContext } from "./context";
import { flexArrayOpt, flexBoolOpt, flexIntOpt } from "./schedule";

export function resolveRoot(
  rawRoot: string | undefined,
  ctx: ToolContext,
): { ok: true; path: string } | { ok: false; error: string } {
  if (rawRoot && rawRoot.trim().length > 0) {
    try {
      return { ok: true, path: resolvePath(rawRoot, ctx.getCwd()) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const ws = ctx.getWorkspaceRoot();
  if (ws) return { ok: true, path: ws };
  const cwd = ctx.getCwd();
  if (cwd) return { ok: true, path: cwd };
  return {
    ok: false,
    error: "no workspace root or active cwd; pass `root` explicitly.",
  };
}

/** Per-hit cap on matched-line text: ripgrep returns whole lines, and a match in
 *  a minified bundle is one line hundreds of KB wide. Applied in `execute` so
 *  the chat card is covered too; Explorer calls `fs_grep` directly and keeps
 *  full lines. */
const MAX_MATCH_TEXT = 400;

/** Native default is 200 hits, which is the right budget when every hit carries
 *  its text. `files`/`count` collapse hits to one line per file, so that cap
 *  would silently answer "which files match" from only the first 200 matches.
 *  Raise it to the Rust hard cap for those modes: the cost is local IPC, not
 *  tokens. */
const FILE_MODE_MAX_RESULTS = 2000;

type Hit = { path: string; rel: string; line: number; text: string };

export function truncateText(text: string): string {
  return text.length > MAX_MATCH_TEXT
    ? `${text.slice(0, MAX_MATCH_TEXT)}...[line truncated]`
    : text;
}

/**
 * Compact, model-facing rendering of a grep result. The raw shape repeats an
 * absolute AND a relative path per hit, measured at ~50% of a 402-hit payload
 * here; grouping by file states each path once. Absolute on purpose: `rel` is
 * relative to the search root, but `read_file` resolves against the terminal
 * cwd, and those differ. `execute`'s return is unchanged for the chat card.
 */
export function formatGrep(
  o: {
    root?: string;
    hits?: Hit[];
    truncated?: boolean;
    files_scanned?: number;
    redacted_secret_files?: number;
  },
  mode: "content" | "files" | "count",
): string {
  const hits = o.hits ?? [];
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byFile.get(h.path);
    if (list) list.push(h);
    else byFile.set(h.path, [h]);
  }

  const notes: string[] = [];
  if (o.truncated) {
    notes.push(
      mode === "content"
        ? "truncated: more matches exist, narrow the pattern/glob or raise max_results"
        : "truncated: more matches exist, so this file list may be incomplete",
    );
  }
  if (o.redacted_secret_files)
    notes.push(`${o.redacted_secret_files} hit(s) in secret files hidden`);

  if (byFile.size === 0) {
    return `no matches under ${o.root ?? "(unknown root)"}${
      notes.length ? ` (${notes.join("; ")})` : ""
    }`;
  }

  const head =
    `${byFile.size} file(s), ${hits.length} match(es)` +
    (o.files_scanned ? ` in ${o.files_scanned} scanned` : "") +
    (notes.length ? ` [${notes.join("; ")}]` : "");

  if (mode === "files") return [head, ...byFile.keys()].join("\n");
  if (mode === "count") {
    return [head, ...[...byFile].map(([p, hs]) => `${hs.length}\t${p}`)].join("\n");
  }
  // trimEnd, not trim: the Rust side strips only '\n', so a CRLF file leaves a
  // stray '\r' on every hit. Leading indentation is kept deliberately - it tells
  // the model how deeply the match is nested, and dropping it measured at under
  // 5% of the match text, which is not worth the lost signal.
  const blocks = [...byFile].map(
    ([p, hs]) => `${p}\n${hs.map((h) => `${h.line}: ${h.text.trimEnd()}`).join("\n")}`,
  );
  return [head, ...blocks].join("\n\n");
}

export function buildSearchTools(
  ctx: ToolContext,
  opts: { gateOutOfScopeReads?: boolean; refuseOutOfScopeReads?: boolean } = {},
) {
  // See buildFsTools: gate searches rooted outside the workspace/cwd in the main
  // agent (approval UI); off for the autonomous subagent, which instead REFUSES
  // them (no approver) via `refuseOutOfScopeReads`.
  const gateReads = opts.gateOutOfScopeReads ?? true;
  const refuseOutOfScope = opts.refuseOutOfScopeReads ?? false;
  const rootNeedsApproval = gateReads
    ? (input: { root?: string }) => (input.root ? isReadOutsideScope(input.root, ctx) : false)
    : undefined;
  return {
    grep: tool({
      description:
        "Regex content search across workspace (ripgrep, .gitignore honored). Grouped by file. Prefer this over Read File loops. When you only need WHICH files match, pass output_mode='files' - it is far cheaper than reading every matching line. A root outside the workspace/cwd needs approval.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "Regex pattern (Rust ripgrep dialect). Anchor and escape literal characters as needed.",
          ),
        root: z
          .string()
          .optional()
          .describe("Root to search under. Defaults to workspace root, then active cwd."),
        glob: flexArrayOpt(z.string()).describe(
          "Optional include-globs over relative paths, e.g. ['**/*.ts', 'src/**/*.tsx'].",
        ),
        case_insensitive: flexBoolOpt(),
        max_results: flexIntOpt({ min: 1, max: 2000 }),
        output_mode: z
          .enum(["content", "files", "count"])
          .optional()
          .describe(
            "content (default) = matching lines; files = matching file paths only; count = matches per file. Use files/count when the line text does not matter.",
          ),
      }),
      needsApproval: rootNeedsApproval,
      execute: async ({ pattern, root, glob, case_insensitive, max_results, output_mode }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        if (refuseOutOfScope && root && isReadOutsideScope(root, ctx)) {
          return {
            error: "refused: a subagent may not search outside the workspace/cwd",
            root: r.path,
          };
        }
        const safety = checkReadable(r.path);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        try {
          const mode = output_mode ?? "content";
          const res = await native.grep({
            pattern,
            root: r.path,
            glob,
            caseInsensitive: case_insensitive,
            maxResults: max_results ?? (mode === "content" ? undefined : FILE_MODE_MAX_RESULTS),
          });
          // Apply the secret deny-list per matched file, mirroring read_file:
          // the walker can return the contents of NON-hidden secret files
          // (*.pem, *.key, id_rsa, credentials, secrets.{json,yaml,toml}, ...)
          // that read_file would refuse, so drop those hits before they reach
          // the model. checkReadable on the root alone does not cover them.
          const all = res.hits;
          const hits = all
            .filter((h) => checkReadable(h.path).ok)
            .map((h) => ({
              path: h.path,
              rel: h.rel,
              line: h.line,
              text: truncateText(h.text),
            }));
          const redacted = all.length - hits.length;
          return {
            root: r.path,
            hits,
            truncated: res.truncated,
            files_scanned: res.files_scanned,
            ...(redacted > 0 ? { redacted_secret_files: redacted } : {}),
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), root: r.path };
        }
      },
      toModelOutput: ({ input, output }) => {
        const o = (output ?? {}) as Parameters<typeof formatGrep>[0] & { error?: unknown };
        if (o.error !== undefined) return { type: "text", value: JSON.stringify(output) };
        const mode = (input as { output_mode?: "content" | "files" | "count" } | undefined)
          ?.output_mode;
        return { type: "text", value: formatGrep(o, mode ?? "content") };
      },
    }),

    glob: tool({
      description:
        "Find files by path glob (e.g. `**/*.ts`). Gitignore-aware. Use over List Directory for recursive matches. A root outside the workspace/cwd needs approval.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern over relative paths."),
        root: z.string().optional(),
        max_results: flexIntOpt({ min: 1, max: 2000 }),
      }),
      needsApproval: rootNeedsApproval,
      execute: async ({ pattern, root, max_results }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        if (refuseOutOfScope && root && isReadOutsideScope(root, ctx)) {
          return {
            error: "refused: a subagent may not search outside the workspace/cwd",
            root: r.path,
          };
        }
        const safety = checkReadable(r.path);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        try {
          const res = await native.glob({
            pattern,
            root: r.path,
            maxResults: max_results,
          });
          // Same per-hit deny-list as grep: do not surface secret file paths.
          const hits = res.hits.filter((h) => checkReadable(h.path).ok);
          const redacted = res.hits.length - hits.length;
          return {
            root: r.path,
            hits,
            truncated: res.truncated,
            ...(redacted > 0 ? { redacted_secret_files: redacted } : {}),
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), root: r.path };
        }
      },
      // Same duplication as grep: every hit carries an absolute AND a relative
      // path. One absolute path per line says the same thing and stays valid
      // wherever the model uses it.
      toModelOutput: ({ output }) => {
        const o = (output ?? {}) as {
          root?: string;
          hits?: { path: string }[];
          truncated?: boolean;
          redacted_secret_files?: number;
          error?: unknown;
        };
        if (o.error !== undefined) return { type: "text", value: JSON.stringify(output) };
        const paths = (o.hits ?? []).map((h) => h.path);
        if (paths.length === 0) {
          return { type: "text", value: `no files match under ${o.root ?? "(unknown root)"}` };
        }
        const notes = [
          o.truncated ? "truncated: raise max_results or narrow the pattern" : "",
          o.redacted_secret_files ? `${o.redacted_secret_files} secret file(s) hidden` : "",
        ].filter(Boolean);
        const head = `${paths.length} file(s)${notes.length ? ` [${notes.join("; ")}]` : ""}`;
        return { type: "text", value: [head, ...paths].join("\n") };
      },
    }),
  } as const;
}
