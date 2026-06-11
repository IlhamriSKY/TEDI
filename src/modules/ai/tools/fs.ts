import { tool } from "ai";
import { z } from "zod";
import { dispatchFsRefreshForFile, dispatchFsRefresh } from "@/modules/explorer/lib/fsRefresh";
import { recordFileMutation } from "../lib/checkpoint";
import { native } from "../lib/native";
import { checkDeletable, checkReadable, checkWritable } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import {
  isReadOutsideScope,
  isScopeRootOrAncestor,
  resolvePath,
  scrubErrorPath,
  throwIfAborted,
  type ToolContext,
} from "./context";
import { resolveRoot } from "./search";
import { flexArrayOpt, flexBoolOpt, flexIntOpt } from "./schedule";

const AI_READ_CAP = 200 * 1024;
const DEFAULT_LINE_LIMIT = 2000;
/** Skip undo snapshot above this size; IPC cost outweighs the value. */
const SNAPSHOT_SIZE_CAP = 1_000_000;

/**
 * Run the secret deny-list against the symlink-resolved real target, not the
 * literal path string. A string-only check is blind to an innocuously-named
 * symlink (notes.txt -> ~/.ssh/id_rsa); the backend follows symlinks on read,
 * so without this an auto-approved read could exfiltrate the target. Falls
 * back to the literal path if canonicalization fails (e.g. the path does not
 * exist yet) - the read itself surfaces any real error.
 */
async function checkReadableResolved(abs: string): Promise<ReturnType<typeof checkReadable>> {
  const literal = checkReadable(abs);
  if (!literal.ok) return literal;
  try {
    const real = await native.canonicalize(abs);
    if (real && real !== abs) return checkReadable(real);
  } catch {
    // Path missing / not resolvable: literal check already passed.
  }
  return literal;
}

/**
 * Write-side counterpart of checkReadableResolved: resolve symlinks before the
 * secret + system-dir check so an innocuously-named symlink can't redirect a
 * write into a protected target (e.g. notes.txt -> /etc/hosts, or a link into
 * C:\Windows). Falls back to the literal check when the path doesn't exist yet
 * (the common brand-new-file case).
 */
async function checkWritableResolved(abs: string): Promise<ReturnType<typeof checkWritable>> {
  const literal = checkWritable(abs);
  if (!literal.ok) return literal;
  try {
    const real = await native.canonicalize(abs);
    if (real && real !== abs) return checkWritable(real);
  } catch {
    // Path missing / not resolvable: literal check already passed.
  }
  return literal;
}

export function buildFsTools(ctx: ToolContext, opts: { gateOutOfScopeReads?: boolean } = {}) {
  // Main agent (has an approval UI) gates reads that resolve outside the
  // workspace/cwd; the autonomous read-only subagent passes false so its
  // generateText loop never stalls on an approval that has no responder.
  const gateReads = opts.gateOutOfScopeReads ?? true;
  return {
    read_file: tool({
      description:
        "Read UTF-8 text file. Refuses binary / oversized / sensitive (.env, keys). Default first 2000 lines (200KB cap). Use offset/limit to page large files. A path outside the workspace/cwd needs approval.",
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
        const safety = await checkReadableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        try {
          const startLine = offset ?? 0;
          const lineLimit = limit ?? DEFAULT_LINE_LIMIT;

          // Read the requested range on the Rust side via BufReader so only
          // the slice crosses IPC.
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
      needsApproval: true,
      execute: async ({ path, content }) => {
        throwIfAborted(ctx);
        const abs = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };

        if (usePlanStore.getState().active) {
          let original = "";
          let isNewFile = false;
          try {
            // readFilePortion as a size probe (reads 1 line but returns full
            // file size). Full read only if small enough to snapshot.
            const probe = await native.readFilePortion(abs, 0, 1);
            if (probe.kind === "text" && probe.size <= SNAPSHOT_SIZE_CAP) {
              const r = await native.readFile(abs);
              if (r.kind === "text") original = r.content;
            } else if (probe.kind === "text") {
              // Large text file: plan review shows proposed content only.
            } else {
              // binary or too large
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

        // Snapshot for restore-checkpoint. Capture original text if the file
        // existed and was text; mark create-file for new paths. Binary or
        // oversized existing files are skipped (can't round-trip safely).
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
        const safety = await checkWritableResolved(abs);
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
      needsApproval: true,
      execute: async ({ from, to }) => {
        throwIfAborted(ctx);
        if (usePlanStore.getState().active) {
          return {
            error: "move_file is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const absFrom = resolvePath(from, ctx.getCwd());
        const absTo = resolvePath(to, ctx.getCwd());
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
      needsApproval: true,
      execute: async ({ from, to }) => {
        throwIfAborted(ctx);
        if (usePlanStore.getState().active) {
          return {
            error: "copy_file is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const absFrom = resolvePath(from, ctx.getCwd());
        const absTo = resolvePath(to, ctx.getCwd());
        // Source is read, destination is written - apply the matching guards.
        const sFrom = await checkReadableResolved(absFrom);
        if (!sFrom.ok) return { error: sFrom.reason, path: absFrom };
        const sTo = await checkWritableResolved(absTo);
        if (!sTo.ok) return { error: sTo.reason, path: absTo };
        try {
          await native.copy(absFrom, absTo);
          dispatchFsRefreshForFile(absTo);
          return { from: absFrom, to: absTo, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx), from: absFrom, to: absTo };
        }
      },
    }),

    delete_file: tool({
      description:
        "Delete a file or directory (recursive for directories). Destructive - prefer this over a shell rm so the change is checkpointed. Approval.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Path to delete. Absolute, or relative to the active terminal cwd."),
      }),
      needsApproval: true,
      execute: async ({ path }) => {
        throwIfAborted(ctx);
        if (usePlanStore.getState().active) {
          return {
            error: "delete_file is unavailable in plan mode (reads and queued edits only).",
          };
        }
        const abs = resolvePath(path, ctx.getCwd());
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
      needsApproval: true,
      execute: async ({ pattern, replacement, root, glob, case_insensitive }) => {
        throwIfAborted(ctx);
        if (usePlanStore.getState().active) {
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
