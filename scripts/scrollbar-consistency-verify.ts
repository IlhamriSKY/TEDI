/**
 * Self-check for the one scrollbar style.
 * Run: `npx tsx scripts/scrollbar-consistency-verify.ts`.
 *
 * `globals.css` paints every native scrollbar in the app from a single rule,
 * and carries a long warning about the trap: in Chromium (WebView2), an element
 * with a non-initial `scrollbar-width` or `scrollbar-color` switches to the
 * modern CSS scrollbar UI and IGNORES every `::-webkit-scrollbar-*` rule,
 * including the global one. The element then wears the OS scrollbar - fat, with
 * arrow buttons on Windows 11 - next to the app's 10px boxy one.
 *
 * Nothing about that is loud: the CSS is valid, the element still scrolls, and
 * it only shows up in a screenshot of a narrow pane. The API Client's request
 * tab strip carried `scrollbar-width: thin` for exactly that reason.
 *
 * So: no stylesheet anywhere may set a scrollbar to a size or colour of its
 * own. Hiding one is fine (hidden means the same thing in both engines), which
 * is what `.no-scrollbar` and the Radix viewport override do.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(p, "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

// ---- the global rule still exists ----------------------------------------
const globals = read(join(root, "src/styles/globals.css"));
check(
  "the unified scrollbar rule is still there",
  /html\[data-chrome="borderless"\] \*::-webkit-scrollbar \{/.test(globals),
);
check("its thumb is the border token", /-thumb \{\s*background: var\(--border\)/.test(globals));

// ---- nobody re-styles a scrollbar ----------------------------------------
// Walk the app's own CSS plus every extension's style modules (CSS in a
// template literal, so a plain text scan is the only thing that reads both).
function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match.test(name)) out.push(full);
  }
  return out;
}

// Only what styles the TEDI window itself. An extension's `client/` or
// `server/` tree (Remote Access ships a browser SPA) is a separate document
// that cannot inherit globals.css, so it carries its own copy of this style and
// is none of this check's business.
const isAppChrome = (p: string) => !/[\\/](client|server)[\\/]/.test(p);
const files = [
  ...walk(join(root, "src"), /\.(css|tsx?)$/),
  ...walk(join(root, "extensions"), /\.(css|js)$/).filter(isAppChrome),
];
check("found stylesheets to scan", files.length > 20, files.length);

/** Prose is not a rule. Both plain CSS and the CSS-in-a-template-literal the
 *  extensions use carry `/* … *\/` comments that talk ABOUT these properties -
 *  including the warning in globals.css this check exists to enforce. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// `scrollbar-width` / `scrollbar-color` are only ever allowed to hide.
const offenders: string[] = [];
for (const file of files) {
  // The extensions/ tree holds built bundles too; they are generated from the
  // same sources already in the list, so a hit there is a duplicate.
  if (/[\\/]extension\.js$/.test(file)) continue;
  const text = stripComments(read(file));
  for (const m of text.matchAll(/scrollbar-(?:width|color)\s*:\s*([^;!}\n]+)/g)) {
    const value = m[1].trim();
    if (value === "none" || value === "initial" || value === "auto") continue;
    offenders.push(`${relative(root, file)}: ${m[0].trim()}`);
  }
}
check("no stylesheet sets a scrollbar width or colour of its own", offenders.length === 0, offenders);

// An extension may hide a scrollbar, never re-size or re-colour one.
const extRestyles: string[] = [];
for (const file of files.filter((f) => f.includes(`${"extensions"}`))) {
  if (/[\\/]extension\.js$/.test(file)) continue;
  const text = stripComments(read(file));
  for (const m of text.matchAll(/::-webkit-scrollbar[^{]*\{([^}]*)\}/g)) {
    const body = m[1];
    if (/display\s*:\s*none/.test(body)) continue;
    if (/^\s*(width|height)\s*:\s*0(px)?\s*;?\s*$/.test(body)) continue;
    extRestyles.push(`${relative(root, file)}: ${m[0].replace(/\s+/g, " ").slice(0, 80)}`);
  }
}
check("no extension re-styles a scrollbar (hiding is fine)", extRestyles.length === 0, extRestyles);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
