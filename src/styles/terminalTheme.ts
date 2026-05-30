import { readAppTokens } from "@/styles/tokens";
import type { ITheme } from "@xterm/xterm";

/**
 * Semantic palette reused by the code editor. Keeps the terminal ANSI and
 * syntax highlighting coherent. Reads the same `--tedi-ansi-*` CSS vars
 * the terminal uses so the editor's syntax tokens stay in sync with the
 * active Theme preset.
 */
export const syntaxPalette = {
  comment: "var(--tedi-ansi-bright-black)",
  keyword: "var(--tedi-ansi-blue)",
  string: "var(--tedi-ansi-green)",
  number: "var(--tedi-ansi-yellow)",
  constant: "var(--tedi-ansi-magenta)",
  fn: "var(--tedi-ansi-cyan)",
  type: "var(--tedi-ansi-bright-cyan)",
  tag: "var(--tedi-ansi-red)",
  punctuation: "var(--muted-foreground)",
  invalid: "var(--tedi-ansi-red)",
  link: "var(--tedi-ansi-blue)",
} as const;

/**
 * Builds an xterm theme from the current app tokens. Call after first
 * paint; globals.css variables are read via getComputedStyle.
 *
 * When a wallpaper is active, `theme.background` becomes a semi-transparent
 * rgba (so per-cell backgrounds let the image bleed through). The
 * companion logic in `useTerminalSession.ts` switches the renderer from
 * WebGL to DOM at the same time. The DOM renderer paints each cell as
 * a `<span>` with independent `background-color` and `color`, so the
 * foreground glyph stays fully opaque while the cell background is rgba.
 * (The WebGL renderer has a known bug, xterm.js #4054, that dims the
 * foreground when the background has alpha < 1.)
 *
 * The full ANSI 16-colour palette is themable through the same custom
 * theme machinery: each preset can ship its own matched palette and the
 * UI editor under Settings > Theme > Terminal exposes every slot.
 */
export function buildTerminalTheme(): ITheme {
  const t = readAppTokens();
  const bg = resolveCanvasBackground(t.background);
  return {
    background: bg,
    foreground: t.foreground,
    cursor: t.foreground,
    // The glyph under a block cursor must stay OPAQUE. Under glass `--background`
    // is forced transparent, so reading `t.background` here would make the
    // character invisible; resolve the SOLID canvas colour instead (no alpha).
    cursorAccent: resolveCanvasSolid(t.background),
    selectionBackground: t.accent,
    black: t["tedi-ansi-black"],
    red: t["tedi-ansi-red"],
    green: t["tedi-ansi-green"],
    yellow: t["tedi-ansi-yellow"],
    blue: t["tedi-ansi-blue"],
    magenta: t["tedi-ansi-magenta"],
    cyan: t["tedi-ansi-cyan"],
    white: t["tedi-ansi-white"],
    brightBlack: t["tedi-ansi-bright-black"],
    brightRed: t["tedi-ansi-bright-red"],
    brightGreen: t["tedi-ansi-bright-green"],
    brightYellow: t["tedi-ansi-bright-yellow"],
    brightBlue: t["tedi-ansi-bright-blue"],
    brightMagenta: t["tedi-ansi-bright-magenta"],
    brightCyan: t["tedi-ansi-bright-cyan"],
    brightWhite: t["tedi-ansi-bright-white"],
  };
}

export function resolveCanvasBackground(fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const root = document.documentElement;
  // Transparency is owned by the single "App opacity" control
  // (`data-tedi-glass` + `--tedi-app-opacity`). When off, the canvas is solid.
  if (root.dataset.tediGlass !== "on") return fallback;
  const cs = getComputedStyle(root);
  const canvasBg = cs.getPropertyValue("--tedi-canvas-bg").trim();
  if (!canvasBg) return fallback;
  const alpha = parseFloat(cs.getPropertyValue("--tedi-app-opacity").trim() || "1");
  const a = isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  return hexToRgba(canvasBg, a) ?? fallback;
}

/**
 * Solid (alpha = 1) canvas colour for the active theme. Unlike
 * `resolveCanvasBackground` this never applies the opacity alpha - used for the
 * block-cursor glyph fill which must stay opaque even under glass.
 */
function resolveCanvasSolid(fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const canvasBg = getComputedStyle(document.documentElement)
    .getPropertyValue("--tedi-canvas-bg")
    .trim();
  return canvasBg || fallback;
}

/** `#rrggbb` -> `rgba(r, g, b, alpha)`. Returns null when not a 6-digit hex. */
function hexToRgba(hex: string, alpha: number): string | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
