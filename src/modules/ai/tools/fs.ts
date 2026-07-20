import { tool } from "ai";
import { z } from "zod";
import { dispatchFsRefreshForFile, dispatchFsRefresh } from "@/modules/explorer/lib/fsRefresh";
import { recordFileMutation } from "../lib/checkpoint";
import { notifyMemoryPathChanged } from "../lib/memoryCache";
import { native } from "../lib/native";
import { notifySkillPathChanged } from "../lib/skillCache";
import { checkDeletable, checkReadableResolved, checkWritableResolved } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import {
  isReadOutsideScope,
  isScopeRootOrAncestor,
  resolvePath,
  scrubErrorPath,
  throwIfAborted,
  withFileLock,
  type ToolContext,
} from "./context";
import { resolveRoot } from "./search";
import { flexArrayOpt, flexBoolOpt, flexIntOpt } from "./schedule";

const AI_READ_CAP = 200 * 1024;
const DEFAULT_LINE_LIMIT = 2000;
/** Skip undo snapshot above this size; IPC cost outweighs the value. */
const SNAPSHOT_SIZE_CAP = 1_000_000;
/** Largest image handed to the model. Base64 inflates ~4/3 and every provider
 *  bills it as tokens, so a screenshot-sized budget beats the 10 MiB file cap. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Raster extensions the Rust reader decodes. Used only to tell an oversized
 *  IMAGE apart from any other oversized binary, so each gets the error that
 *  actually explains it. Magic-byte sniffing still decides the real answer. */
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|avif|ico)$/i;

/** Image payload returned by `read_file`, unwrapped into a `file-data` part by
 *  its `toModelOutput`. `data` is raw base64, no data-URL prefix. */
type ImageRead = {
  ok: true;
  path: string;
  kind: "image";
  mediaType: string;
  size: number;
  data: string;
};

type ImageTooLarge = { error: string; path: string; size: number };

/**
 * Read `abs` as an image. Returns null when it is not one, so the caller can
 * fall through to the generic binary refusal.
 *
 * SVG is deliberately excluded: it is text, so the normal read path describes it
 * better than a rasterless `file-data` part every provider would have to guess at.
 */
async function readAsImage(
  abs: string,
  size: number,
): Promise<ImageRead | ImageTooLarge | null> {
  // Size-gate before reading, but only claim it as an image error when the name
  // says it is one. Otherwise a 5 MB archive would be reported as an oversized
  // image, and every oversized binary would be read in full just to find out.
  if (size > MAX_IMAGE_BYTES) {
    return IMAGE_EXT.test(abs)
      ? {
          error: `image too large to analyze (${size} bytes, limit ${MAX_IMAGE_BYTES})`,
          path: abs,
          size,
        }
      : null;
  }
  try {
    const full = await native.readFile(abs);
    if (full.kind !== "image" || full.mime === "image/svg+xml") return null;
    const comma = full.dataUrl.indexOf(",");
    if (comma === -1 || !full.dataUrl.slice(0, comma).includes(";base64")) return null;
    return {
      ok: true,
      path: abs,
      kind: "image",
      mediaType: full.mime,
      size: full.size,
      data: full.dataUrl.slice(comma + 1),
    };
  } catch {
    return null;
  }
}

