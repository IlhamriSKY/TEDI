import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, slugify } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
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
  previewWallpaper,
  serializeThemeFile,
  type CustomTheme,
  type ThemeColors,
} from "@/modules/settings/customTheme";
import { DEFAULT_CUSTOM_THEME, THEME_PRESETS } from "@/modules/settings/themePresets";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/modules/theme";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { ColorSwatch } from "./theme/ColorPicker";
import { CompactSliderRow } from "./theme/Sliders";
import { COLOR_FIELDS, GROUPS, type Group } from "./theme/colorFields";
import { TerminalThemePanel } from "./TerminalThemePanel";
import { PalettePreview } from "./theme/PalettePreview";
import { SettingsAccordion } from "../components/SettingsAccordion";
import { UploadButton } from "../components/UploadButton";
import type { FsReadResult } from "@/lib/ipc";
import { BookmarkPlus, Download, ExternalLink, Image, Trash2, X } from "lucide-react";

type ReadResult = FsReadResult;

// Opacity to drop to when a wallpaper is first activated while the app is
// fully solid, so the image is clearly visible without manual fiddling.
const WALLPAPER_REVEAL_OPACITY = 0.5;

export function ThemeSection() {
  const enabled = usePreferencesStore((s) => s.customThemeEnabled);
  const theme = usePreferencesStore((s) => s.customTheme);
  const userPresets = usePreferencesStore((s) => s.userThemePresets);
  const appOpacity = usePreferencesStore((s) => s.appOpacity);
  // Live % while dragging the transparency slider (committed value persists on
  // release; the live fade comes from the previewAppOpacity CSS channel).
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null);
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
    if (appOpacity >= APP_OPACITY_MAX) {
      // Reveal instantly via the transient preview channel (CSS only, reaches
      // the main window immediately regardless of store-event routing), then
      // persist the same value so it survives reload. Both are 0.5, so there is
      // no drift between the live preview and the stored value.
      previewAppOpacity(WALLPAPER_REVEAL_OPACITY);
      void setAppOpacity(WALLPAPER_REVEAL_OPACITY);
    }
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
        defaultPath: `${slugify(theme.name, "theme")}.tedi`,
        filters: [{ name: "TEDI theme", extensions: ["tedi"] }],
      });
      if (!target) return;
      // Keep HTTP(S) URLs in the export so recipients reuse the same
      // wallpaper. Drop inline `data:` blobs because they are typically
      // multi-MB base64 and bloat the theme file with non-portable bytes. When
      // stripping a local data: image, also blank `path` (it holds the
      // exporter's absolute OS file path - a privacy leak) and turn the layer
      // off so the recipient doesn't get an enabled-but-empty wallpaper.
      const isDataUri = theme.background.dataUrl.startsWith("data:");
      const slim: CustomTheme = {
        ...theme,
        background: isDataUri
          ? { ...theme.background, enabled: false, path: "", dataUrl: "" }
          : theme.background,
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

      <SettingsAccordion title="Presets" summary={theme.name} defaultOpen>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-end gap-2">
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
                  <BookmarkPlus size={12} strokeWidth={1.75} />
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
                    variant="outline"
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
                variant="outline"
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
                      "bg-card focus-visible:ring-ring/40 flex w-full items-center gap-2 border px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                      active
                        ? "border-primary ring-primary/40 ring-1"
                        : "border-border/60 hover:border-border",
                    )}
                  >
                    <PalettePreview
                      background={p.dark.background}
                      dots={[
                        p.dark.button,
                        p.dark.accent,
                        p.dark.ansiRed,
                        p.dark.ansiGreen,
                        p.dark.ansiYellow,
                        p.dark.ansiBlue,
                        p.dark.ansiMagenta,
                      ]}
                    />
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
                          className={cn(
                            DESTRUCTIVE_ACTION,
                            "bg-background/90 border-border/60 absolute top-1 right-1 hidden size-5 cursor-pointer items-center justify-center border transition-colors group-hover:flex",
                          )}
                          aria-label={`Delete preset ${p.name}`}
                        >
                          <X size={10} strokeWidth={2} />
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
      </SettingsAccordion>

      <SettingsAccordion title="Colors" summary={editMode === "dark" ? "Dark" : "Light"}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-end">
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
          <div className="border-border/60 bg-card grid grid-cols-1 gap-1 border p-2 sm:grid-cols-2">
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
      </SettingsAccordion>

      <SettingsAccordion title="Terminal">
        <TerminalThemePanel />
      </SettingsAccordion>

      <SettingsAccordion title="Background &amp; wallpaper">
        <div className="flex flex-col gap-2">
          {/* One opacity control for the whole app. 0% = fully see-through
           *  (reveals the image below, or the desktop when none is set),
           *  100% = solid. Each step writes + broadcasts the value, so the main
           *  window fades live as you drag and the value sticks. */}
          <div className="border-border/60 bg-card flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
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
              }}
              onCommit={(n) => {
                setOpacityPreview(null);
                void setAppOpacity(n); // persist once on release (Radix fires this reliably)
              }}
            />
            <span className="text-muted-foreground text-[10.5px]">
              0% = fully transparent (shows the image below, or your desktop). Applies to
              everything: editor, terminal, SSH, diff, panels, menus, and extensions.
            </span>
          </div>
          {/* Unified source row: ONE input that accepts either a local file
           *  (via Browse) or a remote URL. Only one source is active at a
           *  time - picking a file replaces the URL; pasting a URL replaces
           *  the file. The Switch flips the layer on/off without losing the
           *  underlying source. */}
          <div className="border-border/60 bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5">
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
                  <UploadButton
                    icon={ExternalLink}
                    disabled={!bgUrlDraft.trim()}
                    onClick={onImportBackgroundUrl}
                    aria-label="Use URL"
                  >
                    Use URL
                  </UploadButton>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Load the URL above as the wallpaper. URLs are fetched on demand (not stored as
                  base64).
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <UploadButton icon={Image} onClick={() => void onPickBackground()}>
                    Browse
                  </UploadButton>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Pick a local image (PNG / JPG / GIF / WebP / AVIF, max 10 MB). Animated GIFs play
                  as a live wallpaper. Inlined as a data URI in your prefs.
                </TooltipContent>
              </Tooltip>
              {theme.background.dataUrl ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(DESTRUCTIVE_ACTION, "h-8 px-2 text-[11px]")}
                      onClick={onClearBackground}
                      aria-label="Clear background"
                    >
                      <Trash2 size={12} strokeWidth={1.75} />
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
            <div className="border-border/60 bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-[11.5px]">
              <CompactSliderRow
                label="Blur"
                valueLabel={`${theme.background.blur}px`}
                value={theme.background.blur}
                min={0}
                max={40}
                step={1}
                onPreview={(n) =>
                  // Live-preview on the main window's real wallpaper layer
                  // (kind-aware via applyBackground). The old code poked
                  // `#tedi-bg-layer` directly, but that element doesn't exist in
                  // the Settings webview, so the preview was a no-op. We send only
                  // the numbers; the main window merges them onto the wallpaper it
                  // already holds (no image blob over IPC).
                  previewWallpaper({
                    blur: n,
                    darken: theme.background.darken ?? 0,
                    opacity: theme.background.opacity ?? 1,
                  })
                }
                onCommit={(n) => updateBackground({ blur: n })}
              />
              <CompactSliderRow
                label="Darken"
                valueLabel={`${Math.round((theme.background.darken ?? 0) * 100)}%`}
                value={theme.background.darken ?? 0}
                min={0}
                max={1}
                step={0.05}
                onPreview={(n) =>
                  previewWallpaper({
                    blur: theme.background.blur,
                    darken: n,
                    opacity: theme.background.opacity ?? 1,
                  })
                }
                onCommit={(n) => updateBackground({ darken: n })}
              />
              <CompactSliderRow
                label="Image opacity"
                valueLabel={`${Math.round((theme.background.opacity ?? 1) * 100)}%`}
                value={theme.background.opacity ?? 1}
                min={0}
                max={1}
                step={0.05}
                onPreview={(n) =>
                  previewWallpaper({
                    blur: theme.background.blur,
                    darken: theme.background.darken ?? 0,
                    opacity: n,
                  })
                }
                onCommit={(n) => updateBackground({ opacity: n })}
              />
              <span className="text-muted-foreground text-[10.5px]">
                Image opacity lets your desktop show through the wallpaper itself (100% = the image
                fully hides the desktop). Combine with App opacity above to layer both.
              </span>
            </div>
          ) : null}
        </div>
      </SettingsAccordion>

      <SettingsAccordion title="Import / Export">
        <div className="flex flex-col gap-2">
          <SettingRow
            title=".tedi theme file"
            description="Share themes with teammates. Files contain all colors plus background settings (image data is excluded from the export)."
          >
            <div className="flex items-center gap-2">
              <UploadButton onClick={() => void onImportFromDialog()}>Import</UploadButton>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 text-[11px]"
                onClick={() => void onExport()}
              >
                <Download size={12} strokeWidth={1.75} />
                Export
              </Button>
            </div>
          </SettingRow>
          {importError ? (
            <span className="text-destructive text-[10.5px]">{importError}</span>
          ) : null}
          {importStatus ? (
            <span className="text-muted-foreground text-[10.5px]">{importStatus}</span>
          ) : null}
        </div>
      </SettingsAccordion>
    </div>
  );
}
