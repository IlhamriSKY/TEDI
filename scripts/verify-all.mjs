#!/usr/bin/env node
/**
 * Run every `scripts/*-verify.ts`.
 *
 * Replaces the 1480-character `&&` chain this used to be in package.json, which
 * had two costs: adding a check meant hand-editing a single enormous line (and
 * a typo there silently dropped a script from the suite), and `&&` stopped at
 * the FIRST failure, so one broken check hid the results of the other thirty.
 * Globbing the directory means a new `*-verify.ts` is picked up by existing,
 * and every failure is reported in one run.
 *
 * `node scripts/verify-all.mjs ssh` runs only the scripts whose name contains
 * "ssh" - the whole suite is ~15s, but a single check is ~0.4s while iterating.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";
const all = readdirSync(here)
  .filter((f) => f.endsWith("-verify.ts"))
  .sort();
const picked = filter ? all.filter((f) => f.includes(filter)) : all;

if (picked.length === 0) {
  console.error(
    filter
      ? `verify: no *-verify.ts matches "${filter}" (${all.length} available)`
      : "verify: no *-verify.ts found",
  );
  process.exit(1);
}

const repoRoot = join(here, "..");
const failed = [];
for (const file of picked) {
  // `shell: true` so Windows resolves the `tsx.CMD` shim (pnpm run has already
  // put node_modules/.bin on PATH). That means the argument goes through the
  // shell's word splitting, so it must stay RELATIVE: an absolute path breaks
  // the moment the checkout lives somewhere with a space in it, which is where
  // this was first run ("TEDI - terax-ai" split into two arguments and every
  // script "failed"). `cwd` is passed to the OS, not the command line, so it
  // may contain spaces safely.
  // One command STRING, not (command, args): with `shell: true` node concatenates
  // them anyway and warns about it (DEP0190) on every run. `file` comes from a
  // directory listing filtered to `*-verify.ts`, and the quotes cover a name
  // with a space in either shell.
  const run = spawnSync(`tsx "scripts/${file}"`, {
    stdio: "inherit",
    shell: true,
    cwd: repoRoot,
  });
  if (run.status !== 0) failed.push(file);
}

console.log(
  `\n${"=".repeat(60)}\nverify: ${picked.length - failed.length}/${picked.length} passed`,
);
if (failed.length > 0) {
  for (const f of failed) console.error(`  FAILED  ${f}`);
  process.exit(1);
}
