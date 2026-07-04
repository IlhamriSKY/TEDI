/**
 * Terminal theme palette + runtime applier.
 *
 * The terminal is themed INDEPENDENTLY of the app chrome. It reads its own
 * `--tedi-term-*` CSS variables, which default (in globals.css) to the app
 * tokens so `mode: "follow-app"` is pixel-identical to the app theme with no
 * JS at all. In `mode: "custom"` this module overrides those vars with the
 * chosen palette, so from then on changing the app theme no longer touches the
 * terminal (and vice versa).
 *
 * Mode-agnostic by design: ONE palette regardless of light/dark, matching how
 * most terminals (iTerm, Windows Terminal, kitty) ship a single scheme.
 */
import { slugify } from "@/lib/utils";
import { THEME_PRESETS } from "./themePresets";
import type { ThemeColors } from "./customTheme";

export type TerminalThemeMode = "follow-app" | "custom";

export type TerminalAnsi = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type TerminalPalette = {
  /** Preset name, or "Custom" once hand-edited. */
  name: string;
  /** Terminal canvas background. */
  background: string;
  /** Default glyph color. */
  foreground: string;
  /** Cursor color (block cursor fill). */
  cursor: string;
  /** Selection highlight background. */
  selection: string;
  /** Full ANSI 16. First eight standard, latter eight bright. */
  ansi: TerminalAnsi;
};

export const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** ANSI slot -> CSS var consumed by `buildTerminalTheme` via `readTerminalTokens`. */
const ANSI_VAR: Record<keyof TerminalAnsi, string> = {
  black: "--tedi-term-ansi-black",
  red: "--tedi-term-ansi-red",
  green: "--tedi-term-ansi-green",
  yellow: "--tedi-term-ansi-yellow",
  blue: "--tedi-term-ansi-blue",
  magenta: "--tedi-term-ansi-magenta",
  cyan: "--tedi-term-ansi-cyan",
  white: "--tedi-term-ansi-white",
  brightBlack: "--tedi-term-ansi-bright-black",
  brightRed: "--tedi-term-ansi-bright-red",
  brightGreen: "--tedi-term-ansi-bright-green",
  brightYellow: "--tedi-term-ansi-bright-yellow",
  brightBlue: "--tedi-term-ansi-bright-blue",
  brightMagenta: "--tedi-term-ansi-bright-magenta",
  brightCyan: "--tedi-term-ansi-bright-cyan",
  brightWhite: "--tedi-term-ansi-bright-white",
};

const VAR_BG = "--tedi-term-bg";
const VAR_FG = "--tedi-term-fg";
const VAR_CURSOR = "--tedi-term-cursor";
const VAR_SELECTION = "--tedi-term-selection";

/** ANSI slots, in order, as the `--tedi-term-ansi-*` var names. Internal: used
 *  by the applier to clear the custom overrides. */
const TERMINAL_ANSI_VARS = ANSI_KEYS.map((k) => ANSI_VAR[k]);
const TERMINAL_BASE_VARS = [VAR_BG, VAR_FG, VAR_CURSOR, VAR_SELECTION] as const;

function ansiFromColors(c: ThemeColors): TerminalAnsi {
  return {
    black: c.ansiBlack,
    red: c.ansiRed,
    green: c.ansiGreen,
    yellow: c.ansiYellow,
    blue: c.ansiBlue,
    magenta: c.ansiMagenta,
    cyan: c.ansiCyan,
    white: c.ansiWhite,
    brightBlack: c.ansiBrightBlack,
    brightRed: c.ansiBrightRed,
    brightGreen: c.ansiBrightGreen,
    brightYellow: c.ansiBrightYellow,
    brightBlue: c.ansiBrightBlue,
    brightMagenta: c.ansiBrightMagenta,
    brightCyan: c.ansiBrightCyan,
    brightWhite: c.ansiBrightWhite,
  };
}

/** Build a terminal palette from an app preset's color set. Used to derive the
 *  prebuilt terminal presets from the existing app presets (dark variant) so we
 *  don't duplicate the curated ANSI hex. */
function paletteFromColors(name: string, c: ThemeColors): TerminalPalette {
  return {
    name,
    background: c.background,
    foreground: c.foreground,
    cursor: c.foreground,
    selection: c.accent,
    ansi: ansiFromColors(c),
  };
}

