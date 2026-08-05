import { tool } from "ai";
import { z } from "zod";
import { dispatchFsRefreshForFile } from "@/modules/explorer/lib/fsRefresh";
import { recordFileMutation } from "../lib/checkpoint";
import { lineAt, lineSpan, MAX_REPORTED_HUNKS, totalLines, type EditHunk } from "../lib/lineStats";

const EDIT_PREVIEW_MAX_CHARS = 12_000;

function previewText(value: string): { text: string; clipped: boolean } {
  if (value.length <= EDIT_PREVIEW_MAX_CHARS) return { text: value, clipped: false };
  return { text: value.slice(0, EDIT_PREVIEW_MAX_CHARS), clipped: true };
}

import { notifyMemoryPathChanged } from "../lib/memoryCache";
import { native } from "../lib/native";
import { notifySkillPathChanged } from "../lib/skillCache";
import { checkWritableResolved } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import {
  isReadOutsideScope,
  resolvePath,
  scrubErrorPath,
  throwIfAborted,
  withFileLock,
  type ToolContext,
} from "./context";
import { flexArrayReq, flexBoolOpt } from "./schedule";

/**
 * Model-facing view of an edit result. `removedText`/`addedText` only feed the
 * chat card's diff; the model already holds both strings from its own tool call,
 * so echoing them bills the same text twice - up to 240K chars from one
 * multi_edit. Line counts stay, being the part it cannot derive.
 *
 * `execute`'s return is untouched, so the card still renders.
 */
export function leanEditOutput(output: unknown): string {
  if (!output || typeof output !== "object" || !("hunks" in output)) {
    // `JSON.stringify(undefined)` is `undefined`, not a string, and this value
    // goes straight onto the wire as a text part.
    return JSON.stringify(output) ?? "null";
  }
  const { hunks, ...rest } = output as { hunks?: EditHunk[] } & Record<string, unknown>;
  return JSON.stringify({
    ...rest,
    hunks: (hunks ?? []).map((h) => ({ line: h.line, removed: h.removed, added: h.added })),
  });
}

type EditResult =
  | {
      ok: true;
      replacements: number;
      bytesWritten: number;
      path: string;
      /** Line totals and per-replacement detail for the chat card's diff badge. */
      linesAdded: number;
      linesRemoved: number;
      hunks: EditHunk[];
    }
  | { error: string; path: string };

function applyEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  kind: "edit" | "multi_edit",
  sessionId: string | null,
  ctx: ToolContext,
  ignorePlan: boolean,
): Promise<EditResult> {
  // Serialize concurrent edits to the same path (parallel workers) so an
  // interleaved read-modify-write can't drop one agent's change.
  return withFileLock(abs, () => applyEditsLocked(abs, edits, kind, sessionId, ctx, ignorePlan));
}

async function applyEditsLocked(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  kind: "edit" | "multi_edit",
  sessionId: string | null,
  ctx: ToolContext,
  ignorePlan: boolean,
): Promise<EditResult> {
  const r = await native.readFile(abs);
  if (r.kind === "binary") return { error: "binary file refused", path: abs };
  if (r.kind === "image") return { error: "image file refused", path: abs };
  if (r.kind === "toolarge") return { error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  let content = original;
  let totalReplacements = 0;
  // Every replacement's line footprint, recorded as it lands.
  // Known limit: a later edit's line number is read off the already-partly-edited
  // buffer, so in a multi_edit an earlier insertion shifts it. Exact for the
  // single-edit case, which is nearly all of them; re-diffing the whole file
  // afterwards is the upgrade if multi_edit line numbers ever matter.
  const hunks: EditHunk[] = [];
  const recordHunk = (offset: number, oldS: string, newS: string) => {
    if (hunks.length >= MAX_REPORTED_HUNKS) return;
    const removedPreview = previewText(oldS);
    const addedPreview = previewText(newS);
    hunks.push({
      line: lineAt(content, offset),
      removed: lineSpan(oldS),
      added: lineSpan(newS),
      removedText: removedPreview.text,
      addedText: addedPreview.text,
      previewClipped: removedPreview.clipped || addedPreview.clipped,
    });
  };

  // read_file strips \r (the model copies LF-only text), but native.readFile
  // preserves the file's CRLF. On a CRLF file, translate each edit's LF newlines
  // to CRLF so a multi-line old_string matches and the write keeps the file's
  // line endings. Single-line edits (no \n) are unaffected.
  const crlf = original.includes("\r\n");
  const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);

  for (const e of edits) {
    if (e.old_string === e.new_string) {
      return {
        error: "old_string and new_string are identical",
        path: abs,
      };
    }
    if (e.old_string.length === 0) {
      return { error: "old_string cannot be empty", path: abs };
    }
    const oldS = norm(e.old_string);
    const newS = norm(e.new_string);
    if (e.replace_all) {
      let n = 0;
      let i = 0;
      while ((i = content.indexOf(oldS, i)) !== -1) {
        n++;
        recordHunk(i, oldS, newS);
        i += oldS.length;
      }
      if (n === 0) {
        return {
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
          path: abs,
        };
      }
      content = content.split(oldS).join(newS);
      totalReplacements += n;
    } else {
      const first = content.indexOf(oldS);
      if (first === -1) {
        return {
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
          path: abs,
        };
      }
      const second = content.indexOf(oldS, first + 1);
      if (second !== -1) {
        return {
          error:
            "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
          path: abs,
        };
      }
      recordHunk(first, oldS, newS);
      content = content.slice(0, first) + newS + content.slice(first + oldS.length);
      totalReplacements += 1;
    }
  }

  if (!ignorePlan && usePlanStore.getState().active) {
    usePlanStore.getState().enqueue({
      id: newQueuedEditId(),
      kind,
      path: abs,
      originalContent: original,
      proposedContent: content,
      isNewFile: false,
    });
    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: content.length,
      path: abs,
      ...totalLines(hunks),
      hunks,
    };
  }

  try {
    // Snapshot for restore-checkpoint. The first touch of a path captures
    // `originalContent` (the pre-turn state); subsequent edits refresh
    // `writtenContent` so the restore-time user-modify check compares
    // against the agent's latest write.
    if (sessionId) {
      recordFileMutation(sessionId, abs, {
        kind: "modify",
        originalContent: original,
        writtenContent: content,
      });
    }
    await native.writeFile(abs, content);
    notifyMemoryPathChanged(abs);
    notifySkillPathChanged(abs);
    // Edit keeps the directory entry but bumps mtime/size. Refresh so the
    // explorer's mtime and size columns stay accurate.
    dispatchFsRefreshForFile(abs);
    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: content.length,
      path: abs,
      ...totalLines(hunks),
      hunks,
    };
  } catch (err) {
    return { error: scrubErrorPath(err, ctx), path: abs };
  }
}

