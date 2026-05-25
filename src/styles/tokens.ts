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