export type TerminalPreset = { id: string; palette: TerminalPalette };

/**
 * Prebuilt terminal palettes. Derived from the app presets' DARK variants:
 * terminals are conventionally dark and the palette is mode-agnostic, so the
 * dark ANSI/bg/fg of "Tokyo Night", "Nord", etc. are the natural terminal set.
 */
export const TERMINAL_PRESETS: TerminalPreset[] = THEME_PRESETS.map((p) => ({
  id: slugify(p.name, "preset"),
  palette: paletteFromColors(p.name, p.dark),
}));

export const DEFAULT_TERMINAL_THEME_ID = TERMINAL_PRESETS[0].id;
export const DEFAULT_TERMINAL_PALETTE: TerminalPalette = TERMINAL_PRESETS[0].palette;

/**
 * Resolve a per-leaf theme override id (a `TERMINAL_PRESETS` id) to its
 * palette. Returns null for an empty / unknown id, in which case the leaf
 * follows the global terminal theme. Backs the per-pane "Terminal theme" menu.
 */
export function resolveTerminalPreset(id: string | null | undefined): TerminalPalette | null {
  if (!id) return null;
  return TERMINAL_PRESETS.find((p) => p.id === id)?.palette ?? null;
}

const FAST_PATH_KEY = "tedi-terminal-theme-shadow";

type Shadow = { mode: TerminalThemeMode; palette: TerminalPalette | null };

function clearTerminalVars(root: HTMLElement): void {
  for (const v of TERMINAL_BASE_VARS) root.style.removeProperty(v);
  for (const v of TERMINAL_ANSI_VARS) root.style.removeProperty(v);
}

/**
 * Apply the terminal palette to the document. `follow-app` removes the
 * overrides so the globals.css defaults (which reference the app tokens) take
 * over and track the app theme live. `custom` writes the literal palette so the
 * terminal is fully decoupled from the app theme.
 *
 * Note: this only sets CSS vars. The live xterm instances re-read them via
 * `buildTerminalTheme()` when `TerminalPane` re-runs its theme effect.
 */
export function applyTerminalTheme(mode: TerminalThemeMode, palette: TerminalPalette | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode !== "custom" || !palette) {
    clearTerminalVars(root);
    writeShadow({ mode: "follow-app", palette: null });
    return;
  }
  root.style.setProperty(VAR_BG, palette.background);
  root.style.setProperty(VAR_FG, palette.foreground);
  root.style.setProperty(VAR_CURSOR, palette.cursor || palette.foreground);
  root.style.setProperty(VAR_SELECTION, palette.selection || palette.foreground);
  for (const k of ANSI_KEYS) root.style.setProperty(ANSI_VAR[k], palette.ansi[k]);
  writeShadow({ mode, palette });
}

function writeShadow(s: Shadow): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FAST_PATH_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function readShadow(): Shadow | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(FAST_PATH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Shadow;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Synchronous fast-path. Call before React mounts so the first xterm paint uses
 * the saved custom palette instead of the app-derived default. `follow-app`
 * needs no work: the globals.css `--tedi-term-*` defaults already mirror the
 * app tokens.
 */
export function applyTerminalThemeFastPath(): void {
  const s = readShadow();
  if (!s || s.mode !== "custom" || !s.palette) return;
  applyTerminalTheme("custom", normalizeTerminalPalette(s.palette, DEFAULT_TERMINAL_PALETTE));
}

/**
 * Merge a partial / possibly-stale palette payload with the supplied default so
 * every field is present. Tolerates older shapes and missing ANSI slots.
 */
export function normalizeTerminalPalette(raw: unknown, fallback: TerminalPalette): TerminalPalette {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, f: string) => (typeof v === "string" && v.length > 0 ? v : f);
  const ansiRaw = (o.ansi && typeof o.ansi === "object" ? o.ansi : {}) as Record<string, unknown>;
  const ansi = {} as TerminalAnsi;
  for (const k of ANSI_KEYS) ansi[k] = str(ansiRaw[k], fallback.ansi[k]);
  return {
    name: str(o.name, fallback.name),
    background: str(o.background, fallback.background),
    foreground: str(o.foreground, fallback.foreground),
    cursor: str(o.cursor, fallback.cursor),
    selection: str(o.selection, fallback.selection),
    ansi,
  };
}
