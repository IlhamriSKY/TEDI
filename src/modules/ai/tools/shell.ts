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
 * shell. Empty chain is a pure passthrough.
 *
 * Exported so terminal.ts uses the same chain as bash_run / bash_background.
 *
 * Example: with `tedi.rtk-bridge` active, `git status` becomes `rtk git status`.
 *
 * PREFER `checkedShellCommand` BELOW. Calling this directly and running the
 * result is what let a transformer past the denylist; this stays exported only
 * for callers that transform something they are not about to execute.
 */
export function applyShellTransformers(command: string, kind: "bash" | "terminal"): string {
  return shellTransformersRegistry.applyAll(command, kind);
}

/**
 * Transform a command and vet what will ACTUALLY run.
 *
 * The old order was: check the model's command, transform it, run the transform.
 * The header here used to claim that checking the user-authored command is what
 * stops "transformers bypassing the denylist", which has it exactly backwards -
 * the denylist never saw the string that reached the shell. An extension holding
 * `shell:transform` rewrites every command the agent runs, and seven call sites
 * across `shell.ts`, `terminal.ts` and `schedule.ts` all had the same gap.
 *
 * Both strings are checked, and the order is deliberate. The RAW check runs
 * first so a refusal quotes what the model wrote, which is what it can act on;
 * the EFFECTIVE check is the one that actually guards execution. When no
 * transformer is installed the two are identical and the second is free.
 */
export function checkedShellCommand(
  command: string,
  kind: "bash" | "terminal",
  guard?: Parameters<typeof checkShellCommand>[1],
): { ok: true; command: string } | { ok: false; error: string } {
  const raw = checkShellCommand(command, guard);
  if (!raw.ok) return { ok: false, error: raw.reason };

  const effective = applyShellTransformers(command, kind);
  if (effective === command) return { ok: true, command: effective };

  const after = checkShellCommand(effective, guard);
  if (!after.ok) {
    return {
      ok: false,
      error: `A shell transformer rewrote this command into something refused: ${after.reason} (ran as: ${effective})`,
    };
  }
  return { ok: true, command: effective };
}

/** Per-session lazy shell id. One persistent shell per chat session so cwd
 *  survives across tool calls. */
const sessionShells = new Map<string, Promise<number>>();

async function getSessionShell(sessionId: string, cwd: string | null): Promise<number> {
  let p = sessionShells.get(sessionId);
  if (!p) {
    // Evict a REJECTED open before anyone awaits it again. Caching the promise
    // is what makes the shell persistent, but caching a failed one made a single
    // transient spawn error permanent: every later bash_run in the session
    // re-awaited the same rejection and the shell could never come back.
    p = native.shellSessionOpen(cwd);
    const pending = p;
    void p.catch(() => {
      if (sessionShells.get(sessionId) === pending) sessionShells.delete(sessionId);
    });
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
        const vetted = checkedShellCommand(command, "bash", shellGuard);
        if (!vetted.ok) return { error: vetted.error };
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        try {
          const cwd = ctx.getCwd();
          const shellId = await getSessionShell(sid, cwd);
          const r = await native.shellSessionRun(shellId, vetted.command, cwd, timeout_secs);
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
        const vetted = checkedShellCommand(command, "bash", shellGuard);
        if (!vetted.ok) return { error: vetted.error };
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
          const handle = await native.shellBgSpawn(vetted.command, effectiveCwd);
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
