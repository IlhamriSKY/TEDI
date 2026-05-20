/**
 * Brand color runtime applier.
 *
 * The base palette is defined statically in `src/styles/globals.css`. When the
 * user picks a custom primary color, override the relevant CSS variables on
 * `:root` so every shadcn/Tailwind component (buttons, rings, sidebar accents,
 * focus outlines) re-tints without a reload. We also derive `--accent` /
 * `--sidebar-accent` from the brand so soft-fill surfaces stay in family
 * instead of staying blue when the brand drifts to red/green/etc.
 */

import { BRAND_COLOR_DEFAULT, normalizeBrandColor } from "./store";

const FAST_PATH_KEY = "tedi-brand-color-shadow";

// CSS vars driven directly by the brand hex (identical in light & dark).
const PRIMARY_VARS = [
  "--primary",
  "--ring",
  "--sidebar-primary",
  "--sidebar-ring",
] as const;

type RGB = { r: number; g: number; b: number };

function hexToRgb(hex: string): RGB {
  const v = normalizeBrandColor(hex).slice(1);
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: RGB): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Linear interpolation between two colors. `t` is the brand share (0..1).
function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r * (1 - t) + b.r * t,
    g: a.g * (1 - t) + b.g * t,
    b: a.b * (1 - t) + b.b * t,
  };
}

// sRGB relative luminance per WCAG. Used to pick black vs white foreground.
function luminance({ r, g, b }: RGB): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function readShadow(): string {
  if (typeof window === "undefined") return BRAND_COLOR_DEFAULT;
  const v = window.localStorage.getItem(FAST_PATH_KEY);
  return v ? normalizeBrandColor(v) : BRAND_COLOR_DEFAULT;
}

function writeShadow(value: string): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, value);
  } catch {
    // ignore — localStorage may be unavailable in some embeddings
  }
}

/**
 * Apply a brand color to the document. Resolves the current theme from the
 * `.dark` class on `<html>` so accent derivation matches the active mode.
 */
export function applyBrandColor(hex: string): void {
  if (typeof document === "undefined") return;
  const color = normalizeBrandColor(hex);
  const root = document.documentElement;
  const isDark = root.classList.contains("dark");

  for (const v of PRIMARY_VARS) root.style.setProperty(v, color);

  const brand = hexToRgb(color);
  // Light: 85% white + 15% brand → soft tinted surface (matches the original
  // #dbe5ff for the default blue). Dark: 56% black + 44% brand → deep
  // saturated accent (matches the original #0a2870 for the default blue).
  const accent = isDark
    ? mix({ r: 0, g: 0, b: 0 }, brand, 0.44)
    : mix({ r: 255, g: 255, b: 255 }, brand, 0.15);
  const accentHex = rgbToHex(accent);
  root.style.setProperty("--accent", accentHex);
  root.style.setProperty("--sidebar-accent", isDark ? accentHex : accentHex);

  // Contrasting foreground for `--primary`. White reads fine on saturated
  // mid-tones (the default blue); switch to black when the brand is light
  // enough that white would fail WCAG (e.g. a pastel yellow pick).
  const fg = luminance(brand) > 0.6 ? "#000000" : "#ffffff";
  root.style.setProperty("--primary-foreground", fg);
  root.style.setProperty("--sidebar-primary-foreground", fg);

  writeShadow(color);
}

/**
 * Synchronous fast-path. Call before React mounts so the initial paint uses
 * the persisted brand color instead of flashing the default blue. The
 * persistent store hydration overrides this shortly after.
 */
export function applyBrandColorFastPath(): void {
  applyBrandColor(readShadow());
}
