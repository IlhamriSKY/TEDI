/**
 * Keeps `InvokeResults` in `host.ts` honest about the Rust it describes.
 *
 * `ctx.invoke("shell_bg_logs", …)` resolves to a typed shape so plain-JS
 * extensions can read `.bytes` without a cast. That shape is transcribed by
 * hand from the `#[derive(Serialize)]` struct behind the command - which means
 * a Rust field rename turns the type into a confident lie, and a lie is worse
 * than the `unknown` it replaced: the author gets no error at the call site and
 * `undefined` at runtime.
 *
 * So this reads the struct fields straight back out of the Rust source and
 * compares them, including serde's `rename_all` casing. It checks NAMES, not
 * types: names are where renames and additions happen, and a full Rust->TS
 * type mapping would be a second compiler for no extra safety.
 *
 * Run: `npx tsx scripts/ext-invoke-types-verify.ts` (part of `pnpm verify`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rust = (rel: string): string => readFileSync(join(repoRoot, "src-tauri", "src", rel), "utf8");

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}: ${label}${detail ? ` - ${detail}` : ""}`);
}

const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Field names of `struct <name>`, in declaration order, with serde's
 * struct-level `rename_all` applied. Deliberately simple: every struct here is
 * a flat list of `pub field: Type,` lines, and a real Rust parser would be a
 * dependency to guard six types.
 */
function rustStructFields(source: string, name: string): string[] {
  const at = source.indexOf(`pub struct ${name} {`);
  if (at < 0) return [];
  // Look back a few lines for the serde attribute that governs casing.
  const preamble = source.slice(Math.max(0, at - 200), at);
  const renameAll = /rename_all\s*=\s*"([a-zA-Z]+)"/.exec(preamble)?.[1];
  const body = source.slice(at, source.indexOf("\n}", at));
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    // A per-field `#[serde(rename = "x")]` wins over the struct-level rule.
    const renamed = /#\[serde\(rename\s*=\s*"([^"]+)"\)\]/.exec(line)?.[1];
    if (renamed) {
      fields.push(renamed);
      continue;
    }
    const m = /^\s*pub\s+([a-z0-9_]+)\s*:/.exec(line);
    if (!m) continue;
    fields.push(renameAll === "camelCase" ? toCamel(m[1]) : m[1]);
  }
  return fields;
}

/**
 * Property names at the top level of one `InvokeResults` entry.
 *
 * Brace-counted rather than indent-matched: prettier is free to collapse a
 * short type literal onto one line, and an indent-based reader would then
 * report zero fields and "pass" a struct it never actually compared.
 */
function tsResultFields(source: string, command: string): string[] {
  const at = source.indexOf(`\n  ${command}: `);
  if (at < 0) return [];
  const start = source.indexOf("{", at);
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(start + 1, end);
  const out: string[] = [];
  depth = 0;
  // Walk the body tracking nesting so `hits: { path: string }[]` contributes
  // `hits` and not `path`.
  const token = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\??\s*:|[{}]/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(body)) !== null) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}") depth--;
    else if (depth === 0 && m[1]) out.push(m[1]);
  }
  return out;
}

const hostTs = readFileSync(join(repoRoot, "src", "modules", "extensions", "host.ts"), "utf8");
const shellMod = rust("modules/shell/mod.rs");
const shellBg = rust("modules/shell/background.rs");
const sshMod = rust("modules/ssh/mod.rs");
const fsGrep = rust("modules/fs/grep.rs");

/** command in `InvokeResults` -> the Rust struct that produces it. */
const CASES: { command: string; struct: string; source: string }[] = [
  { command: "shell_run_command", struct: "CommandOutput", source: shellMod },
  { command: "shell_bg_logs", struct: "BackgroundLogResponse", source: shellBg },
  { command: "shell_bg_list", struct: "BackgroundProcInfo", source: shellBg },
  { command: "ssh_list_sessions", struct: "SshSessionInfo", source: sshMod },
  { command: "fs_glob", struct: "GlobResponse", source: fsGrep },
];

console.log("\n[A] every documented invoke result still matches its Rust struct");
for (const { command, struct, source } of CASES) {
  const rustFields = rustStructFields(source, struct).sort();
  const tsFields = tsResultFields(hostTs, command).sort();
  check(
    `${command} (${struct})`,
    rustFields.length > 0 && rustFields.join(",") === tsFields.join(","),
    rustFields.length === 0
      ? `struct ${struct} not found - did it move or get renamed?`
      : `rust=[${rustFields}] ts=[${tsFields}]`,
  );
}

console.log("\n[B] the tagged fs_read_file union still lists every Rust variant");
const fileRs = rust("modules/fs/file.rs");
// `#[serde(tag = "kind", rename_all = "lowercase")]` on the enum, so each
// variant name lowercases into the `kind` discriminant.
const enumStart = fileRs.indexOf("pub enum ReadResult {");
const enumBody = fileRs.slice(enumStart, fileRs.indexOf("\n}", enumStart));
const variants = [...enumBody.matchAll(/^\s{4}([A-Z][A-Za-z]*)\s*\{/gm)].map((m) =>
  m[1].toLowerCase(),
);
const tsKinds = [...hostTs.matchAll(/\{ kind: "([a-z]+)"/g)].map((m) => m[1]);
check(
  "ReadResult variants",
  variants.length > 0 && variants.every((v) => tsKinds.includes(v)),
  `rust=[${variants}] ts=[${[...new Set(tsKinds)]}]`,
);

console.log("\n[C] the public .d.ts carries the same InvokeResults as the host");
const publicDts = readFileSync(join(repoRoot, "extensions", "tedi.d.ts"), "utf8");
for (const { command } of CASES) {
  const host = tsResultFields(hostTs, command).sort().join(",");
  const pub = tsResultFields(publicDts, command).sort().join(",");
  check(`${command} host vs tedi.d.ts`, host === pub && host.length > 0, `${host} | ${pub}`);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: ext-invoke-types-verify`);
process.exit(failed === 0 ? 0 : 1);
