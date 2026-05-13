import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadable, checkWritable } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

const AI_READ_CAP = 200 * 1024;

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Returns content for text files; refuses binary, oversized, or sensitive files (.env, keys, credentials). Files larger than 200KB are truncated - re-call with a different path or use run_command for `sed -n` slicing if you need the rest.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const safety = checkReadable(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        try {
          const r = await native.readFile(abs);
          if (r.kind === "text") {
            ctx.readCache.add(abs);
            if (r.content.length > AI_READ_CAP) {
              return {
                path: abs,
                content: r.content.slice(0, AI_READ_CAP),
                size: r.size,
                truncated: true,
                truncatedAt: AI_READ_CAP,
              };
            }
            return { path: abs, content: r.content, size: r.size };
          }
          if (r.kind === "binary")
            return { error: "binary file refused", path: abs, size: r.size };
          return {
            error: `file too large (${r.size} bytes, limit ${r.limit})`,
            path: abs,
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
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
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
