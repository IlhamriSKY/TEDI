import { tool } from "ai";
import { z } from "zod";
import { scheduler } from "@/modules/scheduler";
import type { TerminalTarget } from "@/modules/scheduler/types";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";
import { applyShellTransformers } from "./shell";

/**
 * Some providers serialize nested arg objects as JSON strings or stringify
 * numbers. These coercers normalize each value before zod validates so the
 * model doesn't waste a retry on a validation error.
 */
function coerceJsonObject(v: unknown): unknown {
  if (v === null) return undefined;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return v;
  }
}

function coerceNumber(v: unknown): unknown {
  if (v === null) return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

function coerceInt(v: unknown): unknown {
  if (v === null) return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && Number.isInteger(n) ? n : v;
  }
  return v;
}

function coerceBool(v: unknown): unknown {
  if (v === null) return undefined;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "") return undefined;
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return v;
}

/** Optional int that tolerates stringified numbers and explicit null.
 *  Output is `number | undefined`. */
export function flexIntOpt(opts: { min?: number; max?: number } = {}) {
  let inner = z.number().int();
  if (opts.min !== undefined) inner = inner.min(opts.min);
  if (opts.max !== undefined) inner = inner.max(opts.max);
  return z.preprocess(coerceInt, inner.optional());
}

/** Required version of flexIntOpt. */
export function flexIntReq(opts: { min?: number; max?: number } = {}) {
  let inner = z.number().int();
  if (opts.min !== undefined) inner = inner.min(opts.min);
  if (opts.max !== undefined) inner = inner.max(opts.max);
  return z.preprocess(coerceInt, inner);
}

/** Optional boolean. Accepts "true"/"false"/"1"/"0" and null. */
export function flexBoolOpt() {
  return z.preprocess(coerceBool, z.boolean().optional());
}

/** Array schema that parses JSON-stringified input first. Required variant. */
export function flexArrayReq<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(coerceJsonObject, z.array(item));
}

/** Optional array. null -> undefined, JSON string -> parsed array. */
export function flexArrayOpt<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(coerceJsonObject, z.array(item).optional());
}

/** Object schema that parses JSON-stringified input first. */
export function flexObjectOpt<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(coerceJsonObject, z.object(shape).optional());
}

const targetObjectSchema = z
  .object({
    leaf_id: flexIntOpt(),
    tab_id: flexIntOpt(),
    ordinal: flexIntOpt({ min: 1 }),
    title: z.string().nullable().optional(),
  })
  .strict();

/** Accepts an object or a JSON-stringified object. */
const targetSchema = z
  .preprocess(coerceJsonObject, targetObjectSchema.optional())
  .describe(
    "Pick ONE field: { ordinal } > { leaf_id } > { tab_id } > { title }. Omit to target the focused terminal.",
  );

const flexNumber = (max: number) =>
  z.preprocess(coerceNumber, z.number().min(0).max(max).optional());

function normalizeTarget(input: unknown): TerminalTarget {
  if (!input || typeof input !== "object") return {};
  const i = input as Record<string, unknown>;
  const out: TerminalTarget = {};
  if (typeof i.leaf_id === "number") out.leafId = i.leaf_id;
  if (typeof i.tab_id === "number") out.tabId = i.tab_id;
  if (typeof i.ordinal === "number") out.ordinal = i.ordinal;
  if (typeof i.title === "string" && i.title.trim()) out.title = i.title.trim();
  return out;
}

