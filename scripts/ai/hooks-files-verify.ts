/**
 * Self-check for hooks and for agents and skills defined in files.
 * Run: `npx tsx scripts/ai/hooks-files-verify.ts`.
 *
 * Both are ways for text outside the app to change what the agent does, so what is checked here is
 * where that stops: a repository cannot define a hook or a worker, the model's input never reaches
 * a shell line, and real input can never be made permanent from a card.
 */
import { readFileSync } from "node:fs";

// The settings store opens its window at import, so this has to be in place first.
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async () => null,
    transformCallback: () => 0,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  },
};
const { suggestRule, ruleAllows } = await import("../../src/modules/ai/lib/approvalRules");
const { parseAgentFile } = await import("../../src/modules/ai/lib/fileDefinitions");
const { hookEnv, hookMatches, withHooks } = await import("../../src/modules/ai/lib/hooks");
const { native } = await import("../../src/modules/ai/lib/native");
const { usePreferencesStore } = await import("../../src/modules/settings/preferences");
import type { AiHook } from "../../src/modules/settings/store";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

console.log("[hooks] matching");
const post = (tool?: string): AiHook => ({ event: "PostToolUse", command: "x", tool });
check("no tool means every tool", hookMatches(post(), "PostToolUse", "edit", {}));
check("the event has to match", !hookMatches(post(), "PreToolUse", "edit", {}));
check("a list of tools", hookMatches(post("edit|write_file"), "PostToolUse", "write_file", {}));
check("another tool does not", !hookMatches(post("edit"), "PostToolUse", "bash_run", {}));
check(
  "one verb of the tedi tool",
  hookMatches(post("tedi:sh"), "PostToolUse", "tedi", { verb: "sh" }) &&
    !hookMatches(post("tedi:sh"), "PostToolUse", "tedi", { verb: "panes" }),
);

console.log("\n[hooks] the model's input stays out of the command");
const evil = { path: "a.ts", content: "$(rm -rf ~)" };
const env = hookEnv("PostToolUse", "write_file", evil);
check("the path is a variable", env.TEDI_FILE === "a.ts");
check("the input is a variable", env.TEDI_TOOL_INPUT.includes("rm -rf"));
check(
  "a huge input cannot overflow the environment block",
  hookEnv("x", "y", { a: "z".repeat(100_000) }).TEDI_TOOL_INPUT.length <= 16_000,
);

check(
  "a cut never leaves half a character, and says it was cut",
  (() => {
    const cut = hookEnv("x", "y", { a: "\u{1F600}".repeat(20_000) });
    return !/[\uD800-\uDBFF]$/.test(cut.TEDI_TOOL_INPUT) && cut.TEDI_TOOL_INPUT_TRUNCATED === "1";
  })(),
);

console.log("\n[hooks] around a tool");
const ran: { command: string; env: unknown }[] = [];
let exit = 0;
(native as unknown as { runCommand: unknown }).runCommand = async (
  command: string,
  _cwd: unknown,
  _timeout: unknown,
  e: unknown,
) => {
  ran.push({ command, env: e });
  return { stdout: "", stderr: "said no", exit_code: exit, timed_out: false, truncated: false };
};
const setHooks = (aiHooks: AiHook[]) => usePreferencesStore.setState({ aiHooks } as never);

let executed = 0;
const tools = {
  edit: {
    description: "",
    execute: async () => {
      executed++;
      return { ok: true };
    },
    toModelOutput: () => ({ type: "text", value: "lean" }),
  },
} as never;
setHooks([]);
check("no hooks, the very same tools", withHooks(tools, () => null) === tools);

setHooks([{ event: "PreToolUse", tool: "edit", command: "guard" }]);
exit = 2;
const hooked = withHooks(tools, () => null) as unknown as Record<
  string,
  {
    execute: (i: unknown, o: never) => Promise<Record<string, unknown>>;
    toModelOutput: (o: { output: unknown }) => { value: unknown };
  }
>;
const blocked = await hooked.edit.execute({ path: "a" }, undefined as never);
check(
  "exit 2 blocks the tool",
  executed === 0 && String(blocked.error).includes("said no"),
  blocked,
);
check("the command is the user's, untouched", ran[0]?.command === "guard");
exit = 1;
await hooked.edit.execute({ path: "a" }, undefined as never);
check("any other exit does not block", executed === 1);

