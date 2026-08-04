/**
 * The 3:1 floor for the outline-button border, enforced on every theme payload
 * that comes off disk or out of a `.tedi` file.
 *
 * An outline button is drawn by its border ALONE, so below WCAG 1.4.11's 3:1
 * the control is not "subtle", it is missing: a dialog's Cancel reads as bare
 * text. The presets were retuned to clear it and `scripts/theme-verify.ts`
 * keeps them there, but that only covers the presets - picking one SNAPSHOTS
 * its colours into `customTheme` (ThemeSection's `onPickPreset`), so a palette
 * saved before the retune keeps its old hairline forever. The retuned default
 * is only a fallback for keys the payload is MISSING, and this one is present.
 * Measured on such a snapshot: `#3a3a3a` on a `#363636` popover is 1.06:1.
 *
 * Kept free of Tauri imports (the `ThemeColors` import is type-only, so it is
 * erased at compile time) so `scripts/theme-verify.ts` can exercise the real
 * function under plain node instead of a copy that can drift.
 */
import type { ThemeColors } from "./customTheme";

/** Surfaces an outline button can sit on. Its border has to clear the floor on
 *  the WORST of them, not just on the app canvas. */
const SURFACES = ["background", "card", "popover"] as const;

/** WCAG 1.4.11: a control boundary needs 3:1 against what it sits on. */
export const MIN_BORDER_CONTRAST = 3;

const HEX = /^#[0-9a-f]{6}$/i;

export function relLuminance(hex: string): number {
  return [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Scale a hex toward white (`target` 255) or black (0), keeping its hue. */
function shiftToward(hex: string, target: 0 | 255, amount: number): string {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.max(0, Math.min(255, Math.round(v + (target - v) * amount)));
  });
  return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Return `colors` with a `buttonBorder` that clears 3:1 against every surface a
 * button can sit on, derived from the theme's own hue when the stored one does
 * not. Returns the input untouched when it already passes, so it is idempotent
 * and safe to run on every load.
 *
 * Applied at the persistence boundary (`normalizeCustomTheme`), NOT on write:
 * clamping mid-edit would make the colour picker in Settings fight the drag.
 */
export function ensureVisibleButtonBorder(colors: ThemeColors): ThemeColors {
  const border = colors.buttonBorder;
  if (!HEX.test(border)) return colors;
  const surfaces = SURFACES.map((k) => colors[k]).filter((s) => HEX.test(s));
  if (surfaces.length === 0) return colors;
  const worst = surfaces.reduce((a, b) =>
    contrastRatio(border, a) <= contrastRatio(border, b) ? a : b,
  );
  if (contrastRatio(border, worst) >= MIN_BORDER_CONTRAST) return colors;
  // Move AWAY from the surface that beat it: lighten on a dark theme, darken on
  // a light one. 5% steps keep the result near the author's hue instead of
  // snapping to a generic grey.
  const target = relLuminance(worst) < 0.5 ? 255 : 0;
  for (let amount = 0.05; amount <= 1.0001; amount += 0.05) {
    const next = shiftToward(border, target, amount);
    if (contrastRatio(next, worst) >= MIN_BORDER_CONTRAST) return { ...colors, buttonBorder: next };
  }
  // Unreachable for any real surface (pure white or black clears 3:1 against
  // everything up to a mid grey), but a border must never be left invisible.
  return { ...colors, buttonBorder: target === 255 ? "#ffffff" : "#000000" };
}
