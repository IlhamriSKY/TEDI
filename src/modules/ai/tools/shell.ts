import { tool } from "ai";
import { z } from "zod";
import { shellTransformersRegistry } from "@/modules/extensions/registries";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import {
  clampForModel,
  isReadOutsideScope,
  scrubErrorPath,
  throwIfAborted,
  type ToolContext,
} from "./context";
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

export function buildShellTools(ctx: ToolContext, opts: { autoApprove?: boolean } = {}) {
  // bash_run / bash_background normally raise an approval card. An autonomous
  // worker subagent has no approver in its generateText loop, so it passes
  // autoApprove to execute directly. Default keeps approval on for the main agent.
  const approve = opts.autoApprove ? false : true;
  // With no approver, the shell was the one tool that ignored the scope model
  // `fs` and `edit` enforce, so a prompt-injected worker could read a secret or
  // reach outside the project through it. Turn on the unattended checks for
  // exactly that case; an approved command from the main agent is unaffected.
  const shellGuard = opts.autoApprove
    ? { unattended: true, isOutsideScope: (p: string) => isReadOutsideScope(p, ctx) }
    : undefined;
  return {
    bash_run: tool({
      description:
        "Foreground shell command in this session's persistent agent shell. cwd persists across calls. Short-lived only (lint/test/build). Use Bash Background for dev servers / watchers. Never interactive (vim/less/top - hangs). Approval.",
      inputSchema: z.object({
        command: z.string(),
        timeout_secs: flexIntOpt({ min: 1, max: 300 }).describe(
          "Seconds before the command is killed (max 300). Omit for the default.",
        ),
      }),
      needsApproval: approve,
      execute: async ({ command, timeout_secs }) => {
        throwIfAborted(ctx);
        const safety = checkShellCommand(command, shellGuard);
        if (!safety.ok) return { error: safety.reason };
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        try {
          const cwd = ctx.getCwd();
          const shellId = await getSessionShell(sid, cwd);
          const effective = applyShellTransformers(command, "bash");
          const r = await native.shellSessionRun(shellId, effective, cwd, timeout_secs);
          // Trim head+tail before the output re-enters context every step; the
          // Rust side already hard-caps, this is the smaller model-facing trim.
          const stdout = clampForModel(r.stdout);
          const stderr = clampForModel(r.stderr);
          return {
            command,
            stdout,
            stderr,
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated || stdout !== r.stdout || stderr !== r.stderr,
            cwd_after: r.cwd_after,
          };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),

    bash_background: tool({
      description:
        "Spawn long-running process (dev server, watcher). Returns handle for Bash Logs/Bash Kill. Output in 4MB ring buffer. Approval.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().nullable().optional(),
      }),
      needsApproval: approve,
      execute: async ({ command, cwd }) => {
        throwIfAborted(ctx);
        const safety = checkShellCommand(command, shellGuard);
        if (!safety.ok) return { error: safety.reason };
        const effectiveCwd = cwd ?? ctx.getCwd();
        // `checkShellCommand` only inspects the command string, so an explicit
        // `cwd` was the one argument that reached the spawn unchecked - a
        // worker could run an in-scope command while rooted anywhere on disk.
        // Only enforced unattended; the main agent's approval card shows the
        // cwd and the human is the gate.
        if (shellGuard && cwd != null && shellGuard.isOutsideScope(cwd)) {
          return {
            error: `Refused: cwd "${cwd}" is outside the workspace, and this sub-agent runs without an approval prompt.`,
          };
        }
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
        "Read logs from a Bash Background handle. Pass since_offset (from previous next_offset) to tail incrementally.",
      inputSchema: z.object({
        handle: flexIntReq(),
        since_offset: flexIntOpt(),
      }),
      execute: async ({ handle, since_offset }) => {
        try {
          const r = await native.shellBgLogs(handle, since_offset);
          // The ring buffer holds up to 4MB; tail it before it floods context.
          // next_offset still points at the true stream position to resume from.
          const bytes = clampForModel(r.bytes);
          return bytes === r.bytes ? r : { ...r, bytes, truncated_for_model: true };
        } catch (e) {
          return { error: scrubErrorPath(e, ctx) };
        }
      },
    }),

    bash_list: tool({
      description:
        "List Bash Background processes (running + exited). Call BEFORE spawning a dev server to avoid duplicates - reuse the existing handle instead of re-spawning, and open its served URL with Open Preview if it's a server. Auto.",
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
      description: "Kill a Bash Background process by handle. Idempotent.",
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
