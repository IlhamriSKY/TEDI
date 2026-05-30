/**
 * Brand color runtime applier. Overrides primary CSS variables on `:root`
 * so components re-tint without a reload. Derives `--accent` and
 * `--sidebar-accent` from the brand so soft-fill surfaces stay in family.
 */

import { BRAND_COLOR_DEFAULT, normalizeBrandColor } from "./store";

const FAST_PATH_KEY = "tedi-brand-color-shadow";

// CSS vars driven directly by the brand hex. Identical in light and dark.
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

// Linear interpolation between two colors. `t` is the brand share (0 to 1).
function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r * (1 - t) + b.r * t,
    g: a.g * (1 - t) + b.g * t,
    b: a.b * (1 - t) + b.b * t,
  };
}

// sRGB relative luminance per WCAG. Picks black vs white foreground.
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

/**
 * Read the last-applied brand hex synchronously from the localStorage shadow.
 * Kept current by `applyBrandColor` (writeShadow) within the window, so callers
 * that only need the fallback brand can avoid a full `loadPreferences()` IPC
 * roundtrip.
 */
export function readBrandShadow(): string {
  return readShadow();
}

function writeShadow(value: string): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, value);
  } catch {
    // ignore. localStorage may be unavailable in some embeddings.
  }
}

/**
 * Apply a brand color to the document. Reads the current theme from the
 * `.dark` class on `<html>` so accent derivation matches.
 */
export function applyBrandColor(hex: string): void {
  if (typeof document === "undefined") return;
  const color = normalizeBrandColor(hex);
  const root = document.documentElement;
  const isDark = root.classList.contains("dark");

  for (const v of PRIMARY_VARS) root.style.setProperty(v, color);

  const brand = hexToRgb(color);
  // Light: 85% white + 15% brand for a soft surface (matches #dbe5ff at default).
  // Dark: 56% black + 44% brand for a deep accent (matches #0a2870 at default).
  const accent = isDark
    ? mix({ r: 0, g: 0, b: 0 }, brand, 0.44)
    : mix({ r: 255, g: 255, b: 255 }, brand, 0.15);
  const accentHex = rgbToHex(accent);
  root.style.setProperty("--accent", accentHex);
  root.style.setProperty("--sidebar-accent", isDark ? accentHex : accentHex);

  // Contrasting foreground for `--primary`. Black on light brands (pastel yellows etc.) to keep WCAG.
  const fg = luminance(brand) > 0.6 ? "#000000" : "#ffffff";
  root.style.setProperty("--primary-foreground", fg);
  root.style.setProperty("--sidebar-primary-foreground", fg);

  writeShadow(color);
}

/**
 * Synchronous fast-path. Call before React mounts so the first paint uses
 * the persisted brand color instead of the default blue. The store
 * hydration overrides this shortly after.
 */
export function applyBrandColorFastPath(): void {
  applyBrandColor(readShadow());
}
