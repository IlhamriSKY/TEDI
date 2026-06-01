#!/usr/bin/env node
// Enforces the module import discipline documented in TEDI.md and CONTRIBUTING.md:
//
//   "Imports: always @/..., never relative across modules."
//
// A file under src/modules/<mod>/ may use relative imports WITHIN its own module,
// but must reach any other module (or src/lib, src/components, ...) through the
// `@/*` alias. This guard flags relative specifiers that escape the importing
// file's own module directory. It has zero dependencies so it never touches the
// lockfile; run it with `node scripts/check-imports.mjs` (npm script: lint:imports).
//
// Exit code 0 = clean, 1 = violations found.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname, sep, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MODULES_DIR = join(ROOT, "src", "modules");

/** Recursively collect .ts/.tsx files under a directory. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** The module directory that owns `file`, e.g. .../src/modules/ai. */
function moduleDirOf(file) {
  const rel = relative(MODULES_DIR, file); // e.g. ai/lib/agent.ts
  const seg = rel.split(sep)[0];
  return join(MODULES_DIR, seg);
}

// Matches `... from "x"` (import/export) and bare `import "x"`.
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const BARE_RE = /\bimport\s*["']([^"']+)["']/g;

function specifiers(src) {
  const out = new Set();
  let m;
  while ((m = FROM_RE.exec(src))) out.add(m[1]);
  while ((m = BARE_RE.exec(src))) out.add(m[1]);
  return [...out];
}

const violations = [];

for (const file of walk(MODULES_DIR)) {
  const ownModuleDir = moduleDirOf(file) + sep;
  const src = readFileSync(file, "utf8");
  for (const spec of specifiers(src)) {
    if (!spec.startsWith(".")) continue; // alias or package import - fine
    const resolved = resolve(dirname(file), spec) + sep;
    if (!resolved.startsWith(ownModuleDir)) {
      violations.push({
        file: relative(ROOT, file),
        spec,
        hint: `resolves outside ${relative(ROOT, moduleDirOf(file))}; use the @/ alias instead`,
      });
    }
  }
}

if (violations.length === 0) {
  console.log("check-imports: OK - no cross-module relative imports.");
  process.exit(0);
}

console.error(`check-imports: ${violations.length} cross-module relative import(s) found:\n`);
for (const v of violations) {
  console.error(`  ${v.file}\n    import "${v.spec}"  (${v.hint})`);
}
console.error('\nReplace relative cross-module imports with the "@/..." alias.');
process.exit(1);
