import { tool } from "ai";
import { z } from "zod";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";

export function buildTerminalTools(ctx: ToolContext) {
  return {
    suggest_command: tool({
      description:
        "Type a single shell command into the user's active terminal at the prompt - WITHOUT executing it. Use this when the answer to the user's question IS a command (e.g. 'ffmpeg one-liner for X', 'git command to undo Y'). Prefer this over prose. Do NOT include a trailing newline.",
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
        const trimmed = command.replace(/\n+$/, "");
        const ok = ctx.injectIntoActivePty(trimmed);
        if (!ok)
          return {
            error: "no active terminal to inject into",
            command: trimmed,
          };
        return { command: trimmed, explanation, injected: true };
      },
    }),

    read_terminal: tool({
      description:
        "Read the focused terminal tab's scrollback (prompt + input + output). Use when the user refers to something they see in the terminal. Null when active tab isn't a terminal. Auto-executes.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Lines to return (default 300, max 2000)."),
      }),
      execute: async ({ lines }) => {
        const buffer = ctx.getTerminalContext(lines);
        if (buffer === null) return { error: "no active terminal tab", buffer: null };
        return { buffer, cwd: ctx.getCwd(), lines: lines ?? 300 };
      },
    }),

    open_terminal: tool({
      description:
        "Open a new terminal tab. Inherits workspace root unless `cwd` is given. Needs approval.",
      inputSchema: z.object({
        cwd: z.string().nullable().optional().describe("Absolute path; omit for inherited cwd."),
      }),
      needsApproval: true,
      execute: async ({ cwd }) => {
        const ok = ctx.openTerminal(cwd ?? null);
        if (!ok) return { error: "could not open a new terminal tab" };
        return { ok: true, cwd: cwd ?? null };
      },
    }),

    run_in_terminal: tool({
      description:
        "Submit a command into the focused visible terminal (Enter appended). Output stays in the user's tab — use `read_terminal` afterwards if you need to see it. Different from `bash_run` (hidden agent shell, returns output to you). Needs approval.",
      inputSchema: z.object({
        command: z.string().describe("Command to submit. No trailing newline."),
      }),
      needsApproval: true,
      execute: async ({ command }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const trimmed = command.replace(/[\r\n]+$/, "");
        const ok = ctx.runInActiveTerminal(trimmed);
        if (!ok) return { error: "no active terminal tab to run in", command: trimmed };
        return { command: trimmed, submitted: true };
      },
    }),

    open_preview: tool({
      description:
        "Open a preview tab (in-app iframe) at the given URL. Use this after starting a dev server (e.g. `pnpm dev`, `npm run dev`) to surface the rendered page next to the terminal. Localhost URLs work best; arbitrary external sites may be blocked by X-Frame-Options.",
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
