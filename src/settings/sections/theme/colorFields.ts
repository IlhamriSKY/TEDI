import { type ThemeColors } from "@/modules/settings/customTheme";

/**
 * Every editable APP-CHROME theme color, grouped for the tabbed color editor in
 * ThemeSection. The terminal's ANSI 16 are NOT here — the terminal is themed
 * independently under Settings -> Terminal (see `modules/settings/
 * terminalPalette.ts`). Order within a group is the display order.
 */
export const COLOR_FIELDS: { key: keyof ThemeColors; label: string; group: string }[] = [
  { key: "background", label: "Background", group: "Base" },
  { key: "foreground", label: "Foreground", group: "Base" },
  { key: "card", label: "Card", group: "Base" },
  { key: "cardForeground", label: "Card text", group: "Base" },
  { key: "popover", label: "Popover", group: "Base" },
  { key: "popoverForeground", label: "Popover text", group: "Base" },
  { key: "button", label: "Primary button", group: "Buttons" },
  { key: "buttonForeground", label: "Primary button text", group: "Buttons" },
  { key: "buttonFace", label: "Neutral button", group: "Buttons" },
  { key: "buttonFaceForeground", label: "Neutral button text", group: "Buttons" },
  { key: "secondary", label: "Secondary", group: "Buttons" },
  { key: "secondaryForeground", label: "Secondary text", group: "Buttons" },
  { key: "border", label: "Border", group: "Borders" },
  { key: "input", label: "Input border", group: "Borders" },
  { key: "ring", label: "Focus / tab bar", group: "Borders" },
  { key: "resizeHandle", label: "Split-pane divider", group: "Borders" },
  { key: "accent", label: "Accent", group: "Highlights" },
  { key: "accentForeground", label: "Accent text", group: "Highlights" },
  { key: "muted", label: "Muted", group: "Highlights" },
  { key: "mutedForeground", label: "Muted text", group: "Highlights" },
  { key: "destructive", label: "Destructive", group: "Highlights" },
  { key: "sidebar", label: "Sidebar", group: "Sidebar" },
  { key: "sidebarForeground", label: "Sidebar text", group: "Sidebar" },
  { key: "sidebarBorder", label: "Sidebar border", group: "Sidebar" },
  { key: "sidebarAccent", label: "Selected workspace / file", group: "Sidebar" },
  { key: "sidebarAccentForeground", label: "Selected workspace / file text", group: "Sidebar" },
  { key: "iconWorking", label: "Icon working", group: "Icons" },
  { key: "iconIdle", label: "Icon idle", group: "Icons" },
  { key: "iconBlocked", label: "Icon blocked", group: "Icons" },
  { key: "iconDone", label: "Icon done", group: "Icons" },
  { key: "iconBranch", label: "Icon git branch", group: "Icons" },
  { key: "diffAdded", label: "Diff added (+)", group: "Highlights" },
  { key: "diffRemoved", label: "Diff removed (-)", group: "Highlights" },
  { key: "info", label: "Info", group: "Highlights" },
  { key: "tabAccentTerminal", label: "Active terminal stripe", group: "Tabs" },
  { key: "tabAccentSsh", label: "Active SSH stripe", group: "Tabs" },
  { key: "tabAccentEditor", label: "Active editor stripe", group: "Tabs" },
  { key: "tabAccentPreview", label: "Active browser stripe", group: "Tabs" },
  { key: "tabAccentAiDiff", label: "AI diff stripe", group: "Tabs" },
  { key: "tabAccentGitDiff", label: "Git diff stripe", group: "Tabs" },
];

export const GROUPS = [
  "Base",
  "Buttons",
  "Borders",
  "Highlights",
  "Sidebar",
  "Icons",
  "Tabs",
] as const;
export type Group = (typeof GROUPS)[number];
