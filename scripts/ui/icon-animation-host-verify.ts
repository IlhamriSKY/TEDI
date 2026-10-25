/**
 * Self-check for "a looping icon animation never runs on the <svg>".
 * Run: `npx tsx scripts/ui/icon-animation-host-verify.ts`.
 *
 * Chromium cannot composite an animation on an SVG element, so a breathing
 * agent glyph cost a style recalc + paint on the main thread EVERY frame, and an
 * inactive tab (`invisible`, still mounted) kept paying for glyphs nobody saw.
 * Measured live on v0.4.70 with Claude Code running, 12 breathing glyphs, median
 * of 6 rounds: GPU process 36% -> 29% of a core, renderer 31% -> 21%, which is
 * what pausing every animation gives. Nothing about
 * `className={cn(..., "animate-ai-breathe")}` on an icon LOOKS wrong, which is
 * why this is source-text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failed++;
  }
}

console.log("\nlooping icon animations live on an HTML wrapper\n");

const STATUS = "src/modules/terminal/lib/aiCliStatus.ts";
const motion = read(STATUS).match(/export function aiCliIconMotionClass[\s\S]*?\n}/)?.[0] ?? "";
check(`${STATUS}: aiCliIconMotionClass exists`, motion !== "");
check(`${STATUS}: the motion class carries no colour`, motion !== "" && !motion.includes("text-"));

const LEAF = "src/components/LeafIcon.tsx";
const leaf = read(LEAF);
check(`${LEAF}: wraps the animation in <Motion>`, /<Motion className=\{aiMotion\}>/.test(leaf));
check(`${LEAF}: Motion renders a span`, /function Motion[\s\S]*?<span className=/.test(leaf));

// Any icon component (capitalised JSX tag) whose own className animates.
const ICON_ANIM = /<[A-Z]\w*\s[^>]*className=\{cn\([^)]*animate-(ai-breathe|pulse)/;
for (const p of [
  LEAF,
  "src/components/ai-elements/tool.tsx",
  "src/modules/extensions/components/ExtensionStatusItems.tsx",
]) {
  check(`${p}: no icon component animates its own className`, !ICON_ANIM.test(read(p)));
}

const CSS = "src/styles/globals.css";
check(
  `${CSS}: hidden tabs stop the decorative loops`,
  /\.invisible :is\(\.animate-ai-breathe, \.ai-breathe-settle, \.animate-pulse\)\s*\{\s*animation: none;/.test(
    read(CSS),
  ),
);

console.log(
  failed === 0
    ? "\nicon-animation-host-verify: OK\n"
    : `\nicon-animation-host-verify: ${failed} FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
