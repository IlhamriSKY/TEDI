// Bundled with the app via @font-face in styles/globals.css → public/fonts/.
// Always prepended to the family chain so Nerd-Font glyphs (oh-my-zsh /
// Powerlevel10k / Starship) render out of the box even when the host OS has
// no Nerd Font installed. document.fonts.check() can return false for a
// just-parsed @font-face whose woff2 hasn't been fetched yet, so we don't
// gate inclusion on detection - CSS resolves the family lazily as soon as
// the file lands.
const BUNDLED_NERD_FONT = "JetBrainsMono Nerd Font Mono";

const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

// CSS font-family fallback. Latin candidates come first (so non-CJK text
// renders with the user's preferred coding font); CJK families are appended
// for per-glyph fallback so Korean/Japanese/Chinese characters get real
// glyphs instead of tofu when the primary font lacks them. Names are kept
// in their canonical OS form - missing entries are silently skipped by the
// CSS engine, so listing fonts that only exist on macOS / Windows / Linux
// in the same chain is safe.
const FALLBACK_CHAIN = [
  '"JetBrains Mono"',
  "SFMono-Regular",
  "Menlo",
  "Consolas",
  // Pan-CJK Noto families (Linux distros, optional install on mac/Win).
  '"Noto Sans Mono CJK SC"',
  '"Noto Sans Mono CJK JP"',
  '"Noto Sans Mono CJK KR"',
  // Windows stock CJK fonts.
  '"Microsoft YaHei"',
  '"Microsoft JhengHei"',
  '"Meiryo"',
  '"MS Gothic"',
  '"Malgun Gothic"',
  // macOS stock CJK fonts.
  '"Hiragino Sans"',
  '"Hiragino Kaku Gothic ProN"',
  '"Apple SD Gothic Neo"',
  '"PingFang SC"',
  "monospace",
].join(", ");

let detected: string | null = null;

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  const bundled = `"${BUNDLED_NERD_FONT}"`;
  if (typeof document === "undefined" || !document.fonts) {
    detected = `${bundled}, ${FALLBACK_CHAIN}`;
    return detected;
  }
  for (const f of NERD_FONT_CANDIDATES) {
    try {
      if (document.fonts.check(`12px "${f}"`)) {
        detected = `${bundled}, "${f}", ${FALLBACK_CHAIN}`;
        return detected;
      }
    } catch {
      // Some browsers throw on invalid font shorthand; ignore.
    }
  }
  detected = `${bundled}, ${FALLBACK_CHAIN}`;
  return detected;
}

/**
 * Static fallback family chain, used as the inline `var(--tedi-mono-font, …)`
 * fallback in the editor theme so the first paint (before the applier runs) is
 * still a sane monospace, and as the globals.css default for the var.
 */
export const MONO_FONT_CSS_FALLBACK = `"${BUNDLED_NERD_FONT}", ${FALLBACK_CHAIN}`;

/**
 * Curated monospace fonts offered in the font picker. `family: null` means
 * "System default" (the auto-detected Nerd-Font chain). For any other entry the
 * chosen family is *prepended* to the detected chain, so a font the user does
 * not have installed degrades gracefully to the bundled font + the fallback
 * chain instead of breaking glyph rendering. That graceful fallback is what
 * keeps an arbitrary pick safe.
 */
export type ContentFontOption = { id: string; label: string; family: string | null };

export const CONTENT_FONT_OPTIONS: readonly ContentFontOption[] = [
  { id: "default", label: "System default", family: null },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono" },
  { id: "fira-code", label: "Fira Code", family: "Fira Code" },
  { id: "cascadia-code", label: "Cascadia Code", family: "Cascadia Code" },
  { id: "source-code-pro", label: "Source Code Pro", family: "Source Code Pro" },
  { id: "hack", label: "Hack", family: "Hack" },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", family: "IBM Plex Mono" },
  { id: "iosevka", label: "Iosevka", family: "Iosevka" },
  { id: "ubuntu-mono", label: "Ubuntu Mono", family: "Ubuntu Mono" },
  { id: "menlo", label: "Menlo (macOS)", family: "Menlo" },
  { id: "consolas", label: "Consolas (Windows)", family: "Consolas" },
] as const;

export const DEFAULT_CONTENT_FONT_ID = "default";

export function isValidContentFontId(id: unknown): id is string {
  return typeof id === "string" && CONTENT_FONT_OPTIONS.some((o) => o.id === id);
}

/**
 * Resolve a font-picker id to a full CSS font-family chain. Unknown ids and
 * "default" return the auto-detected chain; a known family is prepended to it
 * (so missing fonts fall through safely). Used for BOTH the editor CSS var and
 * the xterm `fontFamily` option.
 */
export function buildContentFontFamily(id: string): string {
  const base = detectMonoFontFamily();
  const opt = CONTENT_FONT_OPTIONS.find((o) => o.id === id);
  if (!opt || !opt.family) return base;
  // Quote a family with spaces; the rest of the chain already carries the
  // bundled Nerd Font (for powerline/nerd glyphs the chosen font lacks).
  return `"${opt.family}", ${base}`;
}

const MONO_FONT_VAR = "--tedi-mono-font";
const EDITOR_FONT_SIZE_VAR = "--tedi-editor-font-size";
const MONO_FONT_SHADOW = "tedi-mono-font-shadow";
const EDITOR_FONT_SIZE_SHADOW = "tedi-editor-font-size-shadow";

/** Apply the chosen content font to the editor (`--tedi-mono-font`). The
 *  terminal reads its own `fontFamily` option in `useTerminalSession`. */
export function applyMonoFontVar(id: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(MONO_FONT_VAR, buildContentFontFamily(id));
  try {
    window.localStorage.setItem(MONO_FONT_SHADOW, id);
  } catch {
    /* ignore */
  }
}

/** Apply the editor base font size (`--tedi-editor-font-size`, in px). */
export function applyEditorFontSizeVar(px: number): void {
  if (typeof document === "undefined" || !Number.isFinite(px)) return;
  document.documentElement.style.setProperty(EDITOR_FONT_SIZE_VAR, `${px}px`);
  try {
    window.localStorage.setItem(EDITOR_FONT_SIZE_SHADOW, String(px));
  } catch {
    /* ignore */
  }
}

/** Synchronous first-paint appliers (read the localStorage shadow). */
export function applyFontFastPath(): void {
  try {
    if (typeof window === "undefined") return;
    const fontId = window.localStorage.getItem(MONO_FONT_SHADOW);
    if (fontId) applyMonoFontVar(fontId);
    const px = parseInt(window.localStorage.getItem(EDITOR_FONT_SIZE_SHADOW) ?? "", 10);
    if (Number.isFinite(px)) applyEditorFontSizeVar(px);
  } catch {
    /* ignore */
  }
}
