#!/usr/bin/env node
// Enforces the module import discipline documented in TEDI.md and CONTRIBUTING.md:
//
//   "Imports: always @/..., never relative across modules."
//
// A file may use relative imports WITHIN its own unit, but must reach any other
// unit through the `@/*` alias. A unit is one `src/modules/<mod>/`, or one of
// the other top-level trees under `src/`. This guard flags relative specifiers
// that escape the importing file's own unit. It has zero dependencies so it
// never touches the lockfile; run it with `node scripts/check-imports.mjs`
// (npm script: lint:imports).
//
// The trees beyond `src/modules/` were once unchecked, and were clean anyway.
// They are covered now so they stay that way: the rule was always universal,
// only the check was partial.
//
// Exit code 0 = clean, 1 = violations found.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname, sep, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = join(ROOT, "src");

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

/**
 * The unit that owns `file`: `src/modules/<mod>` for a module file, else the
 * top-level tree under `src/` (`src/app`, `src/lib`, ...).
 */
function unitDirOf(file) {
  const rel = relative(SRC, file); // e.g. modules/ai/lib/agent.ts, or app/App.tsx
  const [first, second] = rel.split(sep);
  return first === "modules" ? join(SRC, first, second) : join(SRC, first);
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

for (const file of walk(SRC)) {
  // `src/main.tsx` and friends sit directly in `src/` and belong to no unit.
  if (dirname(file) === SRC) continue;
  const ownDir = unitDirOf(file) + sep;
  const src = readFileSync(file, "utf8");
  for (const spec of specifiers(src)) {
    if (!spec.startsWith(".")) continue; // alias or package import - fine
    const resolved = resolve(dirname(file), spec) + sep;
    if (!resolved.startsWith(ownDir)) {
      violations.push({
        file: relative(ROOT, file),
        spec,
        hint: `resolves outside ${relative(ROOT, unitDirOf(file))}; use the @/ alias instead`,
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
