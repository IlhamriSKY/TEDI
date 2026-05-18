import { tool } from "ai";
import { z } from "zod";
import { recordFileMutation } from "../lib/checkpoint";
import { native } from "../lib/native";
import { checkReadable, checkWritable } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

const AI_READ_CAP = 200 * 1024;
const DEFAULT_LINE_LIMIT = 2000;

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Returns content for text files; refuses binary, oversized, or sensitive files (.env, keys, credentials). Defaults to the first 2000 lines (capped at 200KB). Pass `offset`/`limit` to read a specific window of a large file.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the active terminal cwd."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based line offset to start reading from. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            "Max lines to return. Default 2000. Cap is hard - re-call with a larger offset to page through.",
          ),
      }),
      execute: async ({ path, offset, limit }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkReadable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        try {
          const r = await native.readFile(abs);
          if (r.kind === "binary") return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge") {
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };
          }

          ctx.readCache.add(abs);
          const lines = r.content.split("\n");
          const totalLines = lines.length;
          const startLine = offset ?? 0;
          const lineLimit = limit ?? DEFAULT_LINE_LIMIT;
          const requestedEnd = Math.min(totalLines, startLine + lineLimit);
          let sliced = lines.slice(startLine, requestedEnd).join("\n");
          let actualEnd = requestedEnd;
          let byteTruncated = false;

          // Byte cap is a final safety net against pathological lines. Trim
          // to the last complete line so the output stays parseable and
          // `actualEnd` reflects how many full lines were included.
          if (sliced.length > AI_READ_CAP) {
            sliced = sliced.slice(0, AI_READ_CAP);
            byteTruncated = true;
            const lastNL = sliced.lastIndexOf("\n");
            if (lastNL > 0) {
              sliced = sliced.slice(0, lastNL);
              const includedLines = sliced.length > 0 ? sliced.split("\n").length : 0;
              actualEnd = startLine + includedLines;
            }
            // If lastNL <= 0, the single line itself exceeds the byte cap.
            // We can't page through it with a line-offset API; the model
            // should grep/sed if it needs more.
          }

          const linesTruncated = actualEnd < totalLines;
          const truncated = linesTruncated || byteTruncated;
          return {
            path: abs,
            content: sliced,
            size: r.size,
            startLine,
            endLine: actualEnd,
            totalLines,
            ...(truncated
              ? {
                  truncated: true,
                  ...(linesTruncated ? { nextOffset: actualEnd } : {}),
                }
              : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkReadable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        try {
          const entries = await native.readDir(abs);
          return {
            path: abs,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a file with the given content. Always asks the user before running. Prefer `edit` / `multi_edit` for in-place changes - only use `write_file` for creating a brand-new file or fully replacing a tiny one.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path, content }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkWritable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };

        if (usePlanStore.getState().active) {
          let original = "";
          let isNewFile = false;
          try {
            const r = await native.readFile(abs);
            if (r.kind === "text") original = r.content;
          } catch {
            isNewFile = true;
          }
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            ok: true,
          };
        }

        // Snapshot for restore-checkpoint. Capture original text content
        // if the file existed and was text; mark as create-file for a
        // brand-new path. Binary / oversized existing files are NOT
        // snapshotted - we can't safely round-trip them through a text
        // restore, so a future restore will leave them alone.
        const sessionId = ctx.getSessionId();
        if (sessionId) {
          try {
            const r = await native.readFile(abs);
            if (r.kind === "text") {
              recordFileMutation(sessionId, abs, {
                kind: "modify",
                originalContent: r.content,
                writtenContent: content,
              });
            }
            // binary / toolarge: skip recording. Restore won't touch it.
          } catch {
            // ENOENT - fresh file.
            recordFileMutation(sessionId, abs, {
              kind: "create-file",
              writtenContent: content,
            });
          }
        }

        try {
          await native.writeFile(abs, content);
          ctx.readCache.add(abs);
          return { path: abs, bytesWritten: content.length, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    create_directory: tool({
      description:
        "Create a directory (and any missing parents). Always asks the user before running.",
      inputSchema: z.object({
        path: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkWritable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "create_directory",
            path: abs,
            originalContent: "",
            proposedContent: "",
            isNewFile: true,
            description: "Create directory",
          });
          return { path: abs, queued_for_plan_review: true, ok: true };
        }
        // Snapshot for restore-checkpoint. Only record if the directory
        // didn't already exist - otherwise restore would delete a dir the
        // agent didn't create (and possibly its prior contents).
        const sessionId = ctx.getSessionId();
        if (sessionId) {
          let alreadyExists = false;
          try {
            await native.readDir(abs);
            alreadyExists = true;
          } catch {
            // doesn't exist - safe to record
          }
          if (!alreadyExists) {
            recordFileMutation(sessionId, abs, { kind: "create-dir" });
          }
        }

        try {
          await native.createDir(abs);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),
  } as const;
}
