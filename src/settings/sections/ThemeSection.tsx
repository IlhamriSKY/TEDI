import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  APP_OPACITY_MAX,
  APP_OPACITY_MIN,
  APP_OPACITY_STEP,
  setAppOpacity,
  setCustomTheme,
  setCustomThemeEnabled,
  setUserThemePresets,
} from "@/modules/settings/store";
import { previewAppOpacity } from "@/modules/settings/appOpacity";
import {
  parseThemeFile,
  serializeThemeFile,
  type CustomTheme,
  type ThemeColors,
} from "@/modules/settings/customTheme";
import { DEFAULT_CUSTOM_THEME, THEME_PRESETS } from "@/modules/settings/themePresets";
import {
  BookmarkAdd02Icon,
  Cancel01Icon,
  Delete02Icon,
  FolderUploadIcon,
  Image01Icon,
  LinkSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/modules/theme";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

const COLOR_FIELDS: { key: keyof ThemeColors; label: string; group: string }[] = [
  { key: "background", label: "Background", group: "Base" },
  { key: "foreground", label: "Foreground", group: "Base" },
  { key: "card", label: "Card", group: "Base" },
  { key: "cardForeground", label: "Card text", group: "Base" },
  { key: "popover", label: "Popover", group: "Base" },
  { key: "popoverForeground", label: "Popover text", group: "Base" },
  { key: "button", label: "Button", group: "Buttons" },
  { key: "buttonForeground", label: "Button text", group: "Buttons" },
  { key: "buttonBorder", label: "Button border", group: "Buttons" },
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
  { key: "diffAdded", label: "Diff added (+)", group: "Highlights" },
  { key: "diffRemoved", label: "Diff removed (-)", group: "Highlights" },
  { key: "info", label: "Info", group: "Highlights" },
  { key: "tabAccentTerminal", label: "Active terminal stripe", group: "Tabs" },
  { key: "tabAccentSsh", label: "Active SSH stripe", group: "Tabs" },
  { key: "tabAccentEditor", label: "Active editor stripe", group: "Tabs" },
  { key: "tabAccentPreview", label: "Active preview stripe", group: "Tabs" },
  { key: "tabAccentAiDiff", label: "AI diff stripe", group: "Tabs" },
  { key: "tabAccentGitDiff", label: "Git diff stripe", group: "Tabs" },
  // Full ANSI 16 - feeds the xterm palette directly.
  { key: "ansiBlack", label: "ANSI black", group: "Terminal" },
  { key: "ansiRed", label: "ANSI red", group: "Terminal" },
  { key: "ansiGreen", label: "ANSI green", group: "Terminal" },
  { key: "ansiYellow", label: "ANSI yellow", group: "Terminal" },
  { key: "ansiBlue", label: "ANSI blue", group: "Terminal" },
  { key: "ansiMagenta", label: "ANSI magenta", group: "Terminal" },
  { key: "ansiCyan", label: "ANSI cyan", group: "Terminal" },
  { key: "ansiWhite", label: "ANSI white", group: "Terminal" },
  { key: "ansiBrightBlack", label: "ANSI bright black", group: "Terminal" },
  { key: "ansiBrightRed", label: "ANSI bright red", group: "Terminal" },
  { key: "ansiBrightGreen", label: "ANSI bright green", group: "Terminal" },
  { key: "ansiBrightYellow", label: "ANSI bright yellow", group: "Terminal" },
  { key: "ansiBrightBlue", label: "ANSI bright blue", group: "Terminal" },
  { key: "ansiBrightMagenta", label: "ANSI bright magenta", group: "Terminal" },
  { key: "ansiBrightCyan", label: "ANSI bright cyan", group: "Terminal" },
  { key: "ansiBrightWhite", label: "ANSI bright white", group: "Terminal" },
];

const GROUPS = [
  "Base",
  "Buttons",
  "Borders",
  "Highlights",
  "Sidebar",
  "Icons",
  "Tabs",
  "Terminal",
] as const;
type Group = (typeof GROUPS)[number];

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

// Opacity to drop to when a wallpaper is first activated while the app is
// fully solid, so the image is clearly visible without manual fiddling.
const WALLPAPER_REVEAL_OPACITY = 0.5;

function ColorSwatch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  // Defensive default: if a freshly added token is missing from a legacy
  // stored theme, surface as black instead of throwing on `HEX6_RE.test`.
  const safeValue = typeof value === "string" && value.length > 0 ? value : "#000000";
  const [draft, setDraft] = useState(safeValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const isValid = HEX6_RE.test(draft);

  // Re-seed local draft when the parent value changes externally (preset
  // switch, .tedi import). Skip while the hex input is focused so typing
  // isn't clobbered.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    if (draft.toLowerCase() !== safeValue.toLowerCase()) setDraft(safeValue);
    // We deliberately exclude `draft` from the dep array: this effect should
    // only fire when the parent value changes, not on every local keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeValue]);

  // The native `<input type="color">` fires onChange continuously while the
  // user drags inside the picker (~200 Hz on some platforms). Coalesce to
  // one update per frame so the cross-window store write does not stall.
  const pendingRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const scheduleCommit = (next: string) => {
    pendingRef.current = next;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const v = pendingRef.current;
      pendingRef.current = null;
      if (v) onChange(v);
    });
  };
  useEffect(() => {
    return () => {
      // Read at cleanup time on purpose: cancels whichever frame is pending.
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Pick color"
          className="border-border/70 hover:border-foreground/40 focus-visible:ring-ring/40 inline-flex h-7 items-center gap-2 border bg-transparent pr-2 pl-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <span
            aria-hidden
            className="border-border/60 inline-block size-5 border"
            style={{ background: safeValue }}
          />
          <span className="text-muted-foreground font-mono uppercase">{safeValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56 gap-2 p-2.5">
        <input
          type="color"
          value={HEX6_RE.test(safeValue) ? safeValue : "#000000"}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            scheduleCommit(v);
          }}
          className="border-border/60 h-24 w-full cursor-pointer border bg-transparent p-0"
          aria-label="Color picker"
        />
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
            setDraft(v);
            if (HEX6_RE.test(v)) onChange(v);
          }}
          onBlur={() => {
            if (!isValid) setDraft(safeValue);
          }}
          maxLength={7}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-8 px-2 font-mono text-[11.5px] uppercase"
          placeholder="#000000"
          aria-label="Hex color"
        />
      </PopoverContent>
    </Popover>
  );
}

