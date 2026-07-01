import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Label } from "../components/Label";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setTerminalCustomPalette,
  setTerminalThemeId,
  setTerminalThemeMode,
} from "@/modules/settings/store";
import {
  ANSI_KEYS,
  DEFAULT_TERMINAL_PALETTE,
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_PRESETS,
  type TerminalAnsi,
  type TerminalPalette,
} from "@/modules/settings/terminalPalette";
import { useState } from "react";
import { ColorSwatch } from "./theme/ColorPicker";
import { PalettePreview } from "./theme/PalettePreview";

const ANSI_LABELS: Record<keyof TerminalAnsi, string> = {
  black: "Black",
  red: "Red",
  green: "Green",
  yellow: "Yellow",
  blue: "Blue",
  magenta: "Magenta",
  cyan: "Cyan",
  white: "White",
  brightBlack: "Bright black",
  brightRed: "Bright red",
  brightGreen: "Bright green",
  brightYellow: "Bright yellow",
  brightBlue: "Bright blue",
  brightMagenta: "Bright magenta",
  brightCyan: "Bright cyan",
  brightWhite: "Bright white",
};

const NORMAL_KEYS = ANSI_KEYS.slice(0, 8) as readonly (keyof TerminalAnsi)[];
const BRIGHT_KEYS = ANSI_KEYS.slice(8) as readonly (keyof TerminalAnsi)[];
// Hues for the small preset chip strip (black is omitted; it disappears on dark).
const SWATCH_HUES = ANSI_KEYS.slice(1, 8) as readonly (keyof TerminalAnsi)[];

type BaseKey = "background" | "foreground" | "cursor" | "selection";
const BASE_FIELDS: { key: BaseKey; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "cursor", label: "Cursor" },
  { key: "selection", label: "Selection" },
];

/**
 * Terminal theme controls, embedded as a section inside the Theme tab (kept in
 * one place for a compact, tidy theme page). The terminal is still themed
 * independently of the app: "follow-app" mirrors the app palette, "custom" uses
 * its own. The full ANSI editor is collapsed by default to stay compact.
 */