export function buildFsTools(
  ctx: ToolContext,
  opts: {
    gateOutOfScopeReads?: boolean;
    refuseOutOfScopeReads?: boolean;
    refuseOutOfScopeMutations?: boolean;
    autoApproveMutations?: boolean;
    ignorePlanMode?: boolean;
  } = {},
) {
  // Main agent (has an approval UI) gates reads that resolve outside the
  // workspace/cwd; the autonomous read-only subagent passes false so its
  // generateText loop never stalls on an approval that has no responder - but
  // then passes `refuseOutOfScopeReads` so those reads are REFUSED outright (no
  // approver means no silent out-of-scope exfil through a subagent).
  const gateReads = opts.gateOutOfScopeReads ?? true;
  const refuseOutOfScope = opts.refuseOutOfScopeReads ?? false;
  // Mutating fs tools (write/create/move/copy/delete/replace) normally raise an
  // approval card. An autonomous worker subagent runs in a generateText loop
  // with no approver, so it passes autoApproveMutations to execute directly -
  // still guarded by the symlink-resolved secret/system denylist, the
  // writable/deletable checks, scope-root protection, and checkpoint/restore.
  const approveMut = opts.autoApproveMutations ? false : true;
  // An autonomous worker (no approver) refuses mutations outside the
  // workspace/cwd — mirrors refuseOutOfScopeReads so a prompt-injected task
  // can't write/delete anywhere on disk with no approval card.
  const refuseMut = opts.refuseOutOfScopeMutations ?? false;
  // The worker writes directly even in plan mode (its bash verification must see
  // real files, not queued edits); the main agent still queues for review.
  const ignorePlan = opts.ignorePlanMode ?? false;
  const outOfScope = (p: string) =>
    refuseMut && isReadOutsideScope(p, ctx)
      ? { error: "refused: a subagent may not mutate outside the workspace/cwd", path: p }
      : null;
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file, or an image (PNG/JPEG/GIF/WebP/BMP/AVIF) which is returned as a viewable image. Refuses other binaries, oversized, and sensitive files (.env, keys). Text: first 2000 lines (200KB cap); use offset/limit to page. Images cap at 4MB and ignore offset/limit. A path outside the workspace/cwd needs approval.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the active terminal cwd."),
        offset: flexIntOpt({ min: 0 }).describe(
          "0-based line offset to start reading from. Default 0.",
        ),
        limit: flexIntOpt({ min: 1, max: 2000 }).describe(
          "Max lines to return. Default 2000. Cap is hard - re-call with a larger offset to page through.",
        ),
      }),
      needsApproval: gateReads
        ? (input: { path: string }) => isReadOutsideScope(input.path, ctx)
        : undefined,
      execute: async ({ path, offset, limit }) => {
        const abs = resolvePath(path, ctx.getCwd());
        if (refuseOutOfScope && isReadOutsideScope(path, ctx)) {
          return {
            error: "refused: a subagent may not read outside the workspace/cwd",
            path: abs,
          };
        }
        const safety = await checkReadableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        try {
          const startLine = offset ?? 0;
          const lineLimit = limit ?? DEFAULT_LINE_LIMIT;

          // Read the requested range on the Rust side via BufReader so only
          // the slice crosses IPC.
          const r = await native.readFilePortion(abs, startLine, lineLimit);
          if (r.kind === "binary") {
            // The portion reader is line-oriented and has no image variant, so an
            // image lands here as "binary". Multimodal models can actually see it,
            // and the media sub-agent depends on that, so fall back to the
            // whole-file reader which sniffs and decodes images.
            const img = await readAsImage(abs, r.size);
            if (img) return img;
            return { error: "binary file refused", path: abs, size: r.size };
          }
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

          // Byte cap against pathological lines. Trim to the last full line
          // so `actualEnd` reflects how many full lines are included.
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
      // An image result is handed over as a real file-data part so multimodal
      // models see the picture instead of a base64 blob in a JSON string.
      toModelOutput: ({ output }) => {
        const o = output as Partial<ImageRead> | undefined;
        if (o && o.kind === "image" && typeof o.data === "string" && o.mediaType) {
          return {
            type: "content",
            value: [
              { type: "text", text: `Image at ${o.path} (${o.mediaType}, ${o.size} bytes).` },
              { type: "file-data", data: o.data, mediaType: o.mediaType },
            ],
          };
        }
        return { type: "text", value: JSON.stringify(output) };
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries in a directory. Hidden entries omitted. A path outside the workspace/cwd needs approval.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the active terminal cwd."),
      }),
      needsApproval: gateReads
        ? (input: { path: string }) => isReadOutsideScope(input.path, ctx)
        : undefined,
      execute: async ({ path }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableResolved(abs);
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
        "Create / overwrite a file. Prefer Edit / Multi Edit for in-place changes; use Write File only for brand-new files or full replacement of tiny ones. Approval.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      needsApproval: approveMut,
      execute: async ({ path, content }) => {
        throwIfAborted(ctx);
        const abs = resolvePath(path, ctx.getCwd());
        const oos = outOfScope(abs);
        if (oos) return oos;
        const safety = await checkWritableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };

        if (!ignorePlan && usePlanStore.getState().active) {
          let original = "";
          let isNewFile = false;
          // Whether the original can be round-tripped on Restore. A large/binary
          // existing file has no captured original, so recording a modify would
          // truncate it to "" on undo — mark it non-snapshotable instead.
          let snapshotable = true;
          try {
            // readFilePortion as a size probe (reads 1 line but returns full
            // file size). Full read only if small enough to snapshot.
            const probe = await native.readFilePortion(abs, 0, 1);
            if (probe.kind === "text" && probe.size <= SNAPSHOT_SIZE_CAP) {
              const r = await native.readFile(abs);
              if (r.kind === "text") original = r.content;
              else snapshotable = false;
            } else {
              // Large text file or binary/oversized: original not captured.
              snapshotable = false;
            }
          } catch {
            isNewFile = true; // brand-new file: restore deletes it (snapshotable)
          }
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile,
            snapshotable,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            ok: true,
          };
        }

        // Snapshot-then-write is a read-modify-write, so it takes the same
        // per-path lock `edit` uses. Parallel workers are actively encouraged by
        // the orchestration prompt, and without this an `edit` and a `write_file`
        // racing on one path could interleave: the snapshot would capture the
        // other's half-applied state and one change would be lost.
        return withFileLock(abs, async () => {
          // Capture original text if the file existed and was text; mark
          // create-file for new paths. Binary or oversized existing files are
          // skipped (can't round-trip safely).
          const sessionId = ctx.getSessionId();
          if (sessionId) {
            try {
              // Probe size first to avoid reading multi-MB files for undo.
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
              // binary or oversized: skip recording; restore won't touch it.
            } catch {
              // ENOENT, fresh file.
              recordFileMutation(sessionId, abs, {
                kind: "create-file",
                writtenContent: content,
              });
            }
          }

          try {
            await native.writeFile(abs, content);
            ctx.readCache.add(abs);
            notifyMemoryPathChanged(abs);
            notifySkillPathChanged(abs);
            dispatchFsRefreshForFile(abs);
            return { path: abs, bytesWritten: content.length, ok: true };
          } catch (e) {
            return { error: scrubErrorPath(e, ctx), path: abs };
          }
        });
      },
    }),

    create_directory: tool({
      description: "Create a directory (mkdir -p). Approval.",
      inputSchema: z.object({
        path: z.string(),
      }),
      needsApproval: approveMut,
      execute: async ({ path }) => {
        throwIfAborted(ctx);
        const abs = resolvePath(path, ctx.getCwd());
        const oos = outOfScope(abs);
        if (oos) return oos;
        const safety = await checkWritableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        if (!ignorePlan && usePlanStore.getState().active) {
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
        // Record only if the directory didn't already exist; otherwise
        // restore would delete a pre-existing user dir.
        const sessionId = ctx.getSessionId();
        if (sessionId) {
          let alreadyExists = false;
          try {
            await native.readDir(abs);
            alreadyExists = true;
          } catch {
            // doesn't exist; safe to record
          }
          if (!alreadyExists) {
            recordFileMutation(sessionId, abs, { kind: "create-dir" });
          }
        }

        try {
          await native.createDir(abs);
          notifyMemoryPathChanged(abs);
          notifySkillPathChanged(abs);
          dispatchFsRefreshForFile(abs);
          // Refresh the new dir so an immediately-expanded parent sees it.
          dispatchFsRefresh(abs);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), path: abs };
        }
      },
    }),

    move_file: tool({
      description:
        "Move or rename a file/directory. Refuses to overwrite an existing target. Prefer this over a shell mv. Approval.",
      inputSchema: z.object({
        from: z.string().describe("Source path. Absolute, or relative to the active terminal cwd."),
        to: z
          .string()
          .describe("Destination path. Absolute, or relative to the active terminal cwd."),
      }),
      needsApproval: approveMut,
      execute: async ({ from, to }) => {
        throwIfAborted(ctx);
        if (!ignorePlan && usePlanStore.getState().active) {
          return {
            error: "move_file is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const absFrom = resolvePath(from, ctx.getCwd());
        const absTo = resolvePath(to, ctx.getCwd());
        const oosFrom = outOfScope(absFrom);
        if (oosFrom) return oosFrom;
        const oosTo = outOfScope(absTo);
        if (oosTo) return oosTo;
        // Both endpoints pass the write guard: the source is being removed and
        // the destination created, so neither may touch a protected target.
        const sFrom = await checkWritableResolved(absFrom);
        if (!sFrom.ok) return { error: sFrom.reason, path: absFrom };
        const sTo = await checkWritableResolved(absTo);
        if (!sTo.ok) return { error: sTo.reason, path: absTo };
        // Don't relocate the workspace root / active cwd (or a parent of it):
        // that would break every other path the agent is working with.
        if (isScopeRootOrAncestor(absFrom, ctx)) {
          return {
            error: "Refused: the source is, or contains, the workspace/active working directory.",
            path: absFrom,
          };
        }
        try {
          await native.rename(absFrom, absTo);
          // Record only after a successful move so restore never tries to undo
          // a move that didn't happen.
          const sessionId = ctx.getSessionId();
          if (sessionId) {
            recordFileMutation(sessionId, absTo, { kind: "move", from: absFrom, to: absTo });
          }
          ctx.readCache.delete(absFrom);
          notifyMemoryPathChanged(absFrom);
          notifyMemoryPathChanged(absTo);
          notifySkillPathChanged(absFrom);
          notifySkillPathChanged(absTo);
          dispatchFsRefreshForFile(absFrom);
          dispatchFsRefreshForFile(absTo);
          return { from: absFrom, to: absTo, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), from: absFrom, to: absTo };
        }
      },
    }),

    copy_file: tool({
      description:
        "Copy a file or directory (recursive for dirs) to a new path. Refuses to overwrite an existing target. Prefer this over a shell cp. Approval.",
      inputSchema: z.object({
        from: z.string().describe("Source path. Absolute, or relative to the active terminal cwd."),
        to: z
          .string()
          .describe("Destination path. Absolute, or relative to the active terminal cwd."),
      }),
      needsApproval: approveMut,
      execute: async ({ from, to }) => {
        throwIfAborted(ctx);
        if (!ignorePlan && usePlanStore.getState().active) {
          return {
            error: "copy_file is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const absFrom = resolvePath(from, ctx.getCwd());
        const absTo = resolvePath(to, ctx.getCwd());
        const oosFrom = outOfScope(absFrom);
        if (oosFrom) return oosFrom;
        const oosTo = outOfScope(absTo);
        if (oosTo) return oosTo;
        // Source is read, destination is written - apply the matching guards.
        const sFrom = await checkReadableResolved(absFrom);
        if (!sFrom.ok) return { error: sFrom.reason, path: absFrom };
        const sTo = await checkWritableResolved(absTo);
        if (!sTo.ok) return { error: sTo.reason, path: absTo };
        try {
          await native.copy(absFrom, absTo);
          // Checkpoint the copy so it's undoable (best-effort, file-only).
          // copy_file refuses to overwrite, so the destination is always new ->
          // create-file semantics. A directory copy or a binary/oversized file
          // is skipped (no safe content to restore from). Matters now that the
          // autonomous worker can copy files without an approval card.
          // No probe needed — the file just created is known to exist; read it
          // directly to snapshot (one IPC instead of probe+read).
          const sessionId = ctx.getSessionId();
          if (sessionId) {
            try {
              const r = await native.readFile(absTo);
              if (r.kind === "text" && r.size <= SNAPSHOT_SIZE_CAP) {
                recordFileMutation(sessionId, absTo, {
                  kind: "create-file",
                  writtenContent: r.content,
                });
              }
            } catch {
              // Read failed (e.g. a directory copy or binary): not undoable, skip.
            }
          }
          dispatchFsRefreshForFile(absTo);
          return { from: absFrom, to: absTo, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), from: absFrom, to: absTo };
        }
      },
    }),

    delete_file: tool({
      description:
        "Delete a file or directory (recursive for directories). Destructive. Only a text file under ~1MB is checkpoint-undoable; directory and binary/oversized deletes are permanent (stage git first). Approval.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Path to delete. Absolute, or relative to the active terminal cwd."),
      }),
      needsApproval: approveMut,
      execute: async ({ path }) => {
        throwIfAborted(ctx);
        if (!ignorePlan && usePlanStore.getState().active) {
          return {
            error: "delete_file is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const abs = resolvePath(path, ctx.getCwd());
        const oos = outOfScope(abs);
        if (oos) return oos;
        // Layered guards: symlink-resolved secret/system check, then the
        // root/top-level block (delete recurses), then workspace/cwd protection.
        const safety = await checkWritableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        const del = checkDeletable(abs);
        if (!del.ok) return { error: del.reason, path: abs };
        if (isScopeRootOrAncestor(abs, ctx)) {
          return {
            error: "Refused: this path is, or contains, the workspace/active working directory.",
            path: abs,
          };
        }
        // Snapshot text content so restore can recreate the file. Directories
        // and binary/oversized files carry no content and aren't recoverable.
        const sessionId = ctx.getSessionId();
        if (sessionId) {
          try {
            const probe = await native.readFilePortion(abs, 0, 1);
            if (probe.kind === "text" && probe.size <= SNAPSHOT_SIZE_CAP) {
              const r = await native.readFile(abs);
              if (r.kind === "text") {
                recordFileMutation(sessionId, abs, { kind: "delete", content: r.content });
              }
            }
          } catch {
            // Missing or a directory: no snapshot, deletion proceeds unrecorded.
          }
        }
        try {
          await native.deletePath(abs);
          ctx.readCache.delete(abs);
          notifyMemoryPathChanged(abs);
          notifySkillPathChanged(abs);
          dispatchFsRefreshForFile(abs);
          return { path: abs, deleted: true, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), path: abs };
        }
      },
    }),

    replace_in_files: tool({
      description:
        "Project-wide regex find/replace under `root` (ripgrep walk: .gitignore/hidden/binary skipped, atomic writes). `replacement` supports $1/${name} refs. For cross-file refactors; a single file → Edit/Multi Edit. NOT checkpoint-undoable - stage git first. In-scope root only. Approval.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern (Rust regex dialect, multiline)."),
        replacement: z
          .string()
          .describe("Replacement text. $1 / ${name} expand capture groups; literal $ is $$."),
        root: z
          .string()
          .optional()
          .describe("Root to replace under. Defaults to workspace root, then active cwd."),
        glob: flexArrayOpt(z.string()).describe(
          "Optional include-globs over relative paths, e.g. ['**/*.ts']. Narrow the blast radius.",
        ),
        case_insensitive: flexBoolOpt(),
      }),
      needsApproval: approveMut,
      execute: async ({ pattern, replacement, root, glob, case_insensitive }) => {
        throwIfAborted(ctx);
        if (!ignorePlan && usePlanStore.getState().active) {
          return {
            error: "replace_in_files is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        // Destructive multi-file write with no per-file review: keep it inside the
        // project (no disk-wide rewrites) and off protected/system dirs.
        if (isReadOutsideScope(r.path, ctx)) {
          return {
            error:
              "Refused: root is outside the workspace/active cwd; narrow it to a project path.",
            root: r.path,
          };
        }
        const safety = await checkWritableResolved(r.path);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        try {
          const res = await native.grepReplace({
            pattern,
            replacement,
            root: r.path,
            glob,
            caseInsensitive: case_insensitive,
          });
          // Changed files' cached reads are stale now; drop them so edit/multi_edit
          // re-read before touching them.
          for (const e of res.edits) ctx.readCache.delete(e.path);
          if (res.files_changed > 0) dispatchFsRefresh(r.path);
          return {
            root: r.path,
            files_changed: res.files_changed,
            total_replacements: res.total_replacements,
            edits: res.edits,
            truncated: res.truncated,
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), root: r.path };
        }
      },
    }),
  } as const;
}
