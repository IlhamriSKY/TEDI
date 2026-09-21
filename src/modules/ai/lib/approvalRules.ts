/**
 * "Always allow" rules: approvals the user has made permanent from a card.
 *
 * The approval MODE is one switch for everything, and a card for `pnpm test`
 * on every run is how people end up on Full Auto, which then waves through the
 * one command that mattered. A rule is narrower than any mode: one tool, and
 * for the shell one command prefix, for a request one host.
 *
 * What a rule can never cover:
 * - File mutations. Their card is a diff review, and the path changes per call.
 * - A shell line that chains, pipes, redirects or substitutes. `pnpm test` must
 *   not approve `pnpm test; rm -rf ~`, so such a line always asks.
 * - A shell line the unattended safety pass refuses (a secret path as an
 *   argument), the same bar Semi mode's read-only list clears.
 * - A request that is not a GET: only first contact with a host is waived,
 *   because a model-chosen body is a write channel off the machine.
 *
 * Stored in preferences (`approvalRules`) and listed in `AGENT_DENIED_PREFS`, so
 * an agent cannot write itself a rule.
 */
import type { ApprovalRule } from "@/modules/settings/store";
import { checkShellCommand, egressHost } from "./security";

export type { ApprovalRule };

/** Tools whose card is a review, never made permanent. */
const NEVER_ALWAYS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "delete_file",
  "move_file",
  "copy_file",
  "create_directory",
  "replace_in_files",
  // Outside-workspace reads: the path is the whole question.
  "read_file",
  "list_directory",
  "grep",
  "glob",
]);

const SHELL_TOOLS = new Set(["bash_run", "bash_background"]);
const HOST_TOOLS = new Set(["fetch", "open_browser", "navigate_and_read"]);

/** Chaining, piping, redirection, substitution: a second command could hide here. */
const SHELL_META = /[;&|><`$()\r\n]/;

/** Commands whose prefix is too broad or too destructive to offer as "always". */
const NO_PREFIX_RULE = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "mv",
  "move",
  "dd",
  "mkfs",
  "format",
  "shutdown",
  "reboot",
  "sudo",
  "su",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "git push",
  "git reset",
  "git clean",
  "git checkout",
  "git rebase",
]);

/** Programs that run whatever follows them, so the rule must name what that is. */
const RUNNERS = new Set([
  "node",
  "python",
  "python3",
  "py",
  "deno",
  "bun",
  "php",
  "ruby",
  "perl",
  "bash",
  "sh",
  "zsh",
  "pwsh",
  "powershell",
  "cmd",
  "npx",
  "bunx",
  "uvx",
]);
/** Sub-verbs that mean "run the next word" (`pnpm exec tsc`, `npm run build`). */
const RUN_VERBS = new Set(["run", "exec", "dlx", "x", "-m", "-c"]);

/**
 * The prefix a card offers for a shell line: the program and its subcommand
 * (`git status`, `pnpm test`), one word more when the subcommand only runs
 * something else (`npm run build`, `python -m pytest`). Null when the line
 * cannot be a rule at all.
 */
export function commandPrefix(command: string): string | null {
  const cmd = command.trim();
  if (!cmd || SHELL_META.test(cmd)) return null;
  const words = cmd.split(/\s+/);
  const first = words[0].toLowerCase();
  const isWord = (w: string | undefined) => !!w && /^[a-z][\w:.-]*$/i.test(w);
  let prefix = first;
  let i = 1;
  if (RUN_VERBS.has((words[1] ?? "").toLowerCase()) && words[2] && !words[2].startsWith("-")) {
    prefix = `${first} ${words[1]} ${words[2]}`;
    i = 3;
  } else if (isWord(words[1])) {
    prefix = `${first} ${words[1]}`;
    i = 2;
  }
  // A bare runner (`node`, `npx`) would allow any script at all.
  if (i === 1 && RUNNERS.has(first)) return null;
  // Destructive anywhere in the prefix, including as what a runner runs
  // (`pwsh -c Remove-Item`, `npx rm`).
  const parts = prefix.toLowerCase().split(" ");
  const pairs = parts.slice(1).map((w, k) => `${parts[k]} ${w}`);
  if ([...parts, ...pairs].some((w) => NO_PREFIX_RULE.has(w))) return null;
  return prefix;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The rule a card would create for this call, or null when none may exist. */
export function suggestRule(
  toolName: string,
  input: Record<string, unknown> | undefined,
): ApprovalRule | null {
  if (NEVER_ALWAYS.has(toolName)) return null;
  if (SHELL_TOOLS.has(toolName)) {
    const prefix = commandPrefix(str(input?.command));
    return prefix ? { tool: toolName, match: prefix } : null;
  }
  if (HOST_TOOLS.has(toolName)) {
    if (str(input?.method || "GET").toUpperCase() !== "GET") return null;
    const host = egressHost(str(input?.url));
    return host ? { tool: toolName, match: host } : null;
  }
  return { tool: toolName };
}

/** Whether `rule` approves this call. */
export function ruleAllows(
  rule: ApprovalRule,
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (rule.tool !== toolName) return false;
  if (NEVER_ALWAYS.has(toolName)) return false;
  if (SHELL_TOOLS.has(toolName)) {
    if (!rule.match) return false;
    const cmd = str(input?.command).trim();
    if (!cmd || SHELL_META.test(cmd)) return false;
    const lc = cmd.toLowerCase();
    const prefix = rule.match.toLowerCase();
    if (lc !== prefix && !lc.startsWith(`${prefix} `)) return false;
    return checkShellCommand(cmd, { unattended: true }).ok;
  }
  if (HOST_TOOLS.has(toolName)) {
    if (!rule.match) return false;
    if (str(input?.method || "GET").toUpperCase() !== "GET") return false;
    return egressHost(str(input?.url)) === rule.match;
  }
  return rule.match === undefined;
}

/** How a rule reads in a button or a settings row. */
export function describeRule(rule: ApprovalRule): string {
  return rule.match ? `${rule.tool}: ${rule.match}` : rule.tool;
}
