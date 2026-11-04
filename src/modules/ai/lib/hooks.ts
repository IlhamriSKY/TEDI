/**
 * Hooks: the user's own shell commands around the agent's tools.
 *
 *   PreToolUse   before a tool runs. Exit 2 blocks the call, and stderr tells the model why. So does
 *                a hook that timed out or could not start.
 *   PostToolUse  after it ran. A non-zero exit shows the output to the model (a failed lint).
 *   Stop         when a turn ends. Nothing reads its result.
 *
 * ONLY FROM SETTINGS. A hook runs with no card, so a hook file in a repository would be code that
 * runs on opening a chat there. They live in `aiHooks`, which is in `AGENT_DENIED_PREFS`, so neither
 * a repository nor an agent can add one.
 *
 * The call reaches the hook as environment variables, never in the command text: a tool's input is
 * written by the model, and pasting it into a shell line would run whatever it contains.
 *
 * shortcut: a Stop hook cannot send the agent back to work, upgrade when a real hook needs it (it
 * has to bound the loop the way /goal does).
 */
import type { ToolSet } from "ai";
import type { AiHook } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { native } from "./native";

const HOOK_TIMEOUT_SECS = 30;
/** Windows caps one environment block near 32 KB. */
const INPUT_CHARS = 16_000;
const OUTPUT_CHARS = 4_000;

type HookCwd = () => string | null | undefined;

/** What a hook's `tool` is matched against: the tool, and for `tedi` also `tedi:<verb>`. */
export function hookMatches(
  hook: AiHook,
  event: AiHook["event"],
  tool: string,
  input: unknown,
): boolean {
  if (hook.event !== event) return false;
  if (!hook.tool || hook.tool === "*") return true;
  const verb = tool === "tedi" ? (input as { verb?: unknown } | null)?.verb : undefined;
  const names = typeof verb === "string" ? [tool, `tedi:${verb}`] : [tool];
  return hook.tool.split("|").some((want) => names.includes(want.trim()));
}

/** The environment a hook reads. Pure, so a verify can pin that the input stays out of the command. */
export function hookEnv(event: string, tool: string, input: unknown): Record<string, string> {
  const path = (input as { path?: unknown } | null)?.path;
  const json = JSON.stringify(input) ?? "";
  return {
    TEDI_HOOK_EVENT: event,
    TEDI_TOOL: tool,
    // Never half an emoji: a lone surrogate cannot cross into Rust, and the hook would not run.
    TEDI_TOOL_INPUT: json.slice(0, INPUT_CHARS).replace(/[\uD800-\uDBFF]$/, ""),
    // A guard searching the input has to be able to tell it did not see all of it.
    TEDI_TOOL_INPUT_TRUNCATED: json.length > INPUT_CHARS ? "1" : "",
    TEDI_FILE: typeof path === "string" ? path : "",
  };
}

async function fire(
  hook: AiHook,
  event: AiHook["event"],
  tool: string,
  input: unknown,
  cwd: HookCwd,
): Promise<{ code: number | null; text: string }> {
  try {
    const r = await native.runCommand(
      hook.command,
      cwd() ?? null,
      HOOK_TIMEOUT_SECS,
      hookEnv(event, tool, input),
    );
    const text = [r.stderr, r.stdout].filter(Boolean).join("\n").trim().slice(0, OUTPUT_CHARS);
    return {
      code: r.timed_out ? null : r.exit_code,
      text: text || (r.timed_out ? "timed out" : ""),
    };
  } catch (e) {
    return { code: null, text: e instanceof Error ? e.message : String(e) };
  }
}

/** The tools with the user's hooks around them. The same object when there are none. */
export function withHooks<T extends ToolSet>(tools: T, cwd: HookCwd): T {
  const hooks = usePreferencesStore.getState().aiHooks;
  if (!hooks.some((h) => h.event !== "Stop")) return tools;
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (!execute) {
      out[name] = t;
      continue;
    }
    const inner = t.toModelOutput as ((o: { output: unknown }) => unknown) | undefined;
    out[name] = {
      ...t,
      execute: async (input: unknown, options: never) => {
        for (const hook of hooks) {
          if (!hookMatches(hook, "PreToolUse", name, input)) continue;
          const r = await fire(hook, "PreToolUse", name, input, cwd);
          // A guard that could not answer is not a guard that said yes.
          if (r.code === 2 || r.code === null) {
            return { error: `Blocked by a hook: ${r.text || hook.command}` };
          }
        }
        // The hooks can take a while, and file tools do not look at Stop themselves.
        if ((options as { abortSignal?: AbortSignal } | undefined)?.abortSignal?.aborted) {
          return { error: "Stopped by the user." };
        }
        const output = await (execute as (i: unknown, o: never) => unknown)(input, options);
        const notes: string[] = [];
        for (const hook of hooks) {
          if (!hookMatches(hook, "PostToolUse", name, input)) continue;
          const r = await fire(hook, "PostToolUse", name, input, cwd);
          if (r.code !== 0) notes.push(r.text || `${hook.command} failed`);
        }
        if (!notes.length) return output;
        const hook_output = notes.join("\n");
        return output && typeof output === "object"
          ? { ...output, hook_output }
          : { result: output, hook_output };
      },
      // Spread onto the output so a tool's card still reads its own fields, and put back beside
      // what its own `toModelOutput` says, which would otherwise drop a field it has not heard of.
      toModelOutput: (o: { output: unknown }) => {
        const held = o.output as { hook_output?: unknown } | null;
        const note = held && typeof held === "object" ? held.hook_output : undefined;
        const plain = (v: unknown) =>
          typeof v === "string"
            ? { type: "text" as const, value: v }
            : { type: "json" as const, value: (v ?? null) as never };
        if (typeof note !== "string") return (inner ? inner(o) : plain(o.output)) as never;
        const { hook_output: _note, ...rest } = held as Record<string, unknown>;
        const base = (inner ? inner({ ...o, output: rest }) : plain(rest)) as {
          type: string;
          value: unknown;
        };
        const line = `\n\n[hook output]\n${note}`;
        if (base.type === "content" && Array.isArray(base.value)) {
          return { ...base, value: [...base.value, { type: "text", text: line }] } as never;
        }
        const text = typeof base.value === "string" ? base.value : JSON.stringify(base.value);
        return { type: "text", value: `${text}${line}` };
      },
    } as never;
  }
  return out as T;
}

/** A turn ended. Fire and forget: it must never be able to fail the turn it follows. */
export function runStopHooks(cwd: HookCwd): void {
  for (const hook of usePreferencesStore.getState().aiHooks) {
    if (hook.event === "Stop") void fire(hook, "Stop", "", null, cwd);
  }
}
