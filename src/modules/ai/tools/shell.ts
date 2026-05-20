import { tool } from "ai";
import { z } from "zod";
import { shellTransformersRegistry } from "@/modules/extensions/registries";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { scrubErrorPath, throwIfAborted, type ToolContext } from "./context";
import { flexIntOpt, flexIntReq } from "./schedule";

/**
 * Run every registered extension transformer over a command before it
 * hits the shell. Empty chain (no extension installed, or all disabled)
 * is a pure passthrough so the historical zero-overhead path is
 * preserved. `safety` is checked against the *user-authored* command
 * before transforming so transformers can never sneak past the denylist.
 *
 * Exported so `terminal.ts` (`run_in_terminal`, `suggest_command`) can
 * thread the same chain as `bash_run` / `bash_background`. One source
 * of truth keeps the user experience consistent across every AI shell
 * path.
 *
 * Example: with the `tedi.rtk-bridge` extension installed and active,
 * `git status` becomes `rtk git status`. With the extension removed,
 * the chain is empty and the command flows through unchanged.
 */
export function applyShellTransformers(
  command: string,
  kind: "bash" | "terminal",
): string {
  return shellTransformersRegistry.applyAll(command, kind);
}

/**
 * Per-session lazy shell-session id. The agent gets one persistent shell per
 * chat session, so cwd survives across tool calls (cd, mkdir+cd, etc).
 */
const sessionShells = new Map<string, Promise<number>>();

async function getSessionShell(sessionId: string, cwd: string | null): Promise<number> {
  let p = sessionShells.get(sessionId);
  if (!p) {
    p = native.shellSessionOpen(cwd);
    sessionShells.set(sessionId, p);
  }
  return p;
}

/**
 * Tear down the Rust-side shell session for `sessionId`. Called by the chat
 * store when a chat session is deleted so the long-lived shell handle does
 * not leak (each handle holds a child process + IO pipes on the Rust side).
 * Idempotent — extra calls are no-ops.
 */
export function disposeSessionShell(sessionId: string): void {
  const p = sessionShells.get(sessionId);
  if (!p) return;
  sessionShells.delete(sessionId);
  void p
    .then((id) => native.shellSessionClose(id))
    .catch(() => {
      // Already closed / never opened — nothing to do.
    });
}

export function buildShellTools(ctx: ToolContext) {
  return {
    bash_run: tool({
      description:
        "Foreground shell command in this session's persistent agent shell. cwd persists across calls. Short-lived only (lint/test/build). Use bash_background for dev servers / watchers. Never interactive (vim/less/top - hangs). Approval.",
      inputSchema: z.object({
        command: z.string(),
        timeout_secs: flexIntOpt({ min: 1, max: 300 }),
      }),
      needsApproval: true,
      execute: async ({ command, timeout_secs }) => {
        throwIfAborted(ctx);
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        try {
          const cwd = ctx.getCwd();
          const shellId = await getSessionShell(sid, cwd);
          const effective = applyShellTransformers(command, "bash");
          const r = await native.shellSessionRun(shellId, effective, cwd, timeout_secs);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated,
            cwd_after: r.cwd_after,
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),

    bash_background: tool({
      description:
        "Spawn long-running process (dev server, watcher). Returns handle for bash_logs/bash_kill. Output in 4MB ring buffer. Approval.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().nullable().optional(),
      }),
      needsApproval: true,
      execute: async ({ command, cwd }) => {
        throwIfAborted(ctx);
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const effectiveCwd = cwd ?? ctx.getCwd();
        try {
          const handle = await native.shellBgSpawn(
            applyShellTransformers(command, "bash"),
            effectiveCwd,
          );
          return { handle, command, cwd: effectiveCwd, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),

    bash_logs: tool({
      description:
        "Read logs from a bash_background handle. Pass since_offset (from previous next_offset) to tail incrementally.",
      inputSchema: z.object({
        handle: flexIntReq(),
        since_offset: flexIntOpt(),
      }),
      execute: async ({ handle, since_offset }) => {
        try {
          const r = await native.shellBgLogs(handle, since_offset);
          return r;
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),

    bash_list: tool({
      description:
        "List bash_background processes (running + exited). Call BEFORE spawning a dev server to avoid duplicates — reuse running matches via open_preview. Auto.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const list = await native.shellBgList();
          return { processes: list };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),

    bash_kill: tool({
      description: "Kill a bash_background process by handle. Idempotent.",
      inputSchema: z.object({ handle: flexIntReq() }),
      execute: async ({ handle }) => {
        try {
          await native.shellBgKill(handle);
          return { handle, ok: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),
  } as const;
}
