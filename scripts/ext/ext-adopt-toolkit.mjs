#!/usr/bin/env node
/**
 * Brings every extension under `extensions/<id>/` onto the authoring toolkit
 * that `tedi ext create` now generates: the typed API, the JSON-Schema-backed
 * manifest, and the one canonical `build.mjs`.
 *
 * Each extension is its own git repo with its own release CI, so this only
 * ever writes files that are additive or byte-equivalent in behaviour:
 *
 *   tedi.d.ts             new  - the typed API contract
 *   manifest.schema.json  new  - completion + validation inside manifest.json
 *   jsconfig.json         new  - turns the types on for plain JS
 *   manifest.json         adds "$schema" only; every parser here ignores
 *                         unknown keys (serde has no deny_unknown_fields,
 *                         Zod is passthrough), so it cannot affect install
 *   build.mjs             replaced with the canonical config, which derives
 *                         entry/outfile/banner from manifest.json instead of
 *                         hardcoding them - the 9 copies had already drifted
 *                         into 9 distinct hashes
 *   package.json          adds a "typecheck" script; leaves "check" alone
 *
 * Nothing under `src/` is touched.
 *
 *   node scripts/ext/ext-adopt-toolkit.mjs           # apply
 *   node scripts/ext/ext-adopt-toolkit.mjs --check   # report drift, change nothing
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extRoot = join(repoRoot, "extensions");
const templates = join(repoRoot, "src-tauri", "templates", "ext");
const checkOnly = process.argv.includes("--check");

const TEDI_D_TS = join(extRoot, "tedi.d.ts");
const SCHEMA = join(extRoot, "manifest.schema.json");
const BUILD_MJS = join(templates, "build.mjs");
const JSCONFIG = join(templates, "jsconfig.json");

/** Existing extensions carry thousands of lines of untyped JS written before
 *  any checker existed. `strict` there is an avalanche of pre-existing
 *  null-safety noise that buries the class of bug the types are actually for -
 *  a misspelled `ctx.*` member, a wrong argument shape. So the adopted config
 *  turns `checkJs` on and `strict` off; new extensions from `tedi ext create`
 *  start strict, where it costs nothing. */
const ADOPTED_JSCONFIG = JSON.parse(readFileSync(JSCONFIG, "utf8"));
ADOPTED_JSCONFIG["//"] =
  "Turns on type checking for plain JavaScript against tedi.d.ts, so a typo in a `ctx.*` call is an editor squiggle instead of a runtime TypeError inside an async handler. `strict` is off because this extension predates the checker; new extensions scaffolded by `tedi ext create` start strict.";
ADOPTED_JSCONFIG.compilerOptions.strict = false;

const changed = [];
const skipped = [];

function writeIfDifferent(path, body, label) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === body) return false;
  if (!checkOnly) writeFileSync(path, body, "utf8");
  changed.push(label);
  return true;
}

for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(extRoot, entry.name);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) continue;

  const before = changed.length;

  writeIfDifferent(
    join(dir, "tedi.d.ts"),
    readFileSync(TEDI_D_TS, "utf8"),
    `${entry.name}/tedi.d.ts`,
  );
  writeIfDifferent(
    join(dir, "manifest.schema.json"),
    readFileSync(SCHEMA, "utf8"),
    `${entry.name}/manifest.schema.json`,
  );
  writeIfDifferent(
    join(dir, "jsconfig.json"),
    JSON.stringify(ADOPTED_JSCONFIG, null, 2) + "\n",
    `${entry.name}/jsconfig.json`,
  );
  writeIfDifferent(
    join(dir, "build.mjs"),
    readFileSync(BUILD_MJS, "utf8"),
    `${entry.name}/build.mjs`,
  );

  // `$schema` first, so an editor picks it up before it has parsed the rest.
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  if (manifest.$schema !== "./manifest.schema.json") {
    const next = { $schema: "./manifest.schema.json", ...manifest };
    // Re-serialise with the file's own indentation so the diff is one line.
    const indent = /^\s+/m.exec(manifestText.split("\n")[1] ?? "")?.[0]?.length ?? 2;
    writeIfDifferent(
      manifestPath,
      JSON.stringify(next, null, indent) + "\n",
      `${entry.name}/manifest.json ($schema)`,
    );
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkgText = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(pkgText);
    pkg.scripts ??= {};
    if (pkg.scripts.typecheck !== "tsc -p jsconfig.json") {
      pkg.scripts.typecheck = "tsc -p jsconfig.json";
      pkg.devDependencies ??= {};
      pkg.devDependencies.typescript ??= "^5.9.0";
      writeIfDifferent(pkgPath, JSON.stringify(pkg, null, 2) + "\n", `${entry.name}/package.json`);
    }
  }

  if (changed.length === before) skipped.push(entry.name);
}

console.log(
  checkOnly ? `\n${changed.length} file(s) would change:` : `\n${changed.length} file(s) written:`,
);
for (const c of changed) console.log(`  ${c}`);
if (skipped.length) console.log(`\nalready current: ${skipped.join(", ")}`);
if (checkOnly && changed.length > 0) process.exit(1);
