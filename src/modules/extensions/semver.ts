/**
 * Tiny semver-ish constraint check, mirroring the Rust helper in
 * `src-tauri/src/modules/extensions/commands.rs`.
 *
 * Supports the constraint shapes extensions in this project actually use:
 * empty / `*` (any), `">=X.Y.Z"`, `">X.Y.Z"`, `"<=X.Y.Z"`, `"<X.Y.Z"`,
 * `"=X.Y.Z"`, and plain `"X.Y.Z"` (exact). A leading `v` on either side is
 * stripped before compare so `v0.3.9` and `0.3.9` are equivalent.
 *
 * No npm `semver` dep on purpose - the host has zero ecosystem-grade
 * constraint shapes to support and a 30-line helper keeps the boot path
 * dependency-free.
 */

function stripV(s: string): string {
  return s.replace(/^[vV]/, "");
}

/** Lenient version compare: split on any non-digit, parse each piece as a
 *  base-10 int (0 on parse failure), compare lexicographically. Missing
 *  trailing segments count as 0. */
function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (s: string) =>
    s
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length, 1);
  for (let i = 0; i < len; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function satisfies(constraint: string | null | undefined, host: string): boolean {
  const raw = (constraint ?? "").trim();
  if (raw === "" || raw === "*") return true;
  let op = "=";
  let rest = raw;
  for (const prefix of [">=", "<=", ">", "<", "="] as const) {
    if (raw.startsWith(prefix)) {
      op = prefix;
      rest = raw.slice(prefix.length);
      break;
    }
  }
  const target = stripV(rest.trim());
  const ord = compareVersions(stripV(host), target);
  switch (op) {
    case ">=":
      return ord >= 0;
    case ">":
      return ord > 0;
    case "<=":
      return ord <= 0;
    case "<":
      return ord < 0;
    default:
      return ord === 0;
  }
}
