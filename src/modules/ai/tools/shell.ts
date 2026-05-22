import { tool } from "ai";
import { z } from "zod";
import { shellTransformersRegistry } from "@/modules/extensions/registries";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { scrubErrorPath, throwIfAborted, type ToolContext } from "./context";
import { flexIntOpt, flexIntReq } from "./schedule";

/**
 * Run registered extension transformers over a command before it hits the
 * shell. Empty chain is a pure passthrough. Safety checks run against the
 * user-authored command so transformers can't bypass the denylist.
 *
 * Exported so terminal.ts uses the same chain as bash_run / bash_background.
 *
 * Example: with `tedi.rtk-bridge` active, `git status` becomes `rtk git status`.
 */
export function applyShellTransformers(
  command: string,
  kind: "bash" | "terminal",
): string {
  return shellTransformersRegistry.applyAll(command, kind);
}

/** Per-session lazy shell id. One persistent shell per chat session so cwd
 *  survives across tool calls. */
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
 * Tear down the Rust-side shell session for `sessionId`. Idempotent. Called
 * on chat-session delete so the child process and IO pipes don't leak.
 */
export function disposeSessionShell(sessionId: string): void {
  const p = sessionShells.get(sessionId);
  if (!p) return;
  sessionShells.delete(sessionId);
  void p
    .then((id) => native.shellSessionClose(id))
    .catch(() => {
      // Already closed or never opened.
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
