/**
 * Self-check for the busy guard on the terminal-typing tools.
 * Run: `npx tsx scripts/terminal/terminal-inject-busy-verify.ts`.
 *
 * `send_to_terminal` writes raw bytes to the PTY. When the target is running a
 * command or a full-screen TUI (an AI CLI at its prompt is exactly that), those
 * bytes land in THAT program's input buffer, appended to whatever the user was
 * already typing - two prompts silently merged into one line. `run_in_terminal_by_id`
 * had the guard from the start; `send_to_terminal` did not, which is the bug
 * this pins.
 */
import { buildScheduleTools } from "../../src/modules/ai/tools/schedule";
import type { ToolContext } from "../../src/modules/ai/tools/context";

let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

/** Records what actually reached the terminal, so a refusal that still wrote is caught. */
const writes: string[] = [];
function ctxWith(busy: boolean): ToolContext {
  return {
    isTerminalBusy: () => busy,
    injectIntoTerminal: (_t, text) => {
      writes.push(text);
      return true;
    },
    runInTerminal: (_t, command) => {
      writes.push(command);
      return true;
    },
    listTerminals: () => [],
  } as unknown as ToolContext;
}

type Runner = { execute: (a: unknown, b: unknown) => Promise<Record<string, unknown>> };
const run = (busy: boolean, name: "send_to_terminal" | "run_in_terminal_by_id", args: unknown) =>
  (buildScheduleTools(ctxWith(busy)) as unknown as Record<string, Runner>)[name].execute(args, {});

console.log("[busy terminal] both typing tools must refuse");
for (const [name, args] of [
  ["send_to_terminal", { text: "Audit and fix SMP assessment scheduling workflow", target: {} }],
  ["run_in_terminal_by_id", { command: "ls", target: {} }],
] as const) {
  writes.length = 0;
  const res = await run(true, name, args);
  check(`${name} refuses`, typeof res.error === "string" && res.error.includes("busy"));
  check(`${name} wrote nothing`, writes.length === 0);
}

console.log("\n[idle terminal] the same calls must go through");
for (const [name, args, want] of [
  ["send_to_terminal", { text: "npm run dev", target: {} }, "npm run dev"],
  ["run_in_terminal_by_id", { command: "ls -la", target: {} }, "ls -la"],
] as const) {
  writes.length = 0;
  const res = await run(false, name, args);
  check(`${name} succeeds`, res.error === undefined);
  check(`${name} wrote once`, writes.length === 1 && writes[0] === want);
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
