/**
 * Resolves shadcn CSS custom properties to rgb strings.
 *
 * globals.css uses oklch(), which xterm.js (WebGL) and CodeMirror's static
 * theme builder can't read. Setting `color: var(--x)` on a probe element
 * forces computed `color` into rgb form, which both consumers accept.
 *
 * Tokens are read on each call. Re-invoke after a theme change.
 */

const CHROME_TOKENS = [
  "background",
  "foreground",
  "card",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "primary",
  "destructive",
  "ring",
] as const;

const ANSI_TOKENS = [
  "tedi-ansi-black",
  "tedi-ansi-red",
  "tedi-ansi-green",
  "tedi-ansi-yellow",
  "tedi-ansi-blue",
  "tedi-ansi-magenta",
  "tedi-ansi-cyan",
  "tedi-ansi-white",
  "tedi-ansi-bright-black",
  "tedi-ansi-bright-red",
  "tedi-ansi-bright-green",
  "tedi-ansi-bright-yellow",
  "tedi-ansi-bright-blue",
  "tedi-ansi-bright-magenta",
  "tedi-ansi-bright-cyan",
  "tedi-ansi-bright-white",
] as const;

type ChromeName = (typeof CHROME_TOKENS)[number];
type AnsiName = (typeof ANSI_TOKENS)[number];

export type AppTokens = Record<ChromeName, string> & Record<AnsiName, string>;

let probe: HTMLDivElement | null = null;

function resolve(varName: string): string {
  if (!probe) {
    probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);
  }
  probe.style.color = `var(--${varName})`;
  return getComputedStyle(probe).color;
}

export function readAppTokens(): AppTokens {
  const out = {} as AppTokens;
  for (const name of CHROME_TOKENS) out[name] = resolve(name);
  for (const name of ANSI_TOKENS) out[name] = resolve(name);
  return out;
}

/**
 * Terminal-owned tokens, kept SEPARATE from the app chrome tokens above. The
 * terminal reads its own `--tedi-term-*` vars so it can be themed independently
 * of the app. In `follow-app` mode those vars default (in globals.css) to the
 * app tokens, so this still resolves to the chrome palette without any coupling
 * in the read path.
 */
const TERM_ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;

export type TerminalTokens = {
  bg: string;
  fg: string;
  cursor: string;
  selection: string;
  ansi: Record<(typeof TERM_ANSI_NAMES)[number], string>;
};

export function readTerminalTokens(): TerminalTokens {
  const ansi = {} as Record<(typeof TERM_ANSI_NAMES)[number], string>;
  for (const name of TERM_ANSI_NAMES) ansi[name] = resolve(`tedi-term-ansi-${name}`);
  return {
    bg: resolve("tedi-term-bg"),
    fg: resolve("tedi-term-fg"),
    cursor: resolve("tedi-term-cursor"),
    selection: resolve("tedi-term-selection"),
    ansi,
  };
}
