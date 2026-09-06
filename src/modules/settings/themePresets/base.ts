import type { ThemeColors } from "../customTheme";

export const EMPTY_BG = {
  enabled: false,
  path: "",
  dataUrl: "",
  blur: 0,
  darken: 0,
  opacity: 1,
} as const;

/**
 * Generic ANSI 16 palette tuned for dark surfaces. Each preset spreads
 * this so it picks up the full set, then can override individual slots
 * where the canonical preset specifies different ANSI colors.
 */
const ANSI_DARK = {
  ansiBlack: "#18181b",
  ansiRed: "#ef4444",
  ansiGreen: "#22c55e",
  ansiYellow: "#eab308",
  ansiBlue: "#3b82f6",
  ansiMagenta: "#a855f7",
  ansiCyan: "#06b6d4",
  ansiWhite: "#e4e4e7",
  ansiBrightBlack: "#52525b",
  ansiBrightRed: "#f87171",
  ansiBrightGreen: "#4ade80",
  ansiBrightYellow: "#facc15",
  ansiBrightBlue: "#60a5fa",
  ansiBrightMagenta: "#c084fc",
  ansiBrightCyan: "#22d3ee",
  ansiBrightWhite: "#fafafa",
} satisfies Pick<
  ThemeColors,
  | "ansiBlack"
  | "ansiRed"
  | "ansiGreen"
  | "ansiYellow"
  | "ansiBlue"
  | "ansiMagenta"
  | "ansiCyan"
  | "ansiWhite"
  | "ansiBrightBlack"
  | "ansiBrightRed"
  | "ansiBrightGreen"
  | "ansiBrightYellow"
  | "ansiBrightBlue"
  | "ansiBrightMagenta"
  | "ansiBrightCyan"
  | "ansiBrightWhite"
>;

/** Generic ANSI 16 palette tuned for light surfaces (less neon, more contrast). */
const ANSI_LIGHT = {
  ansiBlack: "#3f3f46",
  ansiRed: "#dc2626",
  ansiGreen: "#16a34a",
  ansiYellow: "#ca8a04",
  ansiBlue: "#2563eb",
  ansiMagenta: "#9333ea",
  ansiCyan: "#0891b2",
  ansiWhite: "#e4e4e7",
  ansiBrightBlack: "#71717a",
  ansiBrightRed: "#ef4444",
  ansiBrightGreen: "#22c55e",
  ansiBrightYellow: "#eab308",
  ansiBrightBlue: "#3b82f6",
  ansiBrightMagenta: "#a855f7",
  ansiBrightCyan: "#06b6d4",
  ansiBrightWhite: "#fafafa",
} satisfies typeof ANSI_DARK;

export const DARK_COLORS: ThemeColors = {
  background: "#1a1a1a",
  foreground: "#cccccc",
  card: "#2b2b2b",
  cardForeground: "#cccccc",
  popover: "#363636",
  popoverForeground: "#e6e6e6",
  button: "#0057fe",
  buttonForeground: "#ffffff",
  secondary: "#3a3a3a",
  secondaryForeground: "#cccccc",
  muted: "#333333",
  mutedForeground: "#9d9d9d",
  accent: "#0a2870",
  accentForeground: "#ffffff",
  destructive: "#f14c4c",
  border: "#383838",
  input: "#3f3f3f",
  buttonFace: "#5d5d5d",
  buttonFaceForeground: "#e6e6e6",
  ring: "#0057fe",
  sidebar: "#141414",
  sidebarForeground: "#cccccc",
  sidebarBorder: "#383838",
  sidebarAccent: "#37373d",
  sidebarAccentForeground: "#ffffff",
  iconWorking: "#facc15",
  iconIdle: "#34d399",
  iconBlocked: "#f87171",
  iconDone: "#60a5fa",
  iconBranch: "#a78bfa",
  diffAdded: "#4ade80",
  diffRemoved: "#f87171",
  info: "#38bdf8",
  tabAccentTerminal: "#34d399",
  tabAccentSsh: "#38bdf8",
  tabAccentEditor: "#5b8bff",
  tabAccentPreview: "#22d3ee",
  tabAccentAiDiff: "#a78bfa",
  tabAccentGitDiff: "#fbbf24",
  ...ANSI_DARK,
};

export const LIGHT_COLORS: ThemeColors = {
  background: "#ffffff",
  foreground: "#1f2328",
  card: "#f6f7f9",
  cardForeground: "#1f2328",
  popover: "#ffffff",
  popoverForeground: "#1f2328",
  button: "#0057fe",
  buttonForeground: "#ffffff",
  secondary: "#eceef2",
  secondaryForeground: "#1f2328",
  muted: "#f1f3f5",
  mutedForeground: "#5d646e",
  accent: "#dbe5ff",
  accentForeground: "#1f2328",
  destructive: "#dc2626",
  border: "#e4e7ec",
  input: "#dce1e7",
  buttonFace: "#b8babd",
  buttonFaceForeground: "#1f2328",
  ring: "#0057fe",
  sidebar: "#eef0f3",
  sidebarForeground: "#1f2328",
  sidebarBorder: "#e4e7ec",
  sidebarAccent: "#dbe5ff",
  sidebarAccentForeground: "#1f2328",
  iconWorking: "#ca8a04",
  iconIdle: "#059669",
  iconBlocked: "#dc2626",
  iconDone: "#2563eb",
  iconBranch: "#7c3aed",
  diffAdded: "#16a34a",
  diffRemoved: "#dc2626",
  info: "#0284c7",
  tabAccentTerminal: "#10b981",
  tabAccentSsh: "#0ea5e9",
  tabAccentEditor: "#0057fe",
  tabAccentPreview: "#06b6d4",
  tabAccentAiDiff: "#8b5cf6",
  tabAccentGitDiff: "#f59e0b",
  ...ANSI_LIGHT,
};
