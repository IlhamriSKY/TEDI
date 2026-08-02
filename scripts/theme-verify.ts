/**
 * Self-check for the theme system.
 * Run: `npx tsx scripts/theme-verify.ts`.
 *
 * The failure this exists for is silent and was real: `--tedi-icon-done` was
 * added to globals.css with a hard-coded blue and no `ThemeColors` key, so the
 * "finished" badge stayed blue under EVERY preset and no error was raised
 * anywhere. Any themable colour var must be reachable from a theme, and any
 * theme key must be editable in Settings, or it silently stops being a theme.
 *
 * Checks:
 *   - every `--tedi-*` COLOUR var declared in globals.css is written by either
 *     the app theme (COLOR_VAR_MAP) or the terminal palette,
 *   - every `--tedi-*` var a theme WRITES is read by some CSS/component, so a
 *     colour picker in Settings can never be a knob that moves nothing
 *     (`--tedi-button-border` was exactly that until the outline button
 *     started reading it),
 *   - every non-ANSI key is editable in the Settings colour editor
 *     (ANSI 16 live under Settings > Terminal instead),
 *   - preset names and their derived terminal-preset slugs are unique
 *     (a duplicate slug would silently shadow another terminal preset).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { THEME_PRESETS } from "../src/modules/settings/themePresets";
import { COLOR_FIELDS } from "../src/settings/sections/theme/colorFields";
import { slugify } from "../src/lib/utils";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const css = read("src/styles/globals.css");
const customThemeSrc = read("src/modules/settings/customTheme.ts");
const terminalSrc = read("src/modules/settings/terminalPalette.ts");

// COLOR_VAR_MAP is source-scanned rather than imported: customTheme.ts touches
// `document` at module scope through its Tauri imports, and this only needs the
// var names.
const mapBody = /const COLOR_VAR_MAP[\s\S]*?\n};/.exec(customThemeSrc)?.[0] ?? "";
const appVars = new Set([...mapBody.matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]));
check("COLOR_VAR_MAP parsed", appVars.size > 30, appVars.size);

const termVars = new Set([...terminalSrc.matchAll(/"(--tedi-term-[a-z0-9-]+)"/g)].map((m) => m[1]));
check("terminal palette vars parsed", termVars.size === 20, termVars.size);

// Vars that are NOT colours a theme should own: layout/typography knobs and
// values derived at runtime from other tokens.
const NON_THEMABLE = new Set([
  "--tedi-app-opacity",
  "--tedi-canvas-bg", // written by applyCustomTheme from `background`
  "--tedi-editor-font-size",
  "--tedi-mono-font",
  "--tedi-glass-surface",
  "--tedi-glass-header",
  "--tedi-glass-menu",
  // Follow the EDITOR theme, not the app theme (see modules/editor/lib/diffColors.ts).
  "--tedi-editor-diff-added",
  "--tedi-editor-diff-removed",
]);

const declared = new Set([...css.matchAll(/^\s*(--tedi-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
check("globals.css vars parsed", declared.size > 40, declared.size);

for (const v of declared) {
  if (NON_THEMABLE.has(v)) continue;
  check(`${v} is themable`, appVars.has(v) || termVars.has(v));
}

// The reverse direction, and the other half of the same bug: a theme token that
// nothing reads is a dead knob - the Settings colour picker changes it and the
// UI never moves. `--tedi-button-border` was exactly that.
const sources = collectSources(join(root, "src"));
for (const v of appVars) {
  if (!v.startsWith("--tedi-")) continue;
  check(
    `${v} is read by something`,
    sources.some((s) => s.body.includes(v)),
  );
}

function collectSources(dir: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(p));
    } else if (/\.(css|ts|tsx)$/.test(entry.name) && !p.endsWith("customTheme.ts")) {
      // customTheme.ts is excluded: it is the WRITER, so counting it would make
      // every token look read.
      out.push({ path: p, body: readFileSync(p, "utf8") });
    }
  }
  return out;
}

// No component may paint with a fixed Tailwind hue: `bg-emerald-500` and
// friends ignore the theme entirely. The Claude/Codex usage meter shipped that
// way (emerald/amber/red bars in every preset, warm or monochrome) until it was
// moved onto the icon triad. Every colour must come from a token.
const RAW_HUE =
  /\b(?:text|bg|border|from|via|to|ring|fill|stroke|shadow|decoration|outline|accent|caret|divide)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/g;
const rawHits = sources.flatMap((s) =>
  [...s.body.matchAll(RAW_HUE)].map((m) => `${s.path.slice(root.length + 1)}: ${m[0]}`),
);
check("no raw Tailwind hues in components", rawHits.length === 0, rawHits.slice(0, 8));

// Editable in Settings > Theme, except the ANSI 16 (Settings > Terminal).
const editable = new Set(COLOR_FIELDS.map((f) => f.key));
const sample = THEME_PRESETS[0].dark;
for (const key of Object.keys(sample)) {
  if (key.startsWith("ansi")) continue;
  check(`${key} is editable in Settings`, editable.has(key as keyof typeof sample));
}

// Presets: unique names, and unique slugs (TERMINAL_PRESETS keys off the slug).
const names = THEME_PRESETS.map((p) => p.name);
check("preset names are unique", new Set(names).size === names.length, names);
const slugs = names.map((n) => slugify(n, "preset"));
check("terminal preset slugs are unique", new Set(slugs).size === slugs.length, slugs);

// Both variants of every preset carry every key with a non-empty value:
// a preset is spread from a base, so a typo'd key name would leave the base
// value in place AND add a dead one.
const keys = Object.keys(sample);
for (const p of THEME_PRESETS) {
  for (const variant of ["light", "dark"] as const) {
    const colors = p[variant] as Record<string, string>;
    const missing = keys.filter((k) => !colors[k]);
    const extra = Object.keys(colors).filter((k) => !keys.includes(k));
    check(`${p.name} ${variant} is complete`, missing.length === 0 && extra.length === 0, {
      missing,
      extra,
    });
  }
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
