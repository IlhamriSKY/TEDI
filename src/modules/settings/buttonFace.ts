/**
 * Contrast floors for the neutral button (`variant="outline"`), applied to
 * every theme payload in `normalizeCustomTheme`.
 *
 * Two floors, because a fill can fail two ways: invisible against the surface,
 * or visible with an unreadable label. Deriving only the first left Solarized
 * dark's text at 2.64:1 - hence `buttonFaceForeground` is its own key.
 *
 * No Tauri imports (the ThemeColors import is type-only) so theme-verify can
 * run the real functions under node.
 */
import type { ThemeColors } from "./customTheme";

/** A button can land on any of these, so the floor applies to the worst one. */
const SURFACES = ["background", "card", "popover"] as const;

/**
 * Not WCAG's 3:1 - that is for a control drawn by its boundary, and it is out
 * of scale here: every existing surface separation in the presets measures
 * 1.04-1.53, so a 3:1 fill would make every Cancel a slab. 1.5 sits at the top
 * of that range. Presets ship ~1.8; this is the floor for imported themes.
 */
export const MIN_FACE_CONTRAST = 1.5;

/** WCAG AA for the label on its own face. */
export const MIN_FACE_TEXT_CONTRAST = 4.5;

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

/** The surface `face` reads worst against, or null when none are usable hex. */
function worstSurface(colors: ThemeColors, face: string): string | null {
  const surfaces = SURFACES.map((k) => colors[k]).filter((s) => HEX.test(s));
  if (surfaces.length === 0) return null;
  return surfaces.reduce((a, b) => (contrastRatio(face, a) <= contrastRatio(face, b) ? a : b));
}

/**
 * Enforce both floors, keeping the theme's own hue. Idempotent - returns the
 * input untouched when it passes. Called from `normalizeCustomTheme` (on read,
 * not on write: clamping mid-edit would fight the colour picker).
 *
 * This guarantee is what lets extensions read `--tedi-button-face` directly.
 */
export function ensureVisibleButtonFace(colors: ThemeColors): ThemeColors {
  let out = colors;

  // ---- 1. the face against the surfaces behind it --------------------------
  const face = out.buttonFace;
  if (HEX.test(face)) {
    const worst = worstSurface(out, face);
    if (worst !== null && contrastRatio(face, worst) < MIN_FACE_CONTRAST) {
      // Away from the surface that beat it: lighter on dark, darker on light.
      const target: 0 | 255 = relLuminance(worst) < 0.5 ? 255 : 0;
      let repaired = target === 255 ? "#ffffff" : "#000000";
      for (let amount = 0.05; amount <= 1.0001; amount += 0.05) {
        const next = shiftToward(face, target, amount);
        // Re-read the worst surface each step: shifting can swap which one it is.
        const w = worstSurface(out, next);
        if (w === null || contrastRatio(next, w) >= MIN_FACE_CONTRAST) {
          repaired = next;
          break;
        }
      }
      out = { ...out, buttonFace: repaired };
    }
  }

  // ---- 2. the label, judged against the face settled above -----------------
  const settledFace = out.buttonFace;
  const text = out.buttonFaceForeground;
  if (HEX.test(text) && HEX.test(settledFace)) {
    if (contrastRatio(text, settledFace) < MIN_FACE_TEXT_CONTRAST) {
      // Away from the face: a dark face takes light text and vice versa.
      const target: 0 | 255 = relLuminance(settledFace) < 0.5 ? 255 : 0;
      let repaired = target === 255 ? "#ffffff" : "#000000";
      for (let amount = 0.05; amount <= 1.0001; amount += 0.05) {
        const next = shiftToward(text, target, amount);
        if (contrastRatio(next, settledFace) >= MIN_FACE_TEXT_CONTRAST) {
          repaired = next;
          break;
        }
      }
      out = { ...out, buttonFaceForeground: repaired };
    }
  }

  return out;
}
