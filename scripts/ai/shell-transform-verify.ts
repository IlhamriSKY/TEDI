/**
 * The shell denylist must see the string that actually reaches the shell.
 *
 * Run: `npx tsx scripts/ai/shell-transform-verify.ts` (or `pnpm verify`).
 *
 * An extension holding the `shell:transform` permission rewrites every command
 * the agent runs (`tedi.rtk-bridge` turns `git status` into `rtk git status`).
 * Seven call sites across `shell.ts`, `terminal.ts` and `schedule.ts` used to do:
 *
 *     checkShellCommand(command)                 // vet what the MODEL wrote
 *     const effective = applyShellTransformers(command, kind)
 *     run(effective)                             // ...then run something else
 *
 * so the denylist never inspected the executed string. `shell.ts` even carried a
 * comment claiming the opposite ("Safety checks run against the user-authored
 * command so transformers can't bypass the denylist"), which is the reasoning
 * backwards: checking only the authored command is precisely what lets a
 * transformer through.
 *
 * `checkedShellCommand` now does both halves in one place, so the rule to hold
 * is simply that nobody transforms-and-runs on their own. Structural, because a
 * functional test cannot import these modules - they pull in the extension
 * registry and the Tauri bridge.
 */
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};

const TOOLS_DIR = "src/modules/ai/tools";
const OWNER = "shell.ts"; // the one file allowed to call the raw transformer

console.log("[shell transforms] only shell.ts may call applyShellTransformers directly");

const files = (await readdir(TOOLS_DIR)).filter((f) => f.endsWith(".ts"));
let checked = 0;
for (const f of files) {
  const src = await readFile(`${TOOLS_DIR}/${f}`, "utf8");
  if (!src.includes("applyShellTransformers")) continue;
  checked++;
  if (f !== OWNER) {
    fail(
      `${f} calls applyShellTransformers directly - use checkedShellCommand, or the denylist never sees what runs`,
    );
  }
}
if (!failed) {
  console.log(`  ok: ${checked} file(s) reference it, and only ${OWNER} does so directly`);
}

// Inside shell.ts, the helper must check the transformed string, not just the
// raw one. Two `checkShellCommand` calls: one before the transform, one after.
const shellSrc = await readFile(`${TOOLS_DIR}/${OWNER}`, "utf8");
const helper = shellSrc.slice(
  shellSrc.indexOf("export function checkedShellCommand"),
  shellSrc.indexOf("/** Per-session lazy shell id."),
);
if (!helper) {
  fail("checkedShellCommand is gone - every call site would be transforming unchecked again");
} else {
  const checks = helper.match(/checkShellCommand\(/g) ?? [];
  if (checks.length < 2) {
    fail(
      `checkedShellCommand runs ${checks.length} denylist check(s); it needs two - the authored command (for a useful error) and the transformed one (for safety)`,
    );
  } else if (!/checkShellCommand\(\s*effective/.test(helper)) {
    fail("checkedShellCommand never checks `effective` - the transformed string runs unvetted");
  } else {
    console.log("  ok: the transformed command is vetted before it is returned");
  }
}

// Every executing call site must consume the vetted result, never `command`
// straight from the model, once it has one in hand.
console.log("\n[call sites] the vetted string is what gets executed");
// `lib/tediMcpServer.ts` is on this list because it OWNS the terminal now: the
// `sh` MCP tool replaced `run_in_terminal`, and the bridge it writes through is
// deliberately dumb, so this handler is the only thing standing between the
// model's command and the user's shell.
for (const f of [
  `${TOOLS_DIR}/shell.ts`,
  `${TOOLS_DIR}/schedule.ts`,
  "src/modules/ai/lib/tediMcpServer.ts",
]) {
  const src = await readFile(f, "utf8");
  // `\b(?<!function )` would be neater, but the declaration in shell.ts is the
  // only non-call match and excluding it keeps the reported count honest.
  const uses = (src.match(/(?<!function )checkedShellCommand\(/g) ?? []).length;
  const consumes = (src.match(/vetted\.command/g) ?? []).length;
  if (uses === 0) {
    fail(`${f} no longer vets any command`);
  } else if (consumes === 0) {
    fail(`${f} calls checkedShellCommand but never uses vetted.command - the result is discarded`);
  } else {
    console.log(`  ok: ${f} vets ${uses} command(s) and runs the vetted form`);
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS");
if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