exit = null as never;
const noAnswer = await hooked.edit.execute({ path: "a" }, undefined as never);
check("a guard that could not answer blocks", executed === 1 && !!noAnswer.error, noAnswer);
exit = 0;
const stopped = new AbortController();
stopped.abort();
const late = await hooked.edit.execute({ path: "a" }, { abortSignal: stopped.signal } as never);
check("Stop during a guard stops the tool", executed === 1 && !!late.error, late);

setHooks([{ event: "PostToolUse", tool: "edit", command: "lint" }]);
const after = withHooks(tools, () => null) as typeof hooked;
exit = 1;
const failedLint = await after.edit.execute({ path: "a" }, undefined as never);
check(
  "a failed hook keeps the tool's own fields",
  failedLint.ok === true && !!failedLint.hook_output,
);
const seen = after.edit.toModelOutput({ output: failedLint }).value as string;
check(
  "the model sees it, past a tool's own output filter",
  seen.startsWith("lean") && seen.includes("said no"),
  seen,
);
exit = 0;
const clean = await after.edit.execute({ path: "a" }, undefined as never);
check("a passing hook adds nothing", !("hook_output" in clean));
setHooks([]);

console.log("\n[hooks] only a person adds one");
const store = readFileSync("src/modules/settings/store.ts", "utf8");
const denied = store.slice(store.indexOf("const AGENT_DENIED_PREFS"));
check(
  "an agent is refused the write",
  denied.slice(0, denied.indexOf("]);")).includes('"aiHooks"'),
);
const hooksSrc = readFileSync("src/modules/ai/lib/hooks.ts", "utf8");
check(
  "no file defines a hook",
  !/readFile|readDir|\.tedi/.test(hooksSrc.replace(/\/\*[\s\S]*?\*\//g, "")),
);

console.log("\n[agents] a file's agent");
const worker =
  "---\nname: Fixer\ndescription: fixes\ntools: Read, Edit, Bash, delete_file, nonsense\nmodel: x\n---\nDo it.";
const project = parseAgentFile("fixer.md", worker, "project");
const mine = parseAgentFile("fixer.md", worker, "user");
check(
  "a repository's agent is read-only whatever it asks for",
  project?.tools.join() === "read_file",
  project?.tools,
);
check(
  "your own may name write tools, in either vocabulary",
  mine?.tools.join() === "read_file,edit,bash_run,delete_file",
  mine?.tools,
);
check("an unknown tool is dropped", !mine?.tools.includes("nonsense"));
check("no file picks a model", mine?.model === undefined && project?.model === undefined);
check("the id comes from the name", mine?.id === "fixer");
check(
  "no tools named means read-only",
  parseAgentFile("a.md", "Just read.", "user")?.tools.join() ===
    "read_file,list_directory,grep,glob",
);
check("no prompt, no agent", parseAgentFile("a.md", "---\nname: a\n---\n", "user") === null);

const roster = readFileSync("src/modules/ai/store/subagentsStore.ts", "utf8");
check(
  "a file cannot shadow a built-in or a custom agent",
  roster.includes("{ ...fromFiles, ...builtIn, ...Object.fromEntries(customEntries) }"),
);

console.log("\n[real input] each press stays a question");
for (const verb of ["keys", "type", "click", "drag"]) {
  const input = { verb, args: { selector: "x", chords: ["Enter"], text: "x", dx: 1, dy: 1 } };
  check(`${verb}: no card offers Always allow`, suggestRule("tedi", input) === null);
}
check(
  "lsp: no card offers Always allow either",
  suggestRule("tedi", { verb: "lsp", args: { op: "hover", path: "a.ts" } }) === null,
);
const tool = verbTool("click");
check(
  "an old rule for it no longer holds",
  !ruleAllows({ tool }, "tedi", { verb: "click", args: { selector: "x" } }),
);
check(
  "a screenshot may be made permanent",
  suggestRule("tedi", { verb: "shot" })?.match === "screenshot",
);
function verbTool(verb: string) {
  return `mcp__tedi__${verb}`;
}

console.log("\n[lsp] a repository's binary never runs");
const lsp = readFileSync("src-tauri/src/modules/lsp.rs", "utf8");
check("programs come from PATH", /find_map\(\|\(name, args\)\| on_path\(name\)/.test(lsp));
check("nothing reads node_modules", !/current_dir\(\)|join\("node_modules/.test(lsp));

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
