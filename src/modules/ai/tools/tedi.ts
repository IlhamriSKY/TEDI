/**
 * `tedi`: the one tool TEDI's own agent drives the app through.
 *
 * WHY ONE. The tool list is re-sent on every step of every turn, and the app's control
 * surface was the biggest thing on it: 14 MCP tools, 3 schedule, 2 notes and one per
 * extension came to ~5k tokens a step, in sessions that never touched a pane. A schema
 * costs nothing until it is asked for, so `help` answers with one when the model needs it,
 * and `validateArgs` names the real arguments when it guesses wrong.
 *
 * Same verbs and same handlers as `tedi <verb>` in a shell (`scripts/mcp/handlers.mjs`), run
 * here in the app's own realm: no process, no port, and it works with no Node installed.
 * Only this agent's own policy lives in this file: the shell guard, the picker and the switches.
 *
 * Files and the hidden shell stay typed tools. They are used on nearly every step, and they
 * need the read-before-edit cache, the scope guards and the checkpoints.
 */
import { jsonSchema, tool, type Tool, type ToolSet } from "ai";
import { HANDLERS } from "@mcp/handlers.mjs";
import {
  cliVerbs,
  extToolMedia,
  gatewayArgs,
  resolveVerb,
  TEDI_TOOL,
  TOOL_DEFS,
  TOOL_NAMES,
  validateArgs,
  verbArgs,
  verbNeedsApproval,
} from "@mcp/tools.mjs";
import { callBridge } from "@/modules/automation/bridge";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getMcpSurface } from "@/modules/settings/store";
import { skillsLine } from "../lib/fileDefinitions";
import { clampForModel, resolvePath, type ToolContext } from "./context";
import { buildExtensionTools } from "./extensions";
import { checkedShellCommand } from "./shell";
import { extensionToolKey } from "./toolKey";

/** `ai` reads and drives the built-in agent, which IS the caller. `eval_js` has no handler here:
 *  script in this webview can read the keys and write the settings this agent is refused. */
const SERVED = TOOL_NAMES.filter((n) => n !== "ai" && Object.hasOwn(HANDLERS, n));

/** What the picker stores for a verb, under the name it has always had: a tool someone
 *  switched off before this was one tool has to stay off. */
const pickerKey = (toolName: string): string => `mcp__tedi__${toolName}`;

const isOff = (key: string): boolean => usePreferencesStore.getState().disabledTools.includes(key);

/** One picker row per verb. Virtual: none of them is sent, and `run` below enforces them. */
export function tediPickerRows(): Record<string, { description: string }> {
  return Object.fromEntries(
    SERVED.map((n) => [
      pickerKey(n),
      { description: TOOL_DEFS[n].description.split(/(?<=\.)\s/)[0] },
    ]),
  );
}

function guide(extTools: ToolSet): string {
  const offered = [
    ...SERVED.map((name) => ({ name, description: TOOL_DEFS[name].description })),
    ...Object.entries(extTools).map(([key, t]) => ({
      name: `ext_${key}`,
      description: t.description ?? "",
    })),
  ];
  return cliVerbs(offered)
    .map((v) => `${v.verb}: ${v.about}`)
    .join("\n");
}

function help(verb: string, extTools: ToolSet): unknown {
  const found = resolveVerb(verb);
  if (!found) throw new Error(`Unknown verb "${verb}". {verb:"tools"} lists them.`);
  const ext = found.tool.startsWith("ext_") ? extTools[found.tool.slice(4)] : null;
  const def = TOOL_DEFS[found.tool];
  if (!ext && !def) throw new Error(`"${verb}" is not available.`);
  return {
    verb,
    description: ext ? ext.description : (found.about ?? def.description),
    // Schema of an extension's tool is the one it declared.
    args: ext ? (ext.inputSchema as { jsonSchema?: unknown }).jsonSchema : def.schema,
    fixedArgs: found.args,
  };
}

/** Why this agent may not make this call, or null. A switch off in the Install MCP dialog and
 *  one off in the tool picker both mean no, and an agent must not route around either. */
async function refusal(toolName: string, a: Record<string, unknown>): Promise<string | null> {
  const surface = await getMcpSurface();
  if (surface.disabledTools.includes(toolName)) {
    return `"${toolName}" is switched off in TEDI's MCP settings. Ask the user; do not route around it.`;
  }
  if (isOff(pickerKey(toolName))) {
    return `"${toolName}" is switched off in the tool picker. Ask the user; do not route around it.`;
  }
  if (a.extensionId && surface.disabledExtensions.includes(String(a.extensionId))) {
    return `${String(a.extensionId)} is switched off in TEDI's MCP settings.`;
  }
  // An extension's AI tool has a second door here, so its own switch has to hold on this one.
  if (toolName === "run_command" && a.extensionId && isOff(extensionToolKey(String(a.id)))) {
    return `"${String(a.id)}" is switched off in the tool picker. Ask the user; do not route around it.`;
  }
  if (toolName === "inspect" && a.what === "logs") {
    return "The console is read through DevTools: run `tedi logs` in bash_run.";
  }
  return null;
}

