import { readTerminalTokens } from "@/styles/tokens";
import type { TerminalPalette } from "@/modules/settings/terminalPalette";
import type { ITheme } from "@xterm/xterm";

/**
 * Builds an xterm theme from the TERMINAL tokens (`--tedi-term-*`), which are
 * independent of the app chrome. In `follow-app` mode those vars default (in
 * globals.css) to the app palette, so the result is identical to the app theme;
 * in `custom` mode they carry the user's own terminal palette, fully decoupled
 * from the app theme. See `modules/settings/terminalPalette.ts`.
 *
 * Call after first paint; the CSS variables are read via getComputedStyle.
 *
 * When a wallpaper/glass is active, `background` becomes a semi-transparent
 * rgba (so per-cell backgrounds let the image bleed through). The companion
 * logic in `useTerminalSession.ts` switches the renderer from WebGL to DOM at
 * the same time. The DOM renderer paints each cell as a `<span>` with
 * independent `background-color` and `color`, so the foreground glyph stays
 * fully opaque while the cell background is rgba. (The WebGL renderer has a
 * known bug, xterm.js #4054, that dims the foreground when the background has
 * alpha < 1.)
 *
 * The full ANSI 16-colour palette is themable through the dedicated Terminal
 * theme (Settings -> Terminal): a prebuilt preset or a custom 16-slot palette.
 *
 * `override` is a per-leaf palette (Pane header -> "Terminal theme"). When
 * passed, the xterm theme is built straight from it instead of the global
 * `--tedi-term-*` tokens, so a single pane can carry its own palette while the
 * rest follow the global theme. Glass alpha is still applied to the background.
 */
export function buildTerminalTheme(override?: TerminalPalette | null): ITheme {
  if (override) return paletteToTheme(override);
  const t = readTerminalTokens();
  return {
    background: applyGlassAlpha(t.bg),
    foreground: t.fg,
    cursor: t.cursor,
    // The glyph under a block cursor must stay OPAQUE. Use the SOLID terminal
    // background (no alpha) so the character is never dimmed under glass.
    cursorAccent: t.bg,
    selectionBackground: t.selection,
    black: t.ansi.black,
    red: t.ansi.red,
    green: t.ansi.green,
    yellow: t.ansi.yellow,
    blue: t.ansi.blue,
    magenta: t.ansi.magenta,
    cyan: t.ansi.cyan,
    white: t.ansi.white,
    brightBlack: t.ansi["bright-black"],
    brightRed: t.ansi["bright-red"],
    brightGreen: t.ansi["bright-green"],
    brightYellow: t.ansi["bright-yellow"],
    brightBlue: t.ansi["bright-blue"],
    brightMagenta: t.ansi["bright-magenta"],
    brightCyan: t.ansi["bright-cyan"],
    brightWhite: t.ansi["bright-white"],
  };
}

/** Build an xterm theme from a literal terminal palette (per-leaf override).
 *  Mirrors the token path but reads the palette's hex directly. */
function paletteToTheme(p: TerminalPalette): ITheme {
  return {
    background: applyGlassAlpha(p.background),
    foreground: p.foreground,
    cursor: p.cursor || p.foreground,
    // Keep the under-cursor glyph opaque: solid palette background, no alpha.
    cursorAccent: p.background,
    selectionBackground: p.selection || p.foreground,
    black: p.ansi.black,
    red: p.ansi.red,
    green: p.ansi.green,
    yellow: p.ansi.yellow,
    blue: p.ansi.blue,
    magenta: p.ansi.magenta,
    cyan: p.ansi.cyan,
    white: p.ansi.white,
    brightBlack: p.ansi.brightBlack,
    brightRed: p.ansi.brightRed,
    brightGreen: p.ansi.brightGreen,
    brightYellow: p.ansi.brightYellow,
    brightBlue: p.ansi.brightBlue,
    brightMagenta: p.ansi.brightMagenta,
    brightCyan: p.ansi.brightCyan,
    brightWhite: p.ansi.brightWhite,
  };
}

/**
 * The glass-aware terminal background. Solid when glass is off; under glass it
 * applies the single "App opacity" alpha so the wallpaper bleeds through. Used
 * by the per-frame opacity-drag refresh in `session-lifecycle.ts`, which
 * patches only `theme.background` instead of rebuilding the whole theme.
 * `override` resolves a per-leaf palette's background instead of the global one.
 */
export function resolveTerminalBackground(override?: TerminalPalette | null): string {
  return applyGlassAlpha(override ? override.background : readTerminalTokens().bg);
}

function applyGlassAlpha(solidResolved: string): string {
  if (typeof document === "undefined") return solidResolved;
  const root = document.documentElement;
  // Transparency is owned by the single "App opacity" control
  // (`data-tedi-glass` + `--tedi-app-opacity`). When off, the canvas is solid.
  if (root.dataset.tediGlass !== "on") return solidResolved;
  const cs = getComputedStyle(root);
  const raw = parseFloat(cs.getPropertyValue("--tedi-app-opacity").trim() || "1");
  const a = isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
  return withAlpha(solidResolved, a) ?? solidResolved;
}

/**
 * Apply an alpha to a resolved color string. The token probe returns `rgb(...)`
 * (comma or space separated); a custom palette may also pass a `#rrggbb` hex.
 */
function withAlpha(color: string, alpha: number): string | null {
  const c = color.trim();
  const rgb = /^rgba?\(([^)]+)\)/i.exec(c);
  if (rgb) {
    let parts = rgb[1].split(",").map((s) => s.trim());
    if (parts.length < 3) parts = rgb[1].trim().split(/\s+/);
    if (parts.length >= 3) {
      const [r, g, b] = parts;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(c);
  if (hex) {
    const v = hex[1];
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return null;
}
