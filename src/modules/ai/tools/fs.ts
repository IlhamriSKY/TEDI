import { tool } from "ai";
import { z } from "zod";
import { dispatchFsRefreshForFile, dispatchFsRefresh } from "@/modules/explorer/lib/fsRefresh";
import { recordFileMutation } from "../lib/checkpoint";
import { native } from "../lib/native";
import { checkReadable, checkWritable } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, scrubErrorPath, throwIfAborted, type ToolContext } from "./context";
import { flexIntOpt } from "./schedule";

const AI_READ_CAP = 200 * 1024;
const DEFAULT_LINE_LIMIT = 2000;
/** Files larger than this won't be snapshotted for undo — the IPC cost of
 *  transferring multi-MB content just for a checkpoint isn't worth it. */
const SNAPSHOT_SIZE_CAP = 1_000_000;

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read UTF-8 text file. Refuses binary / oversized / sensitive (.env, keys). Default first 2000 lines (200KB cap). Use offset/limit to page large files.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the active terminal cwd."),
        offset: flexIntOpt({ min: 0 }).describe(
          "0-based line offset to start reading from. Default 0.",
        ),
        limit: flexIntOpt({ min: 1, max: 2000 }).describe(
          "Max lines to return. Default 2000. Cap is hard - re-call with a larger offset to page through.",
        ),
      }),
      execute: async ({ path, offset, limit }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkReadable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        try {
          const startLine = offset ?? 0;
          const lineLimit = limit ?? DEFAULT_LINE_LIMIT;

          // Read only the requested line range on the Rust side via BufReader
          // so only the sliced content crosses the IPC boundary.
          const r = await native.readFilePortion(abs, startLine, lineLimit);
          if (r.kind === "binary") return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge") {
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };
          }

          ctx.readCache.add(abs);

          let content = r.content;
          let actualEnd = r.endLine;
          let byteTruncated = false;

          // Byte cap is a final safety net against pathological lines. Trim
          // to the last complete line so the output stays parseable and
          // `actualEnd` reflects how many full lines were included.
          if (content.length > AI_READ_CAP) {
            content = content.slice(0, AI_READ_CAP);
            byteTruncated = true;
            const lastNL = content.lastIndexOf("\n");
            if (lastNL > 0) {
              content = content.slice(0, lastNL);
              const includedLines = content.length > 0 ? content.split("\n").length : 0;
              actualEnd = startLine + includedLines;
            }
          }

          const linesTruncated = actualEnd < r.totalLines;
          const truncated = linesTruncated || byteTruncated;
          return {
            path: abs,
            content,
            size: r.size,
            startLine: r.startLine,
            endLine: actualEnd,
            totalLines: r.totalLines,
            ...(truncated
              ? {
                  truncated: true,
                  ...(linesTruncated ? { nextOffset: actualEnd } : {}),
                }
              : {}),
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), path: abs };
        }
      },
    }),

    list_directory: tool({
      description: "List immediate entries in a directory. Hidden entries omitted.",
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
          return { error: scrubErrorPath(e, ctx), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create / overwrite a file. Prefer edit / multi_edit for in-place changes; use write_file only for brand-new files or full replacement of tiny ones. Approval.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path, content }) => {
        throwIfAborted(ctx);
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkWritable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };

        if (usePlanStore.getState().active) {
          let original = "";
          let isNewFile = false;
          try {
            // Use readFilePortion as a lightweight size probe — only reads
            // 1 line but returns the full file `size`. Full read only if the
            // file is small enough to snapshot.
            const probe = await native.readFilePortion(abs, 0, 1);
            if (probe.kind === "text" && probe.size <= SNAPSHOT_SIZE_CAP) {
              const r = await native.readFile(abs);
              if (r.kind === "text") original = r.content;
            } else if (probe.kind === "text") {
              // Large text file — plan review will show proposed content only.
            } else {
              // binary / toolarge
            }
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
            // Probe size first to avoid reading multi-MB files over IPC
            // just for an undo checkpoint.
            const probe = await native.readFilePortion(abs, 0, 1);
            if (probe.kind === "text" && probe.size <= SNAPSHOT_SIZE_CAP) {
              const r = await native.readFile(abs);
              if (r.kind === "text") {
                recordFileMutation(sessionId, abs, {
                  kind: "modify",
                  originalContent: r.content,
                  writtenContent: content,
                });
              }
            }
            // binary / toolarge / oversized: skip recording. Restore won't touch it.
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
          dispatchFsRefreshForFile(abs);
          return { path: abs, bytesWritten: content.length, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), path: abs };
        }
      },
    }),

    create_directory: tool({
      description: "Create a directory (mkdir -p). Approval.",
      inputSchema: z.object({
        path: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path }) => {
        throwIfAborted(ctx);
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
          dispatchFsRefreshForFile(abs);
          // Also refresh the new dir itself in case the user has the
          // parent expanded and immediately drills into it.
          dispatchFsRefresh(abs);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), path: abs };
        }
      },
    }),
  } as const;
}
