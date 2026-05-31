import { tool } from "ai";
import { z } from "zod";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";
import {
  SHARED_TARGET_SCHEMA,
  flexBoolOpt,
  flexIntOpt,
  normalizeTargetExternal,
} from "./schedule";
import { applyShellTransformers } from "./shell";

export function buildTerminalTools(ctx: ToolContext) {
  return {
    suggest_command: tool({
      description:
        "Type a shell command into the user's active terminal WITHOUT running it. Use when the answer IS a command. No trailing newline. Refuses if the active terminal is busy (command running or TUI on the alt-screen); in that case a fresh split is opened for you, retry next step.",
      inputSchema: z.object({
        command: z.string().describe("The shell command. No trailing newline."),
        explanation: z
          .string()
          .optional()
          .describe(
            "Optional one-line note shown alongside in the chat log (not in the terminal).",
          ),
      }),
      execute: async ({ command, explanation }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const trimmed = command.replace(/[\r\n]+$/, "");
        // suggest_command TYPES into the terminal via a raw PTY write (no
        // bracketed-paste wrapper), so an embedded \n/\r would auto-run every
        // line with no approval. A type-only command never needs an interior
        // newline; multi-line execution must go through the approval-gated
        // run_in_terminal.
        if (/[\r\n]/.test(trimmed)) {
          return {
            error:
              "Refused: command contains an embedded newline. suggest_command only types a single line without running it. Use run_in_terminal (which requires approval) to execute a multi-line command.",
          };
        }
        const effective = applyShellTransformers(trimmed, "terminal");

        if (!ctx.isTerminalBusy()) {
          const ok = ctx.injectIntoActivePty(effective);
          if (!ok)
            return { error: "no active terminal to inject into", command: trimmed };
          return { command: trimmed, explanation, injected: true };
        }

        // Active terminal is busy. Open a fresh split (fall back to a new
        // tab if the per-tab pane cap is hit) and tell the model to retry
        // next step. The new terminal becomes active so the retry targets
        // it. We don't auto-inject here: the new TerminalPane needs a render
        // tick to mount and the PTY a moment more to open, so writes done in
        // this same tick land in the void.
        let spawn = ctx.openTerminalAdvanced({ mode: "split", splitDir: "row" });
        if (!spawn.ok) spawn = ctx.openTerminalAdvanced({ mode: "tab" });
        if (!spawn.ok)
          return {
            error: `active terminal is busy and could not open a new one: ${spawn.error}`,
            command: trimmed,
          };
        return {
          error:
            "active terminal is busy (command running or TUI on the alt-screen). Opened a new terminal as the active tab; call suggest_command again to inject there.",
          command: trimmed,
          explanation,
          opened_new_terminal: true,
          tab_id: spawn.tabId,
          leaf_id: spawn.leafId,
          mode: spawn.mode,
        };
      },
    }),

    read_terminal: tool({
      description:
        "Read focused terminal scrollback. Use when user refers to terminal output. Null if active tab isn't terminal. Auto.",
      inputSchema: z.object({
        lines: flexIntOpt({ min: 1, max: 2000 }).describe(
          "Lines to return (default 300, max 2000).",
        ),
      }),
      execute: async ({ lines }) => {
        const buffer = ctx.getTerminalContext(lines);
        if (buffer === null) return { error: "no active terminal tab", buffer: null };
        return { buffer, cwd: ctx.getCwd(), lines: lines ?? 300 };
      },
    }),

    open_terminal: tool({
      description:
        'Open N terminals. mode="tab" → new group; mode="split" + target_tab_id → add splits to that tab. count>1 keeps subsequent opens in the first opened tab. Cap 6/tab. Approval.',
      inputSchema: z.object({
        cwd: z
          .string()
          .nullable()
          .optional()
          .describe("Absolute path; omit for inherited cwd."),
        mode: z
          .enum(["tab", "split"])
          .nullable()
          .optional()
          .describe('"tab" (default) opens a new top-level tab, "split" splits an existing tab.'),
        split_dir: z
          .enum(["row", "col"])
          .nullable()
          .optional()
          .describe('"row" puts the new pane to the right; "col" puts it below. Default "row". Used for the first open when mode="split", and for every subsequent split when count>1.'),
        target_tab_id: flexIntOpt().describe(
          'Used when mode="split". Tab id from env\'s `terminals:` list. Omit to split the active tab.',
        ),
        count: flexIntOpt({ min: 1, max: 6 }).describe(
          "How many terminals to open in this batch. Default 1. With count>1, subsequent opens split into the tab where the first one landed.",
        ),
      }),
      needsApproval: true,
      execute: async ({ cwd, mode, split_dir, target_tab_id, count }) => {
        const n = count ?? 1;
        const baseMode = mode ?? "tab";
        const dir = split_dir ?? "row";
        const cwdResolved = cwd ?? null;

        const results: Array<
          | { ok: true; tab_id: number; leaf_id: number | null; mode: "tab" | "split" }
          | { ok: false; error: string }
        > = [];
        let groupTabId: number | null = null;

        for (let i = 0; i < n; i++) {
          const useMode: "tab" | "split" = i === 0 ? baseMode : "split";
          const useTarget = i === 0 ? (target_tab_id ?? null) : groupTabId;
          const r = ctx.openTerminalAdvanced({
            cwd: cwdResolved,
            mode: useMode,
            splitDir: dir,
            targetTabId: useTarget,
          });
          if (r.ok) {
            if (i === 0) groupTabId = r.tabId;
            results.push({
              ok: true,
              tab_id: r.tabId,
              leaf_id: r.leafId,
              mode: r.mode,
            });
          } else {
            results.push({ ok: false, error: r.error });
            // Stop early on first failure - usually MAX_PANES_PER_TAB hit.
            break;
          }
        }

        const opened = results.filter((r) => r.ok).length;
        if (opened === 0) {
          return {
            error: results[0] && !results[0].ok ? results[0].error : "no terminal opened",
            requested: n,
            results,
          };
        }
        return {
          ok: true,
          opened,
          requested: n,
          tab_id: groupTabId,
          mode: baseMode,
          results,
        };
      },
    }),

    consolidate_terminals: tool({
      description:
        "Merge every open terminal into one tab. Optional target picks the destination tab (default = first terminal's tab). Refuses if total > 6 panes. Approval.",
      inputSchema: z.object({
        target: SHARED_TARGET_SCHEMA.describe(
          "Optional: pick which terminal's tab becomes the group. Default = first terminal's tab.",
        ),
      }),
      needsApproval: true,
      execute: async ({ target }) => {
        const terms = ctx.listTerminals();
        if (terms.length === 0) return { error: "no terminals open" };
        if (terms.length === 1) return { error: "only one terminal - nothing to consolidate" };

        const t = normalizeTargetExternal(target);
        let targetTabId: number | null = null;
        if (typeof t.tabId === "number" && terms.some((r) => r.tabId === t.tabId))
          targetTabId = t.tabId;
        if (targetTabId === null && typeof t.leafId === "number") {
          const hit = terms.find((r) => r.leafId === t.leafId);
          if (hit) targetTabId = hit.tabId;
        }
        if (targetTabId === null && typeof t.ordinal === "number") {
          const hit = terms.find((r) => r.ordinal === t.ordinal);
          if (hit) targetTabId = hit.tabId;
        }
        if (targetTabId === null && typeof t.title === "string" && t.title) {
          const needle = t.title.toLowerCase();
          const hit = terms.find((r) => r.title.toLowerCase().includes(needle));
          if (hit) targetTabId = hit.tabId;
        }
        if (targetTabId === null) targetTabId = terms[0].tabId;

        const r = ctx.consolidateTerminalsIntoGroup(targetTabId);
        if (!r.ok) return { error: r.error, moved_before_failure: r.movedBeforeFailure };
        return {
          ok: true,
          target_tab_id: r.targetTabId,
          moved: r.moved,
          already_in_group: r.alreadyInGroup,
        };
      },
    }),

    close_terminal: tool({
      description:
        "Close terminals. `target`=one (active if omitted), `targets`=array (resolved before closing), `all`=every (last leaf is kept). Approval.",
      inputSchema: z.object({
        target: SHARED_TARGET_SCHEMA,
        targets: z
          .preprocess(
            (v) => {
              if (v === null) return undefined;
              if (typeof v !== "string") return v;
              try {
                return JSON.parse(v);
              } catch {
                return v;
              }
            },
            z.array(SHARED_TARGET_SCHEMA).optional(),
          )
          .describe("Array form: close multiple terminals atomically."),
        all: flexBoolOpt().describe(
          "Set true to close every terminal (the very last leaf is kept).",
        ),
      }),
      needsApproval: true,
      execute: async ({ target, targets, all }) => {
        const terms = ctx.listTerminals();
        if (terms.length === 0) return { error: "no terminals open" };

        const resolveOne = (raw: unknown): number | null => {
          const t = normalizeTargetExternal(raw);
          if (typeof t.leafId === "number") {
            const hit = terms.find((r) => r.leafId === t.leafId);
            return hit ? hit.leafId : null;
          }
          if (typeof t.ordinal === "number") {
            const hit = terms.find((r) => r.ordinal === t.ordinal);
            return hit ? hit.leafId : null;
          }
          if (typeof t.tabId === "number") {
            const hit =
              terms.find((r) => r.tabId === t.tabId && r.isActive) ??
              terms.find((r) => r.tabId === t.tabId);
            return hit ? hit.leafId : null;
          }
          if (typeof t.title === "string" && t.title) {
            const needle = t.title.toLowerCase();
            const hit = terms.find((r) => r.title.toLowerCase().includes(needle));
            return hit ? hit.leafId : null;
          }
          return null;
        };

        let leafIds: number[] = [];
        if (all === true) {
          leafIds = terms.map((r) => r.leafId);
        } else if (Array.isArray(targets) && targets.length > 0) {
          for (const t of targets) {
            const id = resolveOne(t);
            if (id !== null) leafIds.push(id);
          }
        } else if (target !== undefined && target !== null) {
          const id = resolveOne(target);
          if (id !== null) leafIds.push(id);
        } else {
          const active = terms.find((r) => r.isActive);
          if (active) leafIds.push(active.leafId);
        }
        leafIds = [...new Set(leafIds)];
        if (leafIds.length === 0) return { error: "no target terminal resolved" };

        const results = leafIds.map((id) => {
          const r = ctx.closeTerminalLeaf(id);
          return { leaf_id: id, ...r };
        });
        const closed = results.filter((r) => r.ok).length;
        return {
          ok: closed > 0,
          closed,
          requested: leafIds.length,
          results,
        };
      },
    }),

    run_in_terminal: tool({
      description:
        "Submit a command into the focused terminal (Enter appended). Output stays in user's tab; use read_terminal after if needed. Different from bash_run (hidden shell). Refuses if the active terminal is busy (command running or TUI on the alt-screen); in that case a fresh split is opened for you, retry next step. Approval.",
      inputSchema: z.object({
        command: z.string().describe("Command to submit. No trailing newline."),
      }),
      needsApproval: true,
      execute: async ({ command }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const trimmed = command.replace(/[\r\n]+$/, "");
        const effective = applyShellTransformers(trimmed, "terminal");

        if (!ctx.isTerminalBusy()) {
          const ok = ctx.runInActiveTerminal(effective);
          if (!ok) return { error: "no active terminal tab to run in", command: trimmed };
          return { command: trimmed, submitted: true };
        }

        // Active terminal is busy. Open a fresh split (fall back to a new
        // tab if the per-tab pane cap is hit) and report; the new terminal
        // becomes active so the retry targets it. We don't auto-submit here:
        // the new TerminalPane needs a render tick to mount and the PTY a
        // moment more to open, so writes done in this same tick land in
        // the void.
        let spawn = ctx.openTerminalAdvanced({ mode: "split", splitDir: "row" });
        if (!spawn.ok) spawn = ctx.openTerminalAdvanced({ mode: "tab" });
        if (!spawn.ok)
          return {
            error: `active terminal is busy and could not open a new one: ${spawn.error}`,
            command: trimmed,
          };
        return {
          error:
            "active terminal is busy (command running or TUI on the alt-screen). Opened a new terminal as the active tab; call run_in_terminal again to submit there.",
          command: trimmed,
          opened_new_terminal: true,
          tab_id: spawn.tabId,
          leaf_id: spawn.leafId,
          mode: spawn.mode,
        };
      },
    }),

    open_preview: tool({
      description:
        "Open in-app iframe preview at URL. Use after starting a dev server. Localhost preferred (external sites may be blocked by X-Frame-Options).",
      inputSchema: z.object({
        url: z
          .url()
          .describe("Full URL to load (e.g. http://localhost:5173). Must include scheme."),
      }),
      execute: async ({ url }) => {
        const ok = ctx.openPreview(url);
        if (!ok) return { error: "preview surface unavailable", url };
        return { url, ok: true };
      },
    }),
  } as const;
}
