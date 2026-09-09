/**
 * The schedule engine's automation surface.
 *
 * WHY IT EXISTS. TEDI's own agent could schedule a command since the feature
 * shipped (`ai/tools/schedule.ts`); an outside AI CLI driving TEDI over MCP had
 * no route to it at all - not even to SEE that three commands were queued
 * against the pane it was about to use. The engine was reachable only from the
 * ai-native tool module, so there was nothing for the bridge to call.
 *
 * Registered at MODULE scope, like `commandRegistry` and the workspaces store,
 * rather than from an effect: an effect-registered capability exists or not
 * according to which panel the user has opened, and this one must answer from
 * the moment the window is up. `useAgentBridges` imports the file for its side
 * effect, beside the `setSchedulerBridge` call that gives the engine its
 * terminals.
 *
 * A CREATE IS VETTED EXACTLY AS THE IN-APP AGENT'S IS, through the shared
 * `checkedShellCommand`. Not a courtesy: a scheduled command runs LATER and
 * unattended, so the approval card raised when it is created is the only human
 * in the loop, and the shell-transformer chain has to be applied here or a
 * deferred command runs a different string from the same command run now.
 */
import { checkedShellCommand } from "@/modules/ai/tools/shell";
import { registerBridge } from "@/modules/automation/bridge";
import { scheduler } from "./engine";
import type { ScheduleAction, TerminalTarget } from "../types";

/** What `schedule list` answers with. Times as ISO so a model never has to do
 *  epoch arithmetic to say "in about four minutes". */
function listSchedules(): {
  schedules: Array<{
    id: string;
    status: string;
    fireAt: string;
    fireInSeconds: number | null;
    command: string;
    action: ScheduleAction;
    target: TerminalTarget;
    label: string | null;
    error: string | null;
  }>;
} {
  return {
    schedules: scheduler.getAll().map((s) => ({
      id: s.id,
      status: s.status,
      fireAt: new Date(s.fireAt).toISOString(),
      fireInSeconds: s.status === "pending" ? Math.round((s.fireAt - Date.now()) / 1000) : null,
      command: s.command,
      action: s.action,
      target: s.target,
      label: s.label ?? null,
      error: s.error ?? null,
    })),
  };
}

/**
 * Queue a command. Answers with a SENTENCE on refusal rather than throwing or
 * returning null: `driver.mjs` reads a bare `null` as "this build has no
 * automation surface", which is a different and much more alarming answer than
 * "that command was refused".
 */
async function createSchedule(input: {
  command?: unknown;
  delay?: unknown;
  at?: unknown;
  leafId?: unknown;
  submit?: unknown;
  label?: unknown;
}): Promise<unknown> {
  const command = String(input.command ?? "").replace(/[\r\n]+$/, "");
  if (!command) return "schedule create needs a `command`.";

  const action: ScheduleAction = input.submit === false ? "inject" : "submit";
  // An inject schedule types without Enter, so an embedded newline would run
  // every line after the first at fire time with no re-approval. Submit is
  // meant to run, so a multi-line script is allowed there.
  if (action === "inject" && /[\r\n]/.test(command)) {
    return "Refused: an inject schedule types without running, so it cannot contain a newline. Drop `submit: false` to run a multi-line command.";
  }
  const vetted = checkedShellCommand(command, "terminal");
  if (!vetted.ok) return vetted.error;
  if (action === "inject" && /[\r\n]/.test(vetted.command)) {
    return "Refused: a shell transformer introduced a newline; an inject schedule cannot run extra lines.";
  }

  let fireAt: number;
  if (typeof input.delay === "number" && Number.isFinite(input.delay) && input.delay >= 0) {
    fireAt = Date.now() + Math.round(input.delay * 1000);
  } else if (typeof input.at === "string" && input.at.trim()) {
    const ms = Date.parse(input.at);
    if (Number.isNaN(ms)) return `Could not parse \`at\` as a timestamp: "${input.at}".`;
    fireAt = ms;
  } else {
    return "schedule create needs `delay` (seconds from now) or `at` (an ISO-8601 timestamp).";
  }
  // A one-second slack, so "at 14:30" sent at 14:30:00.4 is not a past time.
  if (fireAt < Date.now() - 1000) {
    return `That time has already passed (${new Date(fireAt).toISOString()}).`;
  }

  const target: TerminalTarget = typeof input.leafId === "number" ? { leafId: input.leafId } : {};
  const label =
    typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
  const s = await scheduler.create({ fireAt, command: vetted.command, action, target, label });
  return {
    id: s.id,
    fireAt: new Date(s.fireAt).toISOString(),
    fireInSeconds: Math.round((s.fireAt - Date.now()) / 1000),
    command: s.command,
    action: s.action,
    target: s.target,
    label: s.label ?? null,
  };
}

registerBridge({
  schedules: listSchedules,
  scheduleCreate: createSchedule,
  scheduleCancel: async (id: string) =>
    (await scheduler.cancel(String(id)))
      ? { id, cancelled: true }
      : `No pending schedule with id "${id}" - it may have already fired or been cancelled. Call \`schedule list\` for the current ids.`,
});