async function run(
  input: { verb?: unknown; args?: unknown },
  extTools: ToolSet,
  options: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const verb = String(input.verb ?? "");
  const args = gatewayArgs(input.args);
  if (verb === "tools") return guide(extTools);
  if (verb === "help") return help(String(args.verb ?? ""), extTools);

  const found = resolveVerb(verb);
  if (!found) throw new Error(`Unknown verb "${verb}". {verb:"tools"} lists them.`);

  if (found.tool.startsWith("ext_")) {
    const key = found.tool.slice(4);
    const ext = extTools[key] as Tool | undefined;
    if (!ext?.execute || isOff(key)) throw new Error(`"${verb}" is not available.`);
    return ext.execute(args, options as Parameters<NonNullable<Tool["execute"]>>[1]);
  }
  if (!SERVED.includes(found.tool)) {
    throw new Error(
      found.tool === "ai"
        ? "That verb drives this agent, which is you."
        : `Not available to this agent. Tell the user what you wanted it for.`,
    );
  }

  let a = verbArgs(found, args);
  const refused = await refusal(found.tool, a);
  if (refused) throw new Error(refused);
  const bad = validateArgs(found.tool, a);
  if (bad) throw new Error(bad);

  // The denylist and the extension transformer chain are this agent's own: the handler is
  // deliberately dumb, because an outside agent has its own approval model.
  if (found.tool === "sh") {
    const vetted = checkedShellCommand(String(a.command).replace(/[\r\n]+$/, ""), "terminal");
    if (!vetted.ok) throw new Error(vetted.error);
    a = { ...a, command: vetted.command };
  }

  // Relative to the same folder the file tools resolve against, not to whatever the app has.
  if (found.tool === "lsp") a = { ...a, path: resolvePath(String(a.path), ctx.getCwd()) };
  if (found.tool === "skill") a = { ...a, root: ctx.getWorkspaceRoot() ?? null };

  const value = await HANDLERS[found.tool]((name, ...rest) => callBridge(name, rest), a);
  return found.select ? ((value as Record<string, unknown>)?.[found.select] ?? null) : value;
}

/** Pressing Stop has to end the wait, or a `sh` sits in its poll loop until the timeout. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const stop = () => reject(new Error("Stopped by the user."));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
  ]);
}

/** Rebuilt each turn, like the sub-agent tools: its description names the live extensions. */
export function buildTediTools(ctx: ToolContext): ToolSet {
  const extTools = buildExtensionTools(ctx);
  const extKeys = Object.keys(extTools).filter((key) => !isOff(key));
  // Every row in the picker off means the whole tool is off, with nothing to bill.
  if (!extKeys.length && SERVED.every((n) => isOff(pickerKey(n)))) return {};
  const extLine = extKeys.length
    ? `\n- Extensions, by verb: ${extKeys.map((key) => `ext_${key}`).join(", ")}.`
    : "";

  return {
    [TEDI_TOOL.name]: tool({
      description: `${TEDI_TOOL.description}${extLine}${skillsLine()}`,
      inputSchema: jsonSchema<{ verb: string; args?: unknown }>(
        TEDI_TOOL.inputSchema as Parameters<typeof jsonSchema>[0],
      ),
      // A read needs no card, and a card names the verb. Decided in one place, from the table,
      // so a third party cannot grant itself an exception.
      needsApproval: (input) => verbNeedsApproval(input.verb, input.args),
      execute: async (input, options) => {
        try {
          return await untilStopped(run(input, extTools, options, ctx), ctx.abortSignal);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      // The one agreed media shape reaches a model as a real image, not as base64 it cannot
      // decode. Anything else is compact and capped: it is replayed on every later step.
      toModelOutput: ({ output }) => {
        const media = extToolMedia(output);
        if (media) {
          return {
            type: "content",
            value: [
              ...(media.text ? [{ type: "text" as const, text: media.text }] : []),
              { type: "file-data" as const, data: media.data, mediaType: media.mimeType },
            ],
          };
        }
        if (output && typeof output === "object" && "error" in output) {
          return { type: "text", value: String((output as { error: unknown }).error) };
        }
        const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "null");
        return { type: "text", value: clampForModel(text, 20_000) };
      },
    }),
  };
}
