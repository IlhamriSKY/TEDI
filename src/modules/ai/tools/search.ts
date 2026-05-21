import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadable } from "../lib/security";
import { resolvePath, scrubErrorPath, type ToolContext } from "./context";
import { flexArrayOpt, flexBoolOpt, flexIntOpt } from "./schedule";

function resolveRoot(
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

export function buildSearchTools(ctx: ToolContext) {
  return {
    grep: tool({
      description:
        "Regex content search across workspace (ripgrep, .gitignore honored). Returns {path,line,text} hits. Prefer this over read_file loops.",
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
      }),
      execute: async ({ pattern, root, glob, case_insensitive, max_results }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = checkReadable(r.path);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        try {
          const res = await native.grep({
            pattern,
            root: r.path,
            glob,
            caseInsensitive: case_insensitive,
            maxResults: max_results,
          });
          return {
            root: r.path,
            hits: res.hits.map((h) => ({
              path: h.path,
              rel: h.rel,
              line: h.line,
              text: h.text,
            })),
            truncated: res.truncated,
            files_scanned: res.files_scanned,
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), root: r.path };
        }
      },
    }),

    glob: tool({
      description:
        "Find files by path glob (e.g. `**/*.ts`). Gitignore-aware. Use over list_directory for recursive matches.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern over relative paths."),
        root: z.string().optional(),
        max_results: flexIntOpt({ min: 1, max: 2000 }),
      }),
      execute: async ({ pattern, root, max_results }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = checkReadable(r.path);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        try {
          const res = await native.glob({
            pattern,
            root: r.path,
            maxResults: max_results,
          });
          return {
            root: r.path,
            hits: res.hits,
            truncated: res.truncated,
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), root: r.path };
        }
      },
    }),
  } as const;
}