export function TerminalThemePanel() {
  const mode = usePreferencesStore((s) => s.terminalThemeMode);
  const themeId = usePreferencesStore((s) => s.terminalThemeId);
  const palette = usePreferencesStore((s) => s.terminalCustomPalette);
  const isCustom = mode === "custom";
  const [showPalette, setShowPalette] = useState(false);

  const updateBase = (key: BaseKey, value: string) => {
    void setTerminalCustomPalette({ ...palette, name: "Custom", [key]: value });
    void setTerminalThemeId("custom");
  };

  const updateAnsi = (key: keyof TerminalAnsi, value: string) => {
    void setTerminalCustomPalette({
      ...palette,
      name: "Custom",
      ansi: { ...palette.ansi, [key]: value },
    });
    void setTerminalThemeId("custom");
  };

  const onPickPreset = (id: string, p: TerminalPalette) => {
    void setTerminalCustomPalette(p);
    void setTerminalThemeId(id);
    if (mode !== "custom") void setTerminalThemeMode("custom");
  };

  const onReset = () => {
    void setTerminalCustomPalette(DEFAULT_TERMINAL_PALETTE);
    void setTerminalThemeId(DEFAULT_TERMINAL_THEME_ID);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Independent palette</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[10.5px]">
            {isCustom ? "Custom palette" : "Follows app"}
          </span>
          <Switch
            checked={isCustom}
            onCheckedChange={(v) => void setTerminalThemeMode(v ? "custom" : "follow-app")}
          />
        </div>
      </div>
      <span className="text-muted-foreground text-[10.5px]">
        Theme the terminal independently of the app colors above. Off mirrors the app theme; on uses
        its own palette.
      </span>

      {isCustom ? (
        <div className="mt-1 flex flex-col gap-2">
          <TerminalPreview palette={palette} />

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {TERMINAL_PRESETS.map(({ id, palette: p }) => {
              const active = themeId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPickPreset(id, p)}
                  aria-pressed={active}
                  className={cn(
                    "bg-card/60 focus-visible:ring-ring/40 flex w-full items-center gap-2.5 border px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                    active
                      ? "border-primary ring-primary/40 ring-1"
                      : "border-border/60 hover:border-border",
                  )}
                >
                  <PalettePreview
                    background={p.background}
                    dots={SWATCH_HUES.map((k) => p.ansi[k])}
                  />
                  <span className="truncate text-[12px] font-medium">{p.name}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setShowPalette((v) => !v)}
              aria-expanded={showPalette}
            >
              {showPalette ? "Hide palette" : "Customise palette"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onReset}
            >
              Reset
            </Button>
          </div>

          {showPalette ? (
            <div className="flex flex-col gap-2">
              <div className="border-border/60 bg-card/60 grid grid-cols-1 gap-1 border p-2 sm:grid-cols-2">
                {BASE_FIELDS.map((f) => (
                  <ColorRow
                    key={f.key}
                    label={f.label}
                    value={palette[f.key]}
                    onChange={(n) => updateBase(f.key, n)}
                  />
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <AnsiGroup
                  label="Normal"
                  keys={NORMAL_KEYS}
                  palette={palette}
                  onChange={updateAnsi}
                />
                <AnsiGroup
                  label="Bright"
                  keys={BRIGHT_KEYS}
                  palette={palette}
                  onChange={updateAnsi}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AnsiGroup({
  label,
  keys,
  palette,
  onChange,
}: {
  label: string;
  keys: readonly (keyof TerminalAnsi)[];
  palette: TerminalPalette;
  onChange: (key: keyof TerminalAnsi, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="border-border/60 bg-card/60 flex flex-col gap-1 border p-2">
        {keys.map((k) => (
          <ColorRow
            key={k}
            label={ANSI_LABELS[k]}
            value={palette.ansi[k]}
            onChange={(n) => onChange(k, n)}
          />
        ))}
      </div>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-1.5 py-1">
      <span className="text-[11.5px]">{label}</span>
      <ColorSwatch value={value} onChange={onChange} />
    </div>
  );
}

/** Live sample styled like a small terminal window so palette edits read at a glance. */
function TerminalPreview({ palette }: { palette: TerminalPalette }) {
  return (
    <div
      className="border-border/60 overflow-hidden rounded-md border"
      style={{ background: palette.background, color: palette.foreground }}
    >
      <div
        className="flex items-center gap-1.5 border-b px-3 py-1.5"
        style={{ borderColor: "rgba(127,127,127,0.18)" }}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: palette.ansi.red }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: palette.ansi.yellow }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: palette.ansi.green }} />
        <span
          className="ml-1 text-[10px] tracking-wide uppercase"
          style={{ color: palette.ansi.brightBlack }}
        >
          terminal
        </span>
      </div>
      <div className="px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
        <div>
          <span style={{ color: palette.ansi.green }}>~/tedi</span>{" "}
          <span style={{ color: palette.ansi.blue }}>git:(</span>
          <span style={{ color: palette.ansi.red }}>main</span>
          <span style={{ color: palette.ansi.blue }}>)</span>{" "}
          <span style={{ color: palette.foreground }}>echo hello</span>
        </div>
        <div style={{ color: palette.ansi.brightBlack }}># a comment</div>
        <div>
          <span style={{ color: palette.ansi.yellow }}>warning</span>
          <span style={{ color: palette.foreground }}>: </span>
          <span style={{ color: palette.ansi.magenta }}>const</span>{" "}
          <span style={{ color: palette.ansi.cyan }}>x</span> ={" "}
          <span style={{ color: palette.ansi.green }}>&quot;ok&quot;</span>
          <span
            className="ml-0.5 inline-block h-3.5 w-[7px] align-middle"
            style={{ background: palette.cursor }}
          />
        </div>
      </div>
    </div>
  );
}