export function buildScheduleTools(ctx: ToolContext) {
  return {
    list_terminals: tool({
      description:
        "List open terminals (ordinal, tab_id, leaf_id, title, cwd). Use when the env block is stale or you need fresh detail. Auto.",
      inputSchema: z.object({}),
      execute: async () => {
        const terms = ctx.listTerminals();
        if (terms.length === 0) return { terminals: [] };
        return { terminals: terms };
      },
    }),

    send_to_terminal: tool({
      description:
        "Type text into a specific terminal at the prompt (no Enter). Use for pre-filling so the user can edit before running.",
      inputSchema: z.object({
        text: z.string().describe("Text to type. No trailing newline."),
        target: targetSchema,
      }),
      execute: async ({ text, target }) => {
        const safety = checkShellCommand(text);
        if (!safety.ok) return { error: safety.reason };
        const trimmed = text.replace(/[\r\n]+$/, "");
        // Raw PTY write with no bracketed-paste wrapper: an embedded newline
        // would auto-run the following lines with no approval. Type-only text
        // never needs one; use run_in_terminal_by_id (approval-gated) to run.
        if (/[\r\n]/.test(trimmed)) {
          return {
            error:
              "Refused: text contains an embedded newline. send_to_terminal only types without running. Use run_in_terminal_by_id (which requires approval) to execute.",
          };
        }
        // Route through the shell-transformer chain (e.g. RTK) like every other
        // CLI tool, then re-guard newlines: a transformer that injects one would
        // auto-run lines via the raw (no-bracketed-paste) PTY write.
        const effective = applyShellTransformers(trimmed, "terminal");
        if (/[\r\n]/.test(effective)) {
          return {
            error:
              "Refused: a shell transformer introduced a newline. send_to_terminal only types a single line without running it.",
          };
        }
        const t = normalizeTarget(target);
        const ok = ctx.injectIntoTerminal(t, effective);
        if (!ok) return { error: "target terminal not found", text: trimmed };
        return { text: trimmed, injected: true, target: t };
      },
    }),

    run_in_terminal_by_id: tool({
      description:
        "Submit a command (Enter appended) into a specific terminal. Output stays in that user-visible terminal. Needs approval.",
      inputSchema: z.object({
        command: z.string().describe("Command. No trailing newline."),
        target: targetSchema,
      }),
      needsApproval: true,
      execute: async ({ command, target }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const trimmed = command.replace(/[\r\n]+$/, "");
        const t = normalizeTarget(target);
        // Don't write into a terminal mid-command / mid-TUI: it would corrupt the
        // running program's input instead of submitting a fresh command.
        if (ctx.isTerminalBusy(t)) {
          return {
            error:
              "target terminal is busy (a command is running or a full-screen TUI is open); wait for it to finish or target another terminal.",
            command: trimmed,
          };
        }
        const effective = applyShellTransformers(trimmed, "terminal");
        const ok = ctx.runInTerminal(t, effective);
        if (!ok) return { error: "target terminal not found", command: trimmed };
        return { command: trimmed, submitted: true, target: t };
      },
    }),

    schedule_command: tool({
      description:
        'Queue a future command. Parse time (any language) → delay_seconds OR fire_at_iso. action="submit" runs (default), "inject" only types. Approval.',
      inputSchema: z.object({
        command: z.string().min(1),
        delay_seconds: flexNumber(60 * 60 * 24 * 30).describe(
          "Seconds from now until fire. Mutually exclusive with fire_at_iso.",
        ),
        fire_at_iso: z
          .string()
          .nullable()
          .optional()
          .describe("Absolute ISO-8601 timestamp. Mutually exclusive with delay_seconds."),
        action: z
          .enum(["inject", "submit"])
          .nullable()
          .optional()
          .describe('"submit" (default) runs the command. "inject" only types.'),
        target: targetSchema,
        label: z.string().nullable().optional(),
      }),
      needsApproval: true,
      execute: async ({ command, delay_seconds, fire_at_iso, action, target, label }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const trimmed = command.replace(/[\r\n]+$/, "");
        const effectiveAction = action ?? "submit";
        // An "inject" schedule types without Enter; an embedded newline would
        // auto-run the following lines at fire time with no re-approval. ("submit"
        // is meant to run, so a multi-line script is allowed there.)
        if (effectiveAction === "inject" && /[\r\n]/.test(trimmed)) {
          return {
            error:
              'Refused: an inject schedule types without running, so it cannot contain a newline. Use action:"submit" to run a multi-line command.',
          };
        }
        // Route through the shell-transformer chain (e.g. RTK) so a scheduled
        // command runs the same rewritten form as an immediate one. Re-guard the
        // inject case against a transformer-introduced newline.
        const effectiveCommand = applyShellTransformers(trimmed, "terminal");
        if (effectiveAction === "inject" && /[\r\n]/.test(effectiveCommand)) {
          return {
            error:
              "Refused: a shell transformer introduced a newline; an inject schedule cannot run extra lines.",
          };
        }

        let fireAt: number;
        if (typeof delay_seconds === "number" && delay_seconds >= 0) {
          fireAt = Date.now() + Math.round(delay_seconds * 1000);
        } else if (typeof fire_at_iso === "string" && fire_at_iso.trim()) {
          const ms = Date.parse(fire_at_iso);
          if (Number.isNaN(ms)) return { error: `could not parse fire_at_iso "${fire_at_iso}".` };
          fireAt = ms;
        } else {
          return { error: "supply delay_seconds (relative) or fire_at_iso (absolute)." };
        }
        if (fireAt < Date.now() - 1000)
          return { error: `fireAt is in the past (${new Date(fireAt).toISOString()}).` };

        const t = normalizeTarget(target);
        const schedule = await scheduler.create({
          fireAt,
          command: effectiveCommand,
          action: effectiveAction,
          target: t,
          label: label?.trim() || undefined,
        });
        return {
          id: schedule.id,
          fireAt: new Date(schedule.fireAt).toISOString(),
          fireInSeconds: Math.round((schedule.fireAt - Date.now()) / 1000),
          command: schedule.command,
          action: schedule.action,
          target: schedule.target,
          label: schedule.label,
        };
      },
    }),

    list_schedules: tool({
      description: "List all pending + recent scheduled commands. Auto.",
      inputSchema: z.object({}),
      execute: async () => {
        const items = scheduler.getAll().map((s) => ({
          id: s.id,
          status: s.status,
          fireAt: new Date(s.fireAt).toISOString(),
          fireInSeconds: s.status === "pending" ? Math.round((s.fireAt - Date.now()) / 1000) : null,
          command: s.command,
          action: s.action,
          target: s.target,
          label: s.label,
          firedAt: s.firedAt ? new Date(s.firedAt).toISOString() : null,
          error: s.error,
        }));
        return { schedules: items };
      },
    }),

    cancel_schedule: tool({
      description: "Cancel a pending schedule by id (from List Schedules). Auto.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const ok = await scheduler.cancel(id);
        if (!ok) return { error: "no pending schedule with that id" };
        return { id, cancelled: true };
      },
    }),
  } as const;
}

/** Exposed so other tool files reuse the same coercion. */
export const SHARED_TARGET_SCHEMA = targetSchema;
export const normalizeTargetExternal = normalizeTarget;
