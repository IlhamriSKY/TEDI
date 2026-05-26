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
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  CONTENT_ZOOM_DEFAULT,
  CONTENT_ZOOM_MAX,
  CONTENT_ZOOM_MIN,
  CONTENT_ZOOM_STEP,
  TERMINAL_FONT_SIZES,
  setAiNotificationsEnabled,
  setAutostart,
  setContentZoom,
  setRestoreWindowState,
  setShowHiddenFiles,
  setShowSourceControl,
  setSourceControlInRightPanel,
  setTerminalFontSize,
  setTerminalWebglEnabled,
} from "@/modules/settings/store";
import { IS_WINDOWS } from "@/lib/platform";
import { useTheme } from "@/modules/theme";
import { ArrowDown01Icon, ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

type ShimInstallResult =
  | { status: "installed"; path: string; target: string; on_path: boolean }
  | { status: "not_applicable"; message: string };

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

export function GeneralSection() {
  const { theme, setTheme } = useTheme();
  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const terminalWebglEnabled = usePreferencesStore((s) => s.terminalWebglEnabled);
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  const sourceControlInRightPanel = usePreferencesStore((s) => s.sourceControlInRightPanel);
  const aiNotificationsEnabled = usePreferencesStore((s) => s.aiNotificationsEnabled);
  const contentZoom = usePreferencesStore((s) => s.contentZoom);
  // Local mirror for live drag. Persisted on slider release so we don't
  // hit the prefs store + cross-window emit on every mousemove tick.
  const [zoomDraft, setZoomDraft] = useState(contentZoom);
  const zoomDragging = useRef(false);
  useEffect(() => {
    if (!zoomDragging.current) setZoomDraft(contentZoom);
  }, [contentZoom]);
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
          {APPEARANCE.map((o) => (
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
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Zoom</Label>
        <SettingRow
          title="UI zoom level"
          description="Scales the terminal font and code editor / diff content. Range 50%–300%."
        >
          <div className="flex w-64 items-center gap-2.5">
            <Slider
              min={CONTENT_ZOOM_MIN}
              max={CONTENT_ZOOM_MAX}
              step={CONTENT_ZOOM_STEP}
              value={[zoomDraft]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next !== "number") return;
                zoomDragging.current = true;
                setZoomDraft(next);
                document.documentElement.style.setProperty("--content-zoom", String(next));
              }}
              onValueCommit={(values) => {
                const next = values[0];
                zoomDragging.current = false;
                if (typeof next === "number") void setContentZoom(next);
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
              disabled={zoomDraft === CONTENT_ZOOM_DEFAULT}
              onClick={() => {
                setZoomDraft(CONTENT_ZOOM_DEFAULT);
                document.documentElement.style.setProperty(
                  "--content-zoom",
                  String(CONTENT_ZOOM_DEFAULT),
                );
                void setContentZoom(CONTENT_ZOOM_DEFAULT);
              }}
              aria-label="Reset zoom"
            >
              Reset
            </Button>
          </div>
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
                  xterm's WebGL renderer caches glyphs in a GPU texture atlas. On some macOS
                  setups (especially with Nerd Fonts), the atlas corrupts and terminal text
                  becomes unreadable. Turn this off as a fallback - performance dips slightly, but
                  text renders correctly via the DOM renderer.
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
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  className="opacity-70"
                />
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
        <Label>Source Control</Label>
        <SettingRow
          title="Show Source Control"
          description="Display the Source Control panel in the sidebar."
        >
          <Switch
            checked={showSourceControl}
            onCheckedChange={(v) => void setShowSourceControl(v)}
          />
        </SettingRow>
        <SettingRow
          title="Move Source Control to the right panel"
          description="Mount Source Control next to the AI sidebar instead of the left sidebar. A status-bar button toggles it open."
        >
          <Switch
            checked={sourceControlInRightPanel}
            disabled={!showSourceControl}
            onCheckedChange={(v) => void setSourceControlInRightPanel(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Command line</Label>
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
              className="h-8 px-3 text-[11.5px]"
              disabled={shimBusy}
              onClick={() => void onInstallShim()}
            >
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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}
