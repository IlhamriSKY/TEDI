/**
 * Generates and verifies `extensions/manifest.schema.json`, the JSON Schema an
 * extension author points `"$schema"` at to get completion, hover docs and
 * inline validation while writing `manifest.json`.
 *
 * The schema is DERIVED from the same Zod `ManifestSchema` the host parses
 * with, so it cannot drift into rejecting a manifest the app accepts (or
 * blessing one it does not). The field descriptions live as `.meta()` on that
 * schema, next to the validation they describe, rather than in a second
 * hand-maintained copy.
 *
 *   tsx scripts/ext/ext-schema-verify.ts            # verify the committed file
 *   tsx scripts/ext/ext-schema-verify.ts --write    # regenerate it
 *
 * `verify-all.mjs` runs the no-flag form, so a `.meta()` edit that is not
 * regenerated fails CI with the exact command to fix it.
 *
 * It also checks the reverse direction: every bundled extension's real
 * manifest still validates. `ManifestSchema` is the authority there, not a
 * JSON-Schema validator - adding `ajv` to typecheck four files a year is the
 * kind of dependency this repo does not need.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { ManifestSchema, safeParseManifest } from "../../src/modules/extensions/manifest";
import { KNOWN_PERMISSIONS } from "../../src/modules/extensions/permissions";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemaPath = join(repoRoot, "extensions", "manifest.schema.json");
const write = process.argv.includes("--write");

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}: ${label}${detail ? ` - ${detail}` : ""}`);
}

/**
 * `io: "input"` is what an author WRITES, which is the whole point of a
 * manifest schema: `permissions` and `contributes` both carry a `.default()`,
 * so the output view marks them required and would red-squiggle a perfectly
 * valid two-field hello-world manifest.
 */
function build(): Record<string, unknown> {
  const schema = z.toJSONSchema(ManifestSchema, { io: "input" }) as Record<string, unknown>;
  return {
    ...schema,
    $id: "https://tedi.ilhamriski.com/schema/manifest.schema.json",
  };
}

const generated = JSON.stringify(build(), null, 2) + "\n";

if (write) {
  writeFileSync(schemaPath, generated, "utf8");
  console.log(`wrote ${schemaPath}`);
}

console.log("\n[A] committed schema matches the live Zod schema");
let committed = "";
try {
  committed = readFileSync(schemaPath, "utf8");
} catch {
  committed = "";
}
check(
  "extensions/manifest.schema.json is up to date",
  committed === generated,
  committed ? "run: tsx scripts/ext/ext-schema-verify.ts --write" : "file missing; run with --write",
);

console.log("\n[B] the schema stays PERMISSIVE (never stricter than the host)");
const parsed = committed ? (JSON.parse(committed) as Record<string, unknown>) : {};
const props = (parsed.properties ?? {}) as Record<string, { anyOf?: unknown[] }>;
// A closed `additionalProperties: false` would reject `$schema` itself, plus
// every field a newer TEDI adds - the exact "ghost install" failure the Zod
// schema's passthrough exists to prevent.
check(
  "top level allows unknown keys",
  parsed.additionalProperties === undefined || typeof parsed.additionalProperties === "object",
  `additionalProperties=${JSON.stringify(parsed.additionalProperties)}`,
);
// The permission list must SUGGEST without REJECTING: an `anyOf` of
// [enum, string], never a bare enum.
const permItems = (props.permissions as { items?: { anyOf?: unknown[] } } | undefined)?.items;
check("permissions suggest-but-accept-anything", Array.isArray(permItems?.anyOf), "expected anyOf");
const permEnum = permItems?.anyOf?.find(
  (b): b is { enum: string[] } =>
    typeof b === "object" && b !== null && Array.isArray((b as { enum?: unknown }).enum),
);
check(
  "permission enum lists every KNOWN_PERMISSIONS entry",
  permEnum?.enum?.length === KNOWN_PERMISSIONS.length &&
    KNOWN_PERMISSIONS.every((p) => permEnum.enum.includes(p)),
  `${permEnum?.enum?.length ?? 0} vs ${KNOWN_PERMISSIONS.length}`,
);

console.log("\n[C] a minimal manifest is valid (nothing required beyond id/name/version)");
const required = (parsed.required ?? []) as string[];
check(
  "required = id, name, version",
  required.slice().sort().join(",") === "id,name,version",
  required.join(","),
);

console.log("\n[D] every bundled extension's manifest still parses");
const extDir = join(repoRoot, "extensions");
let seen = 0;
for (const entry of readdirSync(extDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let text: string;
  try {
    text = readFileSync(join(extDir, entry.name, "manifest.json"), "utf8");
  } catch {
    continue; // not an extension folder (template/, node_modules/, ...)
  }
  seen++;
  const result = safeParseManifest(JSON.parse(text));
  check(entry.name, result.ok, result.ok ? "" : result.error);
}
// Zero manifests would make section D vacuously green on a fresh clone, where
// `/extensions/*/` is gitignored and nothing is checked out.
console.log(`  (${seen} manifest${seen === 1 ? "" : "s"} checked)`);

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: ext-schema-verify`);
process.exit(failed === 0 ? 0 : 1);
