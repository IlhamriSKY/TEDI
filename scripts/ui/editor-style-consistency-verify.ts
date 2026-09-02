/**
 * Self-check for "every code editor in TEDI looks like the same editor".
 * Run: `npx tsx scripts/ui/editor-style-consistency-verify.ts`.
 *
 * There are TWO CodeMirror themes in the app and they are easy to let drift:
 *
 *   - `editor/lib/extensions.ts` `buildSharedExtensions()` is the editor pane,
 *     and the AI-diff and git-diff panes build on top of it, so those three
 *     cannot disagree by construction.
 *   - `extensions/codeEditor.ts` is the one behind `ctx.ui.codeEditor`, a
 *     separate theme object mounted into an extension's own DOM. SQL Explorer
 *     and API Client both use it.
 *
 * Only the second one can drift, and drift there is invisible from the core
 * repo: you see it in someone else's panel. It shipped with `.cm-content`
 * `padding: 8px 0`, so both those extensions opened with a gap above the first
 * line that no other editor in the app had, under a comment claiming the theme
 * matched the pane.
 *
 * So: the GEOMETRY and TYPOGRAPHY declarations that decide whether two editors
 * look alike must be present and identical in both. Colour rules are excluded
 * on purpose (the pane reads a user-selected editor theme, this one does not).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
  } else {
    console.error(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

const PANE = "src/modules/editor/lib/extensions.ts";
const EXT = "src/modules/extensions/codeEditor.ts";
const pane = read(PANE);
const ext = read(EXT);

console.log("1. geometry: the first line sits in the same place in both");
// The gap bug. A top padding on either the root or the content box pushes line
// 1 down, and only one of the two files had one.
for (const [label, src] of [
  ["editor pane", pane],
  ["ctx.ui.codeEditor", ext],
] as const) {
  check(
    `${label}: root padding is "0 0 0 8px" (flush top/right/bottom, gutter breathing room left)`,
    /padding:\s*"0 0 0 8px"/.test(src),
  );
  check(
    `${label}: .cm-content sets no top/bottom padding of its own`,
    !/"\.cm-content":\s*\{[^}]*\bpadding:\s*"(?!0")/.test(src),
    src.match(/"\.cm-content":\s*\{[^}]*\}/s)?.[0]?.replace(/\s+/g, " "),
  );
  check(`${label}: .cm-line indents by 4px`, /"\.cm-line":\s*\{[^}]*paddingLeft:\s*"4px"/s.test(src));
}

console.log("\n2. typography: the same font, size, ligatures and line height");
// Read out of the pane rather than hard-coded here, so changing the pane's font
// stack is a one-file edit that this check then enforces on the other editor.
const TYPO = [
  /fontFamily:\s*(`[^`]+`)/,
  /fontVariantLigatures:\s*("[^"]+")/,
  /fontSize:\s*("[^"]+")/,
  /lineHeight:\s*("[^"]+")/,
] as const;
for (const re of TYPO) {
  const want = pane.match(re)?.[1];
  const got = ext.match(re)?.[1];
  check(
    `${re.source.split(":")[0]} matches the editor pane`,
    want !== undefined && want === got,
    { pane: want, ext: got },
  );
}

console.log("\n3. gutters: scrolled code cannot bleed through the line numbers");
// The pane learned this the hard way; the extension editor never had it, and
// SQL and a long request URL are exactly the documents that scroll sideways.
for (const [label, src] of [
  ["editor pane", pane],
  ["ctx.ui.codeEditor", ext],
] as const) {
  const gutters = src.match(/"\.cm-gutters":\s*\{[^}]*\}/s)?.[0] ?? "";
  check(`${label}: .cm-gutters paints a solid background`, /backgroundColor:\s*"var\(--background\) !important"/.test(gutters));
  check(`${label}: .cm-gutters sits above the scrolled content`, /zIndex:\s*"3"/.test(gutters));
  check(`${label}: .cm-gutter itself stays transparent`, /"\.cm-gutter":\s*\{\s*backgroundColor:\s*"transparent !important"/.test(src));
}

if (failed > 0) throw new Error(`editor-style-consistency-verify: ${failed} check(s) failed`);
console.log("\nAll checks passed: both CodeMirror themes agree on geometry and typography.");
