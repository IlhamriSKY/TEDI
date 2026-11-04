/**
 * Self-check for the tool-gated system prompt.
 * Run: `npx tsx scripts/ai/prompt-tools-verify.ts`.
 *
 * The bug this guards: the tool picker switched every tool off except one
 * extension tool, and the system prompt still told the model to use `edit`,
 * `read_file`, `bash_run`, `run_subagents` and 29 MCP tools it had not been
 * given. Instructions for absent tools are billed on every message and are a
 * guaranteed failed call, so the prompt is now composed from the tool set the
 * turn actually sends.
 *
 * Three things must hold:
 *  1. Every `needs` tag names a REAL tool. A rename that nobody re-tagged would
 *     leave that tool's instructions in the prompt forever, silently.
 *  2. A tool that is switched off is not named in the prompt, and a block whose
 *     sections all filtered out leaves no bare `# Browser` heading behind.
 */
import {
  buildCorePrompt,
  composePrompt,
  PROMPT_TAGGED_TOOLS,
  SYSTEM_PROMPT,
} from "../../src/modules/ai/config";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/** The real built-in tool set, same source as `scripts/ai/tool-picker-verify.ts`
 *  (a live request capture). */
const REAL_TOOLS = [
  "read_file",
  "list_directory",
  "create_directory",
  "delete_file",
  "move_file",
  "copy_file",
  "edit",
  "multi_edit",
  "write_file",
  "replace_in_files",
  "grep",
  "glob",
  "fetch",
  "bash_run",
  "bash_background",
  "bash_logs",
  "bash_kill",
  "bash_list",
  "run_subagents",
  "todo_write",
  "tedi",
];

console.log("[tags] every `needs` tag names a real tool");
const orphans = PROMPT_TAGGED_TOOLS.filter((t) => !REAL_TOOLS.includes(t));
check(`${PROMPT_TAGGED_TOOLS.length} tagged names all exist`, orphans.length === 0, { orphans });

/**
 * How a tool shows up in prompt prose. Tool references are backticked, which is
 * what keeps `edit` from matching the phrase "edit this file"; the handful that
 * appear bare or under a different spelling get an explicit pattern.
 */
const MENTION: Record<string, RegExp> = {
  grep: /\bgrep\b/,
  glob: /\bglob\b/,
  list_directory: /\blist_directory\b/,
  fetch: /`Fetch`|Fetch call/,
  bash_background: /`bash_background`|Bash Background/,
};
const mentionOf = (t: string): RegExp => MENTION[t] ?? new RegExp("`" + t + "`");

/** The tools a prompt still names. */
function named(prompt: string): string[] {
  return REAL_TOOLS.filter((t) => mentionOf(t).test(prompt));
}

console.log("\n[all on] nothing is permanently filtered out");
{
  const on = named(SYSTEM_PROMPT);
  check("names the tools it has something to say about", on.length >= 4, { named: on });
}
// A tool's own description is read beside this prompt, so saying it again here is paid for twice.
check("no `mcp__` plumbing in prose", !SYSTEM_PROMPT.includes("mcp__"));

console.log("\n[the reported bug] one extension tool on, all 88 built-ins off");
// The user's actual session: only the `rtk_status` extension tool was ticked.
{
  const prompt = buildCorePrompt((t) => t === "rtk_status");
  const leaked = named(prompt);
  check("no built-in tool is named", leaked.length === 0, { leaked });
  check("still says who it is", prompt.startsWith("You are TEDI"));
}

console.log("\n[partial] switching one group off drops only that group");
const FILE_TOOLS = [
  "read_file",
  "list_directory",
  "delete_file",
  "move_file",
  "copy_file",
  "edit",
  "multi_edit",
  "write_file",
  "replace_in_files",
  "grep",
  "glob",
  "create_directory",
];
const noFiles = new Set(REAL_TOOLS.filter((t) => !FILE_TOOLS.includes(t)));
const p = buildCorePrompt((t) => noFiles.has(t));
check(
  "no file tool is named",
  named(p).every((t) => noFiles.has(t)),
  { named: named(p) },
);
check(
  "the lines about files went with them",
  !p.includes("active_file\`;") && !p.includes("re-read"),
);
check("`todo_write` survived", /`todo_write`/.test(p));

console.log("\n[headings] a block with no surviving section leaves nothing behind");
const empty = composePrompt(
  [
    { heading: "# Keep", sections: [{ text: "- kept" }] },
    { heading: "# Drop", sections: [{ needs: ["gone"], text: "- dropped" }] },
  ],
  () => false,
);
check("heading and body both gone", empty === "# Keep\n- kept", empty);

console.log(`\n${"=".repeat(60)}\n${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