export function buildEditTools(
  ctx: ToolContext,
  opts: {
    autoApprove?: boolean;
    refuseOutOfScopeMutations?: boolean;
    ignorePlanMode?: boolean;
  } = {},
) {
  // Normally edit/multi_edit raise an approval card. An autonomous worker
  // subagent has no approver in its generateText loop, so it passes autoApprove
  // to execute directly (still guarded by checkWritable + read-before-edit +
  // checkpoint/restore). Default keeps approval on for the main agent.
  const approve = opts.autoApprove ? false : true;
  const refuseMut = opts.refuseOutOfScopeMutations ?? false;
  // Worker writes directly even in plan mode (its bash verify must see real files).
  const ignorePlan = opts.ignorePlanMode ?? false;
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires prior Read File (read-before-edit). old_string must be unique unless replace_all=true. Approval.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe("Exact substring to replace. Must be unique unless replace_all."),
        new_string: z.string().describe("Replacement substring."),
        replace_all: flexBoolOpt(),
      }),
      needsApproval: approve,
      execute: async ({ path, old_string, new_string, replace_all }) => {
        throwIfAborted(ctx);
        const abs = resolvePath(path, ctx.getCwd());
        if (refuseMut && isReadOutsideScope(path, ctx)) {
          return {
            error: "refused: a subagent may not mutate outside the workspace/cwd",
            path: abs,
          };
        }
        const safety = await checkWritableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        if (!ctx.readCache.has(abs)) {
          return {
            error: "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        return applyEdits(
          abs,
          [{ old_string, new_string, replace_all }],
          "edit",
          ctx.getSessionId(),
          ctx,
          ignorePlan,
        );
      },
      toModelOutput: ({ output }) => ({ type: "text", value: leanEditOutput(output) }),
    }),

    multi_edit: tool({
      description:
        "Apply N exact-string replacements to one file atomically. Aborts whole batch if any edit misses or is non-unique. Requires prior Read File. Approval.",
      inputSchema: z.object({
        path: z.string(),
        edits: flexArrayReq(
          z.object({
            old_string: z.string(),
            new_string: z.string(),
            replace_all: flexBoolOpt(),
          }),
        ).refine((arr) => arr.length >= 1, "edits must have at least one entry"),
      }),
      needsApproval: approve,
      execute: async ({ path, edits }) => {
        throwIfAborted(ctx);
        const abs = resolvePath(path, ctx.getCwd());
        if (refuseMut && isReadOutsideScope(path, ctx)) {
          return {
            error: "refused: a subagent may not mutate outside the workspace/cwd",
            path: abs,
          };
        }
        const safety = await checkWritableResolved(abs);
        if (!safety.ok) return { error: safety.reason, path: abs };
        if (!ctx.readCache.has(abs)) {
          return {
            error: "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        return applyEdits(abs, edits, "multi_edit", ctx.getSessionId(), ctx, ignorePlan);
      },
      toModelOutput: ({ output }) => ({ type: "text", value: leanEditOutput(output) }),
    }),
  } as const;
}
