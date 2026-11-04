/**
 * Self-check for "Always allow" approval rules.
 * Run: `npx tsx scripts/ai/approval-rules-verify.ts`.
 *
 * A rule that matches too much is a silent approval the user never gave, so
 * most of this file is about what a rule must NOT cover: a chained or piped
 * line riding on an allowed prefix, a file edit, a non-GET request, a secret
 * path as an argument, and prefixes too broad to offer at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandPrefix, ruleAllows, suggestRule } from "../../src/modules/ai/lib/approvalRules";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[the prefix a card offers]");
check("subcommand", commandPrefix("pnpm test --filter ai"), "pnpm test");
check("git subcommand", commandPrefix("git status -s"), "git status");
check("run verb takes the script", commandPrefix("npm run build -- --watch"), "npm run build");
check("exec verb takes the binary", commandPrefix("pnpm exec tsc --noEmit"), "pnpm exec tsc");
check("python -m", commandPrefix("python -m pytest -x"), "python -m pytest");
check("plain program", commandPrefix("ls -la"), "ls");
check("bare runner is never a rule", commandPrefix("node"), null);
check("runner with a flag only", commandPrefix("cmd /c del x"), null);
check("destructive program", commandPrefix("rm -rf dist"), null);
check("destructive subcommand", commandPrefix("git push --force"), null);
check("destructive thing a runner runs", commandPrefix("pwsh -c Remove-Item x"), null);
check("chained line", commandPrefix("pnpm test && pnpm build"), null);

const shell = (command: string) => ({ command });
const rule = { tool: "bash_run", match: "pnpm test" };

console.log("\n[what a shell rule approves]");
check("the prefix itself", ruleAllows(rule, "bash_run", shell("pnpm test")), true);
check("the prefix with arguments", ruleAllows(rule, "bash_run", shell("pnpm test --run")), true);
check("case-insensitively", ruleAllows(rule, "bash_run", shell("PNPM TEST")), true);
check("not a longer word", ruleAllows(rule, "bash_run", shell("pnpm testx")), false);
check("not a chained line", ruleAllows(rule, "bash_run", shell("pnpm test; rm -rf ~")), false);
check("not a piped line", ruleAllows(rule, "bash_run", shell("pnpm test | tee out")), false);
check("not a redirect", ruleAllows(rule, "bash_run", shell("pnpm test > out.txt")), false);
check("not a substitution", ruleAllows(rule, "bash_run", shell("pnpm test $(whoami)")), false);
check("not a second line", ruleAllows(rule, "bash_run", shell("pnpm test\nrm x")), false);
check("not another tool", ruleAllows(rule, "bash_background", shell("pnpm test")), false);
check(
  "not a secret as an argument",
  ruleAllows({ tool: "bash_run", match: "cat" }, "bash_run", shell("cat ~/.ssh/id_rsa")),
  false,
);

console.log("\n[what never becomes a rule]");
check("write_file", suggestRule("write_file", { path: "a.ts", content: "" }), null);
check("edit", suggestRule("edit", { path: "a.ts" }), null);
check("read outside the workspace", suggestRule("read_file", { path: "/etc/x" }), null);
check("a non-GET request", suggestRule("fetch", { url: "https://x.dev/a", method: "POST" }), null);
check(
  "a tool-wide rule never approves a file edit",
  ruleAllows({ tool: "edit" }, "edit", { path: "a.ts" }),
  false,
);

console.log("\n[request and tool rules]");
const host = suggestRule("fetch", { url: "https://api.github.com/repos" });
check("a GET suggests its host", host, { tool: "fetch", match: "api.github.com" });
check(
  "same host, other path",
  ruleAllows(host!, "fetch", { url: "https://api.github.com/x" }),
  true,
);
check("other host", ruleAllows(host!, "fetch", { url: "https://evil.example/x" }), false);
check(
  "same host, POST",
  ruleAllows(host!, "fetch", { url: "https://api.github.com/x", method: "POST" }),
  false,
);
check("an MCP tool is tool-wide", suggestRule("mcp__linear__list_issues", {}), {
  tool: "mcp__linear__list_issues",
});

console.log("\n[an agent cannot write itself a rule]");
const store = readFileSync(
  fileURLToPath(new URL("../../src/modules/settings/store.ts", import.meta.url)),
  "utf8",
);
const denied = store.slice(store.indexOf("const AGENT_DENIED_PREFS"));
check(
  "approvalRules is in AGENT_DENIED_PREFS",
  denied.slice(0, denied.indexOf("]);")).includes('"approvalRules"'),
  true,
);

console.log("\n[tedi] a rule names a verb, never the whole app");
{
  const verb = (v: string, args?: object) => ({ verb: v, args });
  check("a pane rename offers that verb", suggestRule("tedi", verb("rename", { leafId: 1 })), {
    tool: "tedi",
    match: "pane",
  });
  check("sh offers a command prefix", suggestRule("tedi", verb("sh", { command: "git status" })), {
    tool: "tedi",
    match: "sh git status",
  });
  check(
    "a chained sh offers nothing",
    suggestRule("tedi", verb("sh", { command: "ls; rm x" })),
    null,
  );
  check(
    "a bare tool rule allows nothing",
    ruleAllows({ tool: "tedi" }, "tedi", verb("panes")),
    false,
  );
  const pane = { tool: "tedi", match: "pane" };
  check("the rule allows its verb", ruleAllows(pane, "tedi", verb("close", { leafId: 1 })), true);
  check("and not another", ruleAllows(pane, "tedi", verb("set", { key: "a", value: "b" })), false);
  const git = { tool: "tedi", match: "sh git status" };
  check(
    "sh allows its prefix",
    ruleAllows(git, "tedi", verb("sh", { command: "git status -s" })),
    true,
  );
  check(
    "not a chain on it",
    ruleAllows(git, "tedi", verb("sh", { command: "git status; rm x" })),
    false,
  );
  check("not another command", ruleAllows(git, "tedi", verb("sh", { command: "git push" })), false);
  check(
    "a rule from when each verb was a tool still holds",
    ruleAllows({ tool: "mcp__tedi__sh" }, "tedi", verb("sh", { command: "ls" })),
    true,
  );
  check(
    "and only for that verb",
    ruleAllows({ tool: "mcp__tedi__sh" }, "tedi", verb("set", { key: "a", value: "b" })),
    false,
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall approval-rule checks passed");
