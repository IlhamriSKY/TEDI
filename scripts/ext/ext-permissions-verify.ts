/**
 * Extension permission-gate audit for TEDI. Guards three properties that are
 * easy to break silently because nothing else exercises them:
 *
 *   A. The install dialog's risk badge is derived from what a permission
 *      GRANTS, not from how it is spelled. `permissionRiskTier` and
 *      `checkPermission` used to be two independent answers to the same
 *      question and drifted, always toward under-warning: `*:*`, `**`,
 *      `invoke*`, `i*`, `s*` and `shell:*` all grant a high-risk capability
 *      through the glob branch while the literal prefix chain saw no matching
 *      prefix and returned "medium".
 *   B. `HARD_DENY_INVOKE` really is unreachable, including through `*`. These
 *      are the commands that would let an extension read the keychain directly
 *      or mint install-time consent for another extension.
 *   C. Low-risk permissions stay low, so widening (A) has not turned the badge
 *      into noise that users learn to click past.
 *
 * Run: `npx tsx scripts/ext/ext-permissions-verify.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkPermission,
  isInvokeAllowed,
  permissionRiskTier,
} from "../../src/modules/extensions/permissions";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}: ${label} = ${String(actual)}, want ${String(expected)}`);
}

console.log("\n[A] every glob that grants a high-risk capability badges high");
// Each of these grants invoke:shell_run_command and/or secrets:read via
// checkPermission's glob branch, and every one of them badged "medium" before
// the grant-derived tier.
for (const p of [
  "*",
  "*:*",
  "**",
  "*e*",
  "invoke*",
  "invoke:*",
  "i*",
  "s*",
  "sec*",
  "*read*",
  "shell:*",
  "*fs_*",
]) {
  check(`permissionRiskTier("${p}")`, permissionRiskTier(p), "high");
}

console.log("\n[A2] exact high-risk command families still badge high");
for (const p of [
  "invoke:fs_read_file",
  "invoke:shell_run_command",
  "invoke:pty_open",
  "invoke:ssh_open",
  "invoke:mcp_spawn",
  "invoke:fmt_run_external",
  "secrets:read",
  "ssh:connections",
  "shell:transform",
  "ai:configure",
  "ai:prompt",
]) {
  check(`permissionRiskTier("${p}")`, permissionRiskTier(p), "high");
}

console.log("\n[B] hard-denied commands are unreachable, even with a wildcard");
/** The commands `ctx.invoke` must never reach. Shared by section [B] (they
 *  really are unreachable through the TS gate) and section [E] (the Rust CLI
 *  mirrors this list to warn about a dead grant at authoring time). */
const DENIED_IN_TS = [
  "secrets_get_all",
  "secrets_get",
  "secrets_set",
  "secrets_delete",
  "ext_install_from_zip",
  "ext_install_from_github",
  "ext_enable",
  "ext_disable",
  "ext_uninstall",
];
for (const cmd of DENIED_IN_TS) {
  check(`isInvokeAllowed(["*"], "${cmd}")`, isInvokeAllowed(["*"], cmd), false);
}
// The gate must not over-reach: read-only extension commands stay callable.
for (const cmd of ["ext_list", "ext_read_manifest", "ext_check_update"]) {
  check(`isInvokeAllowed(["invoke:${cmd}"], "${cmd}")`, isInvokeAllowed([`invoke:${cmd}`], cmd), true);
}

console.log("\n[C] genuinely low-risk permissions stay low (badge must not become noise)");
for (const p of ["ui:toast", "settings:read", "events:emit", "panels:register", "tabs:open"]) {
  check(`permissionRiskTier("${p}")`, permissionRiskTier(p), "low");
}
check(`permissionRiskTier("editor:read")`, permissionRiskTier("editor:read"), "medium");

console.log("\n[D] checkPermission's own contract (the tier probes rely on it)");
check(`checkPermission(["ui:toast"], "secrets:read")`, checkPermission(["ui:toast"], "secrets:read"), false);
check(
  `checkPermission(["invoke:git_*"], "invoke:shell_run_command")`,
  checkPermission(["invoke:git_*"], "invoke:shell_run_command"),
  false,
);
check(
  `checkPermission(["invoke:git_*"], "invoke:git_status")`,
  checkPermission(["invoke:git_*"], "invoke:git_status"),
  true,
);

console.log("\n[E] the Rust CLI's copy of the hard-deny list still matches this one");
// `tedi ext validate` warns when a manifest asks for a permission that can
// never be granted, which needs the same list on the Rust side. It is a
// warning-only mirror of the enforcing set here, but a mirror that silently
// drifts stops warning about exactly the grants that matter most. Read it back
// out of the source rather than trusting a comment to keep them in step.
{
  const rustSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src-tauri/src/modules/cli_ext/validate.rs"),
    "utf8",
  );
  const block = /const HARD_DENIED: &\[&str\] = &\[([\s\S]*?)\];/.exec(rustSource)?.[1] ?? "";
  const rustList = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  // The TS list is private to `permissions.ts`; probe it through the gate
  // instead, which is the behaviour that actually matters.
  const tsList = rustList.filter((cmd) => !isInvokeAllowed(["*"], cmd));
  check("rust HARD_DENIED is non-empty", rustList.length > 0, true);
  check(
    `every rust entry is truly hard-denied in TS (${rustList.length})`,
    tsList.length === rustList.length,
    true,
  );
  for (const cmd of DENIED_IN_TS) {
    check(`rust list covers "${cmd}"`, rustList.includes(cmd), true);
  }
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nAll checks passed: risk tier follows the grant, hard-denies hold, low stays low.");