export function ThemeSection() {
  const enabled = usePreferencesStore((s) => s.customThemeEnabled);
  const theme = usePreferencesStore((s) => s.customTheme);
  const userPresets = usePreferencesStore((s) => s.userThemePresets);
  const appOpacity = usePreferencesStore((s) => s.appOpacity);
  // Live % while dragging the transparency slider (committed value persists).
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null);
  // Throttle the persist-while-dragging so the value sticks even if the
  // commit event is missed, without writing on every tick.
  const lastOpacityPersistRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<Group>("Base");
  // Inline name input for "Save as preset". `null` = button mode, string =
  // typing the name. Submitting (Enter or save button) writes to
  // userThemePresets, then collapses back to button mode.
  const [savePresetName, setSavePresetName] = useState<string | null>(null);
  // Which color variant is currently being edited. Defaults to the resolved
  // theme so the inputs always show what's actually painted on screen.
  const { resolvedTheme } = useTheme();
  const [editMode, setEditMode] = useState<"light" | "dark">(resolvedTheme);
  useEffect(() => setEditMode(resolvedTheme), [resolvedTheme]);

  const activeColors: ThemeColors = editMode === "dark" ? theme.dark : theme.light;

  const updateColor = (key: keyof ThemeColors, value: string) => {
    // Mark known presets as "modified" once, so the user can tell the active
    // palette has diverged from the canonical preset. Subsequent edits don't
    // keep appending "(modified)".
    const isPreset = THEME_PRESETS.some((p) => p.name === theme.name);
    const variantKey = editMode === "dark" ? "dark" : "light";
    const next: CustomTheme = {
      ...theme,
      name: isPreset ? `${theme.name} (modified)` : theme.name,
      [variantKey]: { ...theme[variantKey], [key]: value },
    };
    void setCustomTheme(next);
  };

  const updateBackground = (patch: Partial<CustomTheme["background"]>) => {
    const next: CustomTheme = {
      ...theme,
      background: { ...theme.background, ...patch },
    };
    void setCustomTheme(next);
  };

  // A wallpaper only shows through translucent surfaces, and surfaces are only
  // translucent when the custom theme is on AND opacity < 100%. So whenever a
  // wallpaper becomes active, enable the custom theme and (if still fully
  // solid) drop opacity so the image is visible right away instead of looking
  // like nothing happened.
  const ensureWallpaperVisible = () => {
    if (!enabled) void setCustomThemeEnabled(true);
    if (appOpacity >= APP_OPACITY_MAX) void setAppOpacity(WALLPAPER_REVEAL_OPACITY);
  };

  const onPickPreset = (preset: CustomTheme) => {
    // Preserve the user's chosen background image when switching colour
    // presets: colours change, wallpaper stays put.
    const next: CustomTheme = {
      ...preset,
      background: { ...theme.background, enabled: theme.background.enabled },
    };
    void setCustomTheme(next);
    if (!enabled) void setCustomThemeEnabled(true);
  };

  // Compute a non-conflicting preset name. If the input collides with a
  // built-in name or an existing user preset, append " (2)", " (3)", … until
  // unique. Keeps the user from accidentally shadowing "Dracula" et al.
  const uniquePresetName = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const used = new Set<string>([
      ...THEME_PRESETS.map((p) => p.name),
      ...userPresets.map((p) => p.name),
    ]);
    if (!used.has(trimmed)) return trimmed;
    for (let i = 2; i < 100; i++) {
      const candidate = `${trimmed} (${i})`;
      if (!used.has(candidate)) return candidate;
    }
    return `${trimmed} ${Date.now()}`;
  };

  const onSaveAsPreset = (rawName: string) => {
    const finalName = uniquePresetName(rawName);
    if (!finalName) return;
    const newPreset: CustomTheme = {
      ...theme,
      name: finalName,
      // Drop wallpaper from the saved preset - the user's wallpaper is a
      // separate concern and follows them across preset switches.
      background: {
        ...theme.background,
        enabled: false,
        path: "",
        dataUrl: "",
      },
    };
    void setUserThemePresets([...userPresets, newPreset]);
    // Switch the live theme name to the new preset so the "modified" tag
    // disappears until the user edits something again.
    void setCustomTheme({ ...theme, name: finalName });
    setSavePresetName(null);
  };

  const onDeleteUserPreset = (name: string) => {
    void setUserThemePresets(userPresets.filter((p) => p.name !== name));
    // If the live theme was the deleted preset, mark it as "(deleted preset)"
    // so the user understands its provenance vanished. They can keep editing
    // or pick another preset.
    if (theme.name === name) {
      void setCustomTheme({ ...theme, name: `${name} (deleted)` });
    }
  };

  const onPickBackground = async () => {
    setBgError(null);
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"],
          },
        ],
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      const result = await invoke<ReadResult>("fs_read_file", { path });
      if (result.kind === "image") {
        updateBackground({ enabled: true, path, dataUrl: result.dataUrl });
        ensureWallpaperVisible();
      } else if (result.kind === "toolarge") {
        setBgError(
          `Image is ${(result.size / (1024 * 1024)).toFixed(1)} MB, over the ${(
            result.limit /
            (1024 * 1024)
          ).toFixed(0)} MB limit.`,
        );
      } else {
        setBgError("Selected file isn't a recognised image.");
      }
    } catch (e) {
      setBgError(e instanceof Error ? e.message : String(e));
    }
  };

  const onClearBackground = () => {
    updateBackground({ enabled: false, path: "", dataUrl: "" });
  };

  // Quick-import wallpaper from a remote URL. We accept the URL as-is for
  // the dataUrl field (the CSS background-image: url() works with both
  // http(s) and data: URIs). Saves a roundtrip + base64 inflation that
  // would bloat the prefs store.
  const [bgUrlDraft, setBgUrlDraft] = useState("");
  const onImportBackgroundUrl = () => {
    setBgError(null);
    const url = bgUrlDraft.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !url.startsWith("data:")) {
      setBgError("Image URL must start with http://, https://, or data:.");
      return;
    }
    updateBackground({ enabled: true, path: url, dataUrl: url });
    ensureWallpaperVisible();
    setBgUrlDraft("");
  };

  const onImportFile = async (file: File) => {
    setImportError(null);
    setImportStatus(null);
    try {
      const text = await file.text();
      const parsed = parseThemeFile(JSON.parse(text), theme);
      void setCustomTheme(parsed);
      if (!enabled) void setCustomThemeEnabled(true);
      setImportStatus(`Imported "${parsed.name}".`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const onImportFromDialog = async () => {
    setImportError(null);
    setImportStatus(null);
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: "TEDI theme", extensions: ["tedi", "json"] }],
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      const result = await invoke<ReadResult>("fs_read_file", { path });
      if (result.kind !== "text") {
        setImportError("Theme file is not a UTF-8 text file.");
        return;
      }
      const parsed = parseThemeFile(JSON.parse(result.content), theme);
      void setCustomTheme(parsed);
      if (!enabled) void setCustomThemeEnabled(true);
      setImportStatus(`Imported "${parsed.name}".`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const onExport = async () => {
    try {
      const target = await saveFileDialog({
        defaultPath: `${slug(theme.name)}.tedi`,
        filters: [{ name: "TEDI theme", extensions: ["tedi"] }],
      });
      if (!target) return;
      // Keep HTTP(S) URLs in the export so recipients reuse the same
      // wallpaper. Drop inline `data:` blobs because they are typically
      // multi-MB base64 and bloat the theme file with non-portable bytes.
      const isDataUri = theme.background.dataUrl.startsWith("data:");
      const slim: CustomTheme = {
        ...theme,
        background: {
          ...theme.background,
          dataUrl: isDataUri ? "" : theme.background.dataUrl,
        },
      };
      const json = serializeThemeFile(slim);
      await invoke<void>("fs_write_file", { path: target, content: json });
      setImportStatus(`Exported to ${target}`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const onResetToDefault = () => {
    void setCustomTheme(DEFAULT_CUSTOM_THEME);
  };

  const visibleFields = useMemo(
    () => COLOR_FIELDS.filter((f) => f.group === activeGroup),
    [activeGroup],
  );

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Theme"
        description="Customise every color and add a background image."
      />

      <SettingRow
        title="Enable custom theme"
        description="When off, TEDI uses the default palette tinted by your main color."
      >
        <Switch checked={enabled} onCheckedChange={(v) => void setCustomThemeEnabled(v)} />
      </SettingRow>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Preset</Label>
          <div className="flex items-center gap-1">
            {savePresetName === null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => {
                  // Seed the input with the current name minus any
                  // "(modified)" suffix so a quick Enter saves over.
                  const seed = theme.name.replace(/\s*\(modified\)\s*$/i, "");
                  setSavePresetName(seed);
                }}
              >
                <HugeiconsIcon icon={BookmarkAdd02Icon} size={12} strokeWidth={1.75} />
                Save as preset
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                <Input
                  value={savePresetName}
                  onChange={(e) => setSavePresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onSaveAsPreset(savePresetName);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSavePresetName(null);
                    }
                  }}
                  placeholder="Preset name"
                  autoFocus
                  spellCheck={false}
                  className="h-7 w-40 text-[11.5px]"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={!savePresetName.trim()}
                  onClick={() => onSaveAsPreset(savePresetName)}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSavePresetName(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onResetToDefault}
            >
              Reset
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {[
            ...THEME_PRESETS.map((p) => ({ preset: p, deletable: false })),
            ...userPresets.map((p) => ({ preset: p, deletable: true })),
          ].map(({ preset: p, deletable }) => {
            const active = p.name === theme.name;
            return (
              <div key={p.name} className="group relative">
                <button
                  type="button"
                  onClick={() => onPickPreset(p)}
                  aria-pressed={active}
                  className={cn(
                    "bg-card/60 focus-visible:ring-ring/40 flex w-full items-center gap-2 border px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                    active
                      ? "border-primary ring-primary/40 ring-1"
                      : "border-border/60 hover:border-border",
                  )}
                >
                  <div
                    aria-hidden
                    className="border-border/40 flex shrink-0 flex-col overflow-hidden border"
                    style={{ width: 52, height: 24 }}
                  >
                    <div className="flex h-1/2 w-full">
                      {[p.light.background, p.light.button, p.light.accent, p.light.foreground].map(
                        (c, i) => (
                          <span
                            key={`l-${i}`}
                            className="h-full flex-1"
                            style={{ background: c }}
                          />
                        ),
                      )}
                    </div>
                    <div className="flex h-1/2 w-full">
                      {[p.dark.background, p.dark.button, p.dark.accent, p.dark.foreground].map(
                        (c, i) => (
                          <span
                            key={`d-${i}`}
                            className="h-full flex-1"
                            style={{ background: c }}
                          />
                        ),
                      )}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] font-medium">{p.name}</span>
                    <span className="text-muted-foreground text-[10px] tracking-wider uppercase">
                      {deletable ? "your preset" : "light / dark"}
                    </span>
                  </div>
                </button>
                {deletable ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteUserPreset(p.name);
                        }}
                        className="bg-background/90 text-muted-foreground hover:bg-destructive/10 hover:text-destructive border-border/60 absolute top-1 right-1 hidden size-5 cursor-pointer items-center justify-center border transition-colors group-hover:flex"
                        aria-label={`Delete preset ${p.name}`}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Delete &ldquo;{p.name}&rdquo;</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Colors</Label>
          <div className="bg-muted/40 inline-flex h-7 items-center p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setEditMode("light")}
              className={cn(
                "h-6 px-2.5 transition-colors",
                editMode === "light"
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Light
            </button>
            <button
              type="button"
              onClick={() => setEditMode("dark")}
              className={cn(
                "h-6 px-2.5 transition-colors",
                editMode === "dark"
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Dark
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {GROUPS.map((g) => (
            <Button
              key={g}
              type="button"
              variant={g === activeGroup ? "default" : "outline"}
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setActiveGroup(g)}
            >
              {g}
            </Button>
          ))}
        </div>
        <div className="border-border/60 bg-card/60 grid grid-cols-1 gap-1 border p-2 sm:grid-cols-2">
          {visibleFields.map((field) => (
            <div key={field.key} className="flex items-center justify-between gap-3 px-2 py-1.5">
              <span className="text-[11.5px]">{field.label}</span>
              <ColorSwatch
                value={activeColors[field.key]}
                onChange={(next) => updateColor(field.key, next)}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Background &amp; transparency</Label>
        {/* One opacity control for the whole app. 0% = fully see-through
         *  (reveals the image below, or the desktop when none is set),
         *  100% = solid. Each step writes + broadcasts the value, so the main
         *  window fades live as you drag and the value sticks. */}
        <div className="border-border/60 bg-card/60 flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
          <CompactSliderRow
            label="Opacity"
            valueLabel={`${Math.round((opacityPreview ?? appOpacity) * 100)}%`}
            value={appOpacity}
            min={APP_OPACITY_MIN}
            max={APP_OPACITY_MAX}
            step={APP_OPACITY_STEP}
            onPreview={(n) => {
              setOpacityPreview(n); // live % label
              previewAppOpacity(n); // live main-window fade (CSS only, no store write)
              // Persist at most ~5x/sec so the value sticks even if the commit
              // event is missed, without flooding/fighting the drag.
              const now = Date.now();
              if (now - lastOpacityPersistRef.current >= 200) {
                lastOpacityPersistRef.current = now;
                void setAppOpacity(n);
              }
            }}
            onCommit={(n) => {
              setOpacityPreview(null);
              void setAppOpacity(n);
            }}
          />
          <span className="text-muted-foreground text-[10.5px]">
            0% = fully transparent (shows the image below, or your desktop). Applies to everything:
            editor, terminal, SSH, diff, panels, menus, and extensions.
          </span>
        </div>
        {/* Unified source row: ONE input that accepts either a local file
         *  (via Browse) or a remote URL. Only one source is active at a
         *  time - picking a file replaces the URL; pasting a URL replaces
         *  the file. The Switch flips the layer on/off without losing the
         *  underlying source. */}
        <div className="border-border/60 bg-card/60 flex flex-col gap-2 rounded-lg border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={bgUrlDraft}
              onChange={(e) => setBgUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onImportBackgroundUrl();
                }
              }}
              placeholder="Paste an image, video (.mp4/.webm), or YouTube URL — or Browse for a local image"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="h-8 flex-1 font-mono text-[11px]"
              aria-label="Wallpaper source"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 px-2 text-[11px]"
                  disabled={!bgUrlDraft.trim()}
                  onClick={onImportBackgroundUrl}
                  aria-label="Use URL"
                >
                  <HugeiconsIcon icon={LinkSquare01Icon} size={12} strokeWidth={1.75} />
                  Use URL
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Load the URL above as the wallpaper. URLs are fetched on demand (not stored as
                base64).
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 px-2 text-[11px]"
                  onClick={() => void onPickBackground()}
                >
                  <HugeiconsIcon icon={Image01Icon} size={12} strokeWidth={1.75} />
                  Browse
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Pick a local image (PNG / JPG / WebP, max 10 MB). Inlined as a data URI in your
                prefs.
              </TooltipContent>
            </Tooltip>
            {theme.background.dataUrl ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-[11px]"
                    onClick={onClearBackground}
                    aria-label="Clear background"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Clear wallpaper</TooltipContent>
              </Tooltip>
            ) : null}
            <Switch
              checked={theme.background.enabled && !!theme.background.dataUrl}
              disabled={!theme.background.dataUrl}
              onCheckedChange={(v) => {
                updateBackground({ enabled: v });
                if (v) ensureWallpaperVisible();
              }}
              aria-label="Toggle background image"
            />
          </div>
          {/* Current source line - a faint indicator so the user can tell
           *  whether the wallpaper came from a file or a URL. */}
          {theme.background.dataUrl ? (
            <div className="text-muted-foreground truncate text-[10.5px]">
              {theme.background.path.startsWith("data:")
                ? "Local image (inlined)"
                : `Source: ${theme.background.path}`}
            </div>
          ) : null}
        </div>
        {bgError ? <span className="text-destructive text-[10.5px]">{bgError}</span> : null}
        {/* Wallpaper adjustments - grouped into a single card with inline
         *  rows so three sliders + their labels don't take up 3× the
         *  vertical space of separate `SettingRow`s. */}
        {theme.background.dataUrl ? (
          <div className="border-border/60 bg-card/60 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-[11.5px]">
            <CompactSliderRow
              label="Blur"
              valueLabel={`${theme.background.blur}px`}
              value={theme.background.blur}
              min={0}
              max={40}
              step={1}
              onPreview={(n) => {
                const el = document.getElementById("tedi-bg-layer");
                if (el) el.style.filter = n > 0 ? `blur(${n}px)` : "";
              }}
              onCommit={(n) => updateBackground({ blur: n })}
            />
            <CompactSliderRow
              label="Darken"
              valueLabel={`${Math.round((theme.background.darken ?? 0) * 100)}%`}
              value={theme.background.darken ?? 0}
              min={0}
              max={1}
              step={0.05}
              onPreview={(n) => {
                const el = document.getElementById("tedi-bg-layer");
                if (!el || !theme.background.dataUrl) return;
                const safeUrl = theme.background.dataUrl.replace(/"/g, '\\"');
                const overlay =
                  n > 0 ? `linear-gradient(rgba(0,0,0,${n}), rgba(0,0,0,${n})), ` : "";
                el.style.backgroundImage = `${overlay}url("${safeUrl}")`;
              }}
              onCommit={(n) => updateBackground({ darken: n })}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label>Import / Export</Label>
        <SettingRow
          title=".tedi theme file"
          description="Share themes with teammates. Files contain all colors plus background settings (image data is excluded from the export)."
        >
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-[11px]"
              onClick={() => void onImportFromDialog()}
            >
              <HugeiconsIcon icon={FolderUploadIcon} size={12} strokeWidth={1.75} />
              Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-[11px]"
              onClick={() => fileInputRef.current?.click()}
            >
              From file…
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-[11px]"
              onClick={() => void onExport()}
            >
              Export
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tedi,.json,application/json"
              aria-label="Import theme file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImportFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </SettingRow>
        {importError ? <span className="text-destructive text-[10.5px]">{importError}</span> : null}
        {importStatus ? (
          <span className="text-muted-foreground text-[10.5px]">{importStatus}</span>
        ) : null}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}

/**
 * Slider that only persists on release. While dragging, the value lives
 * in local React state and a cheap `onPreview` callback applies the new
 * value directly to the DOM (CSS variable, inline style, ...). On
 * commit, `onCommit` writes the final value to the store - one IPC
 * round-trip per drag instead of one per pixel.
 */
function LiveSlider({
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onPreview: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  const safe = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
  const [local, setLocal] = useState<number>(() => safe(value));
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(safe(value));
    // safe() is stable per render and depends only on min/max which are
    // bound at the call-site as literals; intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Slider
      className="w-full"
      min={min}
      max={max}
      step={step}
      value={[local]}
      onValueChange={(v) => {
        const n = v[0];
        if (typeof n !== "number") return;
        dragging.current = true;
        setLocal(n);
        onPreview(n);
      }}
      onValueCommit={(v) => {
        const n = v[0];
        dragging.current = false;
        if (typeof n === "number") onCommit(n);
      }}
    />
  );
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "theme"
  );
}

/**
 * Inline-row variant of `LiveSlider`: label + value chip + slider on a
 * single row. Used for the wallpaper adjustments (blur / opacity / darken)
 * which previously took 3 separate full-card `SettingRow` blocks.
 */
function CompactSliderRow({
  label,
  valueLabel,
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
}: {
  label: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onPreview: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-foreground w-32 shrink-0 text-[11.5px]">{label}</span>
      <div className="flex-1">
        <LiveSlider
          value={value}
          min={min}
          max={max}
          step={step}
          onPreview={onPreview}
          onCommit={onCommit}
        />
      </div>
      <span className="text-muted-foreground w-12 shrink-0 text-right font-mono text-[10.5px]">
        {valueLabel}
      </span>
    </div>
  );
}
