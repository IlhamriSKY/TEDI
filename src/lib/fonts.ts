// Bundled with the app via @font-face in styles/globals.css → public/fonts/.
// Always prepended to the family chain so Nerd-Font glyphs (oh-my-zsh /
// Powerlevel10k / Starship) render out of the box even when the host OS has
// no Nerd Font installed. document.fonts.check() can return false for a
// just-parsed @font-face whose woff2 hasn't been fetched yet, so we don't
// gate inclusion on detection — CSS resolves the family lazily as soon as
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
// in their canonical OS form — missing entries are silently skipped by the
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
