import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useExtensionsStore } from "@/modules/extensions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SEARCH_ENGINES, searchEngineById } from "@/modules/settings/searchEngines";
import type { ThemePref } from "@/modules/settings/store";
import {
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_OPTIONS,
  MAX_SOUND_BYTES,
  setAiNotificationsEnabled,
  setAiBlockingSound,
  setAiCompletionSound,
  setAutostart,
  setRestoreWindowState,
  setSearchEngine,
  setUiZoom,
  setShowHiddenFiles,
  setShowSourceControl,
  setFontFamily,
  setTerminalFontSize,
  setTerminalScrollback,
  setTerminalWebglEnabled,
} from "@/modules/settings/store";
import { CONTENT_FONT_OPTIONS } from "@/lib/fonts";
import { previewNotificationSound } from "@/lib/blockingBeep";
import { IS_WINDOWS } from "@/lib/platform";
import { useTheme } from "@/modules/theme";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import { Label } from "../components/Label";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { SettingsAccordion } from "../components/SettingsAccordion";
import { AdditionalPathEditor } from "./components/AdditionalPathEditor";
import { CliAgentsCard } from "./components/CliAgentsCard";
import { UploadButton } from "../components/UploadButton";
import { ChevronDown, Download, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

type ShimInstallResult =
  | { status: "installed"; path: string; target: string; on_path: boolean }
  | { status: "not_applicable"; message: string };

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export function GeneralSection() {
  const { theme, setTheme } = useTheme();
  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const terminalWebglEnabled = usePreferencesStore((s) => s.terminalWebglEnabled);
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  // SQL Explorer "show/hide" maps to enabling/disabling the extension (which
  // adds/removes its Databases panel everywhere). Only offered when installed.
  const sqlExplorerExt = useExtensionsStore((s) => s.list).find(
    (e) => e.id === "tedi.sql-explorer",
  );
  const aiNotificationsEnabled = usePreferencesStore((s) => s.aiNotificationsEnabled);
  const aiBlockingSound = usePreferencesStore((s) => s.aiBlockingSound);
  const aiCompletionSound = usePreferencesStore((s) => s.aiCompletionSound);
  const customSoundCount = [aiBlockingSound, aiCompletionSound].filter(Boolean).length;
  const searchEngine = usePreferencesStore((s) => s.searchEngine);
  const uiZoom = usePreferencesStore((s) => s.uiZoom);
  const fontFamily = usePreferencesStore((s) => s.fontFamily);
  // Local mirror for live drag. Persisted on slider release so we don't
  // hit the prefs store + cross-window emit on every mousemove tick.
  const [zoomDraft, setZoomDraft] = useState(uiZoom);
  const zoomDragging = useRef(false);
  useEffect(() => {
    if (!zoomDragging.current) setZoomDraft(uiZoom);
  }, [uiZoom]);
  const zoomPct = Math.round(zoomDraft * 100);

  // Reconcile autostart pref with actual OS state on mount; the user may have
  // toggled it from System Settings.
  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  const onToggleTerminalWebgl = (next: boolean) => {
    void setTerminalWebglEnabled(next).catch((e) =>
      console.error("terminal WebGL preference update failed", e),
    );
  };

  const onPickTerminalFontSize = (size: number) => void setTerminalFontSize(size);

  const [shimStatus, setShimStatus] = useState<ShimInstallResult | null>(null);
  const [shimError, setShimError] = useState<string | null>(null);
  const [shimBusy, setShimBusy] = useState(false);
  const onInstallShim = async () => {
    setShimBusy(true);
    setShimError(null);
    try {
      const res = await invoke<ShimInstallResult>("cli_install_path_shim");
      setShimStatus(res);
    } catch (e) {
      setShimError(typeof e === "string" ? e : String(e));
    } finally {
      setShimBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="General" description="Appearance, editor, and startup." />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => {
            const Icon = o.icon;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => setTheme(o.id)}
                className={cn(
                  "group bg-card flex h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border transition-all",
                  theme === o.id
                    ? "border-foreground/60 ring-foreground/20 ring-1"
                    : "border-border/60 hover:border-border",
                )}
              >
                <Icon size={18} strokeWidth={1.5} />
                <span className="text-[11.5px]">{o.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Zoom</Label>
        <SettingRow
          title="UI zoom level"
          description="Scales the app interface only: header, tabs, sidebar, panels and status bar. The terminal and code editor zoom with Ctrl + / Ctrl - instead. Range 50%–200%."
        >
          <div className="flex w-64 items-center gap-2.5">
            <Slider
              min={UI_ZOOM_MIN}
              max={UI_ZOOM_MAX}
              step={UI_ZOOM_STEP}
              value={[zoomDraft]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next !== "number") return;
                zoomDragging.current = true;
                setZoomDraft(next);
              }}
              onValueCommit={(values) => {
                const next = values[0];
                zoomDragging.current = false;
                if (typeof next === "number") void setUiZoom(next);
              }}
              aria-label="UI zoom level"
            />
            <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-[11px] tabular-nums">
              {zoomPct}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-[11px]"
              disabled={zoomDraft === UI_ZOOM_DEFAULT}
              onClick={() => {
                setZoomDraft(UI_ZOOM_DEFAULT);
                void setUiZoom(UI_ZOOM_DEFAULT);
              }}
              aria-label="Reset zoom"
            >
              Reset
            </Button>
          </div>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Font</Label>
        <SettingRow
          title="Font family"
          description="Monospace font for the terminal and code editor. Falls back to a bundled Nerd Font when the chosen font isn't installed, so the choice is always safe."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 justify-between gap-2 px-2.5 text-[12px]">
                <span>
                  {CONTENT_FONT_OPTIONS.find((o) => o.id === fontFamily)?.label ?? "System default"}
                </span>
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {CONTENT_FONT_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.id}
                  onSelect={() => void setFontFamily(o.id)}
                  className={cn("text-[12px]", o.id === fontFamily && "bg-accent/50")}
                  style={o.family ? { fontFamily: `"${o.family}", monospace` } : undefined}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Use WebGL renderer
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="text-muted-foreground/70 cursor-help text-[11px] leading-none"
                    aria-label="More info about WebGL renderer"
                  >
                    ⓘ
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  xterm's WebGL renderer caches glyphs in a GPU texture atlas. On some macOS setups
                  (especially with Nerd Fonts), the atlas corrupts and terminal text becomes
                  unreadable. Turn this off as a fallback - performance dips slightly, but text
                  renders correctly via the DOM renderer.
                </TooltipContent>
              </Tooltip>
            </span>
          }
          description="Hardware-accelerated rendering. Turn off if text shows corruption or blank tiles."
        >
          <Switch checked={terminalWebglEnabled} onCheckedChange={onToggleTerminalWebgl} />
        </SettingRow>
        <SettingRow title="Font size" description="Terminal text size.">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 justify-between gap-2 px-2.5 text-[12px]">
                <span>{terminalFontSize} px</span>
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-25">
              {TERMINAL_FONT_SIZES.map((size) => (
                <DropdownMenuItem
                  key={size}
                  onSelect={() => onPickTerminalFontSize(size)}
                  className={cn("text-[12px]", size === terminalFontSize && "bg-accent/50")}
                >
                  {size} px
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
        <SettingRow
          title="Scrollback limit"
          description="Max lines you can scroll back per terminal. Lower uses less memory, like a CMD screen-buffer cap. Applies to open terminals instantly."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 justify-between gap-2 px-2.5 text-[12px]">
                <span>{terminalScrollback.toLocaleString()} lines</span>
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-25">
              {TERMINAL_SCROLLBACK_OPTIONS.map((n) => (
                <DropdownMenuItem
                  key={n}
                  onSelect={() => void setTerminalScrollback(n)}
                  className={cn("text-[12px]", n === terminalScrollback && "bg-accent/50")}
                >
                  {n.toLocaleString()} lines
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
        <AdditionalPathEditor />
        <CliAgentsCard />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Explorer</Label>
        <SettingRow
          title="Show hidden files & folders"
          description="Reveal dot-prefixed entries (.git, .env, .vscode, …) in the file tree and search."
        >
          <Switch checked={showHiddenFiles} onCheckedChange={(v) => void setShowHiddenFiles(v)} />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Browser</Label>
        <SettingRow
          title="Default search engine"
          description='Typing a non-URL term in the browser address bar runs a search with this engine. E.g. "youtube" opens search results instead of failing to load.'
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 justify-between gap-2 px-2.5 text-[12px]">
                <span>{searchEngineById(searchEngine).label}</span>
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {SEARCH_ENGINES.map((e) => (
                <DropdownMenuItem
                  key={e.id}
                  onSelect={() => void setSearchEngine(e.id)}
                  className={cn("text-[12px]", e.id === searchEngine && "bg-accent/50")}
                >
                  {e.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Sidebar panels</Label>
        <SettingRow
          title="Show Source Control"
          description="Display the Source Control panel in the sidebar."
        >
          <Switch
            checked={showSourceControl}
            onCheckedChange={(v) => void setShowSourceControl(v)}
          />
        </SettingRow>
        {sqlExplorerExt ? (
          <SettingRow
            title="Show SQL Explorer"
            description="Display the SQL Explorer (Databases) panel in the sidebar."
          >
            <Switch
              checked={sqlExplorerExt.enabled}
              onCheckedChange={(v) =>
                void useExtensionsStore.getState().setEnabled("tedi.sql-explorer", v)
              }
            />
          </SettingRow>
        ) : null}
      </div>

      <SettingsAccordion
        title="Command line"
        description="Run `tedi .` from any terminal to open a folder in TEDI."
        summary={
          IS_WINDOWS
            ? "via installer"
            : shimStatus?.status === "installed"
              ? "Installed"
              : "Optional"
        }
      >
        <div className="flex flex-col gap-2">
          {IS_WINDOWS ? (
            <SettingRow
              title="tedi command"
              description="The Windows installer adds a `tedi.cmd` shim and appends the install dir to your user PATH. Reinstall TEDI if `tedi .` isn't found."
            >
              <span className="text-muted-foreground text-[11px]">via installer</span>
            </SettingRow>
          ) : (
            <SettingRow
              title="Install `tedi` command in PATH"
              description="Drops a wrapper at ~/.local/bin/tedi so terminals can run `tedi .` to open the current folder. Re-run after upgrading TEDI."
            >
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 text-[11px]"
                disabled={shimBusy}
                onClick={() => void onInstallShim()}
              >
                <Download size={12} strokeWidth={1.75} />
                {shimBusy ? "Installing…" : "Install"}
              </Button>
            </SettingRow>
          )}
          {shimError ? <span className="text-destructive text-[10.5px]">{shimError}</span> : null}
          {shimStatus?.status === "installed" ? (
            <span className="text-muted-foreground text-[10.5px]">
              Installed at <code className="text-foreground">{shimStatus.path}</code> →{" "}
              <code className="text-foreground">{shimStatus.target}</code>.{" "}
              {shimStatus.on_path
                ? "Open a new terminal and try `tedi .`."
                : '~/.local/bin isn\'t on your PATH yet - add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc.'}
            </span>
          ) : null}
          {shimStatus?.status === "not_applicable" ? (
            <span className="text-muted-foreground text-[10.5px]">{shimStatus.message}</span>
          ) : null}
        </div>
      </SettingsAccordion>

      <div className="flex flex-col gap-2">
        <Label>Notifications</Label>
        <SettingRow
          title="AI CLI notifications"
          description="Show a toast and play a sound when an AI CLI (Claude, Codex, opencode, …) needs your approval or finishes a task. The status badge on the tab is unaffected."
        >
          <Switch
            checked={aiNotificationsEnabled}
            onCheckedChange={(v) => void setAiNotificationsEnabled(v)}
          />
        </SettingRow>
        <SettingsAccordion
          title="Notification sounds"
          description="Customize the approval and completion sounds, or revert to the built-in beep."
          summary={customSoundCount > 0 ? `${customSoundCount} custom` : "Default"}
        >
          <div className="flex flex-col gap-2">
            <SoundSetting
              title="Approval sound"
              kind="blocking"
              value={aiBlockingSound}
              onChange={setAiBlockingSound}
            />
            <SoundSetting
              title="Completion sound"
              kind="completion"
              value={aiCompletionSound}
              onChange={setAiCompletionSound}
            />
          </div>
        </SettingsAccordion>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open TEDI automatically when you sign in."
          >
            <Switch checked={autostart} onCheckedChange={(v) => void onToggleAutostart(v)} />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|m4a|mp4|aac|flac|opus|weba)$/i;

/**
 * Coerce a FileReader `readAsDataURL` result into an audio data URL, or null if
 * the file is not audio. FileReader stamps the data URL with the browser's
 * detected MIME (`file.type`); when that comes back empty/generic for a clearly
 * audio file (rare, format-dependent), rebuild the URL with a sensible audio
 * MIME so it still passes `normalizeSoundData` and plays.
 */
function toAudioDataUrl(file: File, result: string): string | null {
  if (!result.startsWith("data:")) return null;
  const comma = result.indexOf(",");
  if (comma < 0) return null;
  const mime = result.slice(5, comma).split(";")[0];
  if (/^audio\//i.test(mime)) return result;
  if (file.type.startsWith("audio/") || AUDIO_EXT_RE.test(file.name)) {
    const forced = file.type.startsWith("audio/") ? file.type : "audio/mpeg";
    return `data:${forced};base64,${result.slice(comma + 1)}`;
  }
  return null;
}

/**
 * One custom-notification-sound row: Play (preview), Upload (.mp3/.wav/.ogg/.m4a
 * via a hidden file input, read inline as a data URL), and Default (revert to the
 * built-in beep). `onChange("")` clears the custom sound. No Tauri dialog/fs
 * permission needed - the HTML file input yields the bytes directly in the webview.
 */
function SoundSetting({
  title,
  kind,
  value,
  onChange,
}: {
  title: string;
  kind: "blocking" | "completion";
  value: string;
  onChange: (value: string) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const isCustom = value.length > 0;

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (file.size > MAX_SOUND_BYTES) {
      setError(`File too large (max ${(MAX_SOUND_BYTES / (1024 * 1024)).toFixed(0)} MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const audio = typeof reader.result === "string" ? toAudioDataUrl(file, reader.result) : null;
      if (audio) {
        setError(null);
        void onChange(audio);
      } else {
        setError("Unsupported file. Try an .mp3, .wav, .ogg, or .m4a.");
      }
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        title={title}
        description={
          isCustom
            ? "Custom sound. Press play to preview, or revert to the built-in beep."
            : "Built-in beep. Upload an .mp3, .wav, .ogg, or .m4a (max 1 MB) to customize."
        }
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept="audio/*"
            aria-label={`Upload custom ${title.toLowerCase()}`}
            className="hidden"
            onChange={onPick}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-[11px]"
            onClick={() => previewNotificationSound(kind, value)}
            title="Preview"
          >
            Play
          </Button>
          <UploadButton onClick={() => inputRef.current?.click()}>Upload</UploadButton>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-[11px]"
            disabled={!isCustom}
            onClick={() => {
              setError(null);
              void onChange("");
            }}
          >
            Default
          </Button>
        </div>
      </SettingRow>
      {error ? <span className="text-destructive px-1 text-[10.5px]">{error}</span> : null}
    </div>
  );
}
