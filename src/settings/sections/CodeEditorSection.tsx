import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EDITOR_FONT_SIZES,
  EDITOR_THEME_LABELS,
  EDITOR_THEMES,
  LINE_WRAP_COLUMN_MAX,
  setEditorFontSize,
  setEditorLigatures,
  setEditorTheme,
  setFormatOnSave,
  setLineWrap,
  setLineWrapColumn,
  setShowMinimap,
  setVimMode,
  type EditorThemeId,
} from "@/modules/settings/store";
import { Label } from "../components/Label";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { SettingsAccordion } from "../components/SettingsAccordion";
import { FormattersTable } from "./components/FormattersTable";
import { ChevronDown } from "lucide-react";

export function CodeEditorSection() {
  const editorTheme = usePreferencesStore((s) => s.editorTheme);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const showMinimap = usePreferencesStore((s) => s.showMinimap);
  const lineWrap = usePreferencesStore((s) => s.lineWrap);
  const lineWrapColumn = usePreferencesStore((s) => s.lineWrapColumn);
  const editorLigatures = usePreferencesStore((s) => s.editorLigatures);
  const formatOnSave = usePreferencesStore((s) => s.formatOnSave);
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const formatterCount = usePreferencesStore((s) => Object.keys(s.formatters).length);

  const onPickEditor = (id: EditorThemeId) => void setEditorTheme(id);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Code Editor"
        description="Editor appearance, keybindings, and formatters."
      />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <SettingRow
          title="Editor theme"
          description="Syntax highlighting theme used inside the code editor and diff viewers."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 justify-between gap-2 px-2.5 text-[12px]">
                <span>{EDITOR_THEME_LABELS[editorTheme]}</span>
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              {EDITOR_THEMES.map((t) => (
                <DropdownMenuItem
                  key={t}
                  onSelect={() => onPickEditor(t)}
                  className={cn("text-[12px]", t === editorTheme && "bg-accent/50")}
                >
                  {EDITOR_THEME_LABELS[t]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
        <SettingRow
          title="Font size"
          description="Base code editor and diff text size. Zoom further with Ctrl + / Ctrl -."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 justify-between gap-2 px-2.5 text-[12px]">
                <span>{editorFontSize} px</span>
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-25">
              {EDITOR_FONT_SIZES.map((size) => (
                <DropdownMenuItem
                  key={size}
                  onSelect={() => void setEditorFontSize(size)}
                  className={cn("text-[12px]", size === editorFontSize && "bg-accent/50")}
                >
                  {size} px
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
        <SettingRow
          title="Show minimap"
          description="Display the code minimap on the right side of the editor."
        >
          <Switch checked={showMinimap} onCheckedChange={(v) => void setShowMinimap(v)} />
        </SettingRow>
        <SettingRow
          title="Font ligatures"
          description="Let the coding font fuse character pairs into one glyph, so => draws as an arrow and != as ≠. Off by default: a fused glyph paints outside its own cell, and the editor's WebView repaints only the cell you just typed, so freshly typed => and ==== can look half-erased until the line is redrawn."
        >
          <Switch checked={editorLigatures} onCheckedChange={(v) => void setEditorLigatures(v)} />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Editing</Label>
        <SettingRow title="Vim mode" description="Enable Vim keybindings in the code editor.">
          <Switch checked={vimMode} onCheckedChange={(v) => void setVimMode(v)} />
        </SettingRow>
        <SettingRow
          title="Word wrap"
          description="Break long lines instead of scrolling sideways. Also on the editor pane header and its keyboard shortcut."
        >
          <Switch checked={lineWrap} onCheckedChange={(v) => void setLineWrap(v)} />
        </SettingRow>
        {lineWrap && (
          <SettingRow
            title="Wrap column"
            description={`Character column wrapped lines break at. 0 wraps at the pane edge instead, which is what word wrap did before this setting. Max ${LINE_WRAP_COLUMN_MAX}.`}
          >
            <NumberInput
              className="h-9 w-24 text-[12px]"
              value={lineWrapColumn}
              onValueChange={(n) => void setLineWrapColumn(n)}
              min={0}
              max={LINE_WRAP_COLUMN_MAX}
              aria-label="Wrap column"
            />
          </SettingRow>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>Formatters</Label>
        <SettingRow
          title="Format on save"
          description="When saving (Ctrl+S), run the configured formatter for the file's language first. Shift+Alt+F formats without saving."
        >
          <Switch checked={formatOnSave} onCheckedChange={(v) => void setFormatOnSave(v)} />
        </SettingRow>
        <SettingsAccordion
          title="Per-language formatters"
          description="Pick the built-in Prettier or an external command per language, and override format-on-save individually."
          summary={
            formatterCount > 0
              ? `${formatterCount} language${formatterCount === 1 ? "" : "s"}`
              : "None"
          }
        >
          <FormattersTable />
        </SettingsAccordion>
      </div>
    </div>
  );
}
