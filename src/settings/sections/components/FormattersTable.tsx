import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ALL_LANGUAGES,
  BUILTIN_LANGUAGES,
  EXTERNAL_PRESETS,
  LANGUAGE_LABELS,
  buildPresetConfig,
  hasPreset,
} from "@/modules/editor/lib/formatters";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { patchFormatter, type FormatterConfig } from "@/modules/settings/store";
import { useMemo, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";

type FormatterType = FormatterConfig["type"];

const TYPE_LABEL: Record<FormatterType, string> = {
  builtin: "Built-in (Prettier)",
  external: "External command",
  none: "Disabled",
};

/** Parses a free-form args string into argv. Handles double-quoted segments
 *  so users can pass `--format "foo bar"` without losing the space. Single
 *  quotes are NOT special — VSCode's `formatter.args` works the same way. */
function parseArgs(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === " " && !inQuotes) {
      if (buf.length > 0) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function stringifyArgs(args: string[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
}

export function FormattersTable() {
  const formatters = usePreferencesStore((s) => s.formatters);
  const [pickerOpen, setPickerOpen] = useState(false);

  const rows = useMemo(
    () =>
      Object.keys(formatters).sort((a, b) => {
        const la = LANGUAGE_LABELS[a] ?? a;
        const lb = LANGUAGE_LABELS[b] ?? b;
        return la.localeCompare(lb);
      }),
    [formatters],
  );

  const unconfigured = useMemo(
    () => ALL_LANGUAGES.filter((id) => !(id in formatters)),
    [formatters],
  );

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-[11px]">
          No formatters configured. Add a language below to set one up.
        </p>
      ) : (
        <div className="border-border/60 bg-card/40 divide-border/40 divide-y overflow-hidden rounded-lg border">
          {rows.map((lang) => (
            <FormatterRow
              key={lang}
              language={lang}
              config={formatters[lang]!}
              snapshot={formatters}
            />
          ))}
        </div>
      )}
      {unconfigured.length > 0 && (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 w-fit gap-1.5 px-2 text-[11px]">
              <Plus size={12} strokeWidth={1.75} />
              Add language…
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={6}
            className="w-72 gap-0 overflow-hidden rounded-2xl p-0"
          >
            <Command className="rounded-2xl">
              <CommandInput placeholder="Search language…" className="text-[12px]" />
              <CommandList className="max-h-64">
                <CommandEmpty className="py-4 text-[11px]">No language found.</CommandEmpty>
                <CommandGroup>
                  {unconfigured.map((id) => {
                    const label = LANGUAGE_LABELS[id] ?? id;
                    const presetCmd =
                      hasPreset(id) && !BUILTIN_LANGUAGES.has(id)
                        ? EXTERNAL_PRESETS[id]!.command
                        : null;
                    return (
                      <CommandItem
                        key={id}
                        value={`${label} ${id}`}
                        onSelect={() => {
                          // Pre-fill with the most useful config: builtin if
                          // Prettier supports it, otherwise the preset external
                          // command if one's registered (rustfmt, gofmt, etc.),
                          // otherwise an empty external row for the user to fill.
                          const next: FormatterConfig = BUILTIN_LANGUAGES.has(id)
                            ? { type: "builtin" }
                            : (buildPresetConfig(id) ?? { type: "external" });
                          void patchFormatter(formatters, id, next);
                          setPickerOpen(false);
                        }}
                        className="gap-3 rounded-xl px-2.5 py-1.5 text-[12px]"
                      >
                        <span className="truncate">{label}</span>
                        {presetCmd ? (
                          <CommandShortcut className="font-mono text-[10px] tracking-normal">
                            {presetCmd}
                          </CommandShortcut>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function FormatterRow({
  language,
  config,
  snapshot,
}: {
  language: string;
  config: FormatterConfig;
  snapshot: Record<string, FormatterConfig>;
}) {
  const label = LANGUAGE_LABELS[language] ?? language;
  const builtinAvailable = BUILTIN_LANGUAGES.has(language);

  // Local mirror so typing in command/args feels instant; persisted on blur
  // (or change, for the dropdown). The mirror reseeds whenever the prop
  // identity flips (e.g. after a different surface updates the config).
  const [draftCommand, setDraftCommand] = useState(config.command ?? "");
  const [draftArgs, setDraftArgs] = useState(() => stringifyArgs(config.args));

  const setType = (type: FormatterType) => {
    if (type === "builtin" && !builtinAvailable) return;
    void patchFormatter(snapshot, language, { ...config, type });
  };

  const persistCommand = () => {
    if (draftCommand === (config.command ?? "")) return;
    void patchFormatter(snapshot, language, { ...config, command: draftCommand });
  };

  const persistArgs = () => {
    const parsed = parseArgs(draftArgs);
    if (stringifyArgs(parsed) === stringifyArgs(config.args)) return;
    void patchFormatter(snapshot, language, { ...config, args: parsed });
  };

  const setFormatOnSaveOverride = (value: boolean | null) => {
    const next: FormatterConfig = { ...config };
    if (value === null) delete next.formatOnSave;
    else next.formatOnSave = value;
    void patchFormatter(snapshot, language, next);
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-[12.5px] font-medium">{label}</span>
          <span className="text-muted-foreground font-mono text-[10px]">{language}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[11px]">
                <span>{TYPE_LABEL[config.type]}</span>
                <ChevronDown size={11} strokeWidth={2} className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem
                onSelect={() => setType("builtin")}
                disabled={!builtinAvailable}
                className={cn(
                  "text-[12px]",
                  config.type === "builtin" && "bg-accent/50",
                  !builtinAvailable && "text-muted-foreground",
                )}
              >
                {builtinAvailable ? "Built-in (Prettier)" : "Built-in — not supported"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setType("external")}
                className={cn("text-[12px]", config.type === "external" && "bg-accent/50")}
              >
                External command
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setType("none")}
                className={cn("text-[12px]", config.type === "none" && "bg-accent/50")}
              >
                Disabled
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hover:bg-destructive/10 hover:text-destructive size-7"
                onClick={() => void patchFormatter(snapshot, language, null)}
                aria-label="Remove formatter"
              >
                <Trash2 size={13} strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Reset to default (no formatter)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {config.type === "external" && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <Input
              value={draftCommand}
              onChange={(e) => setDraftCommand(e.target.value)}
              onBlur={persistCommand}
              placeholder="e.g. rustfmt"
              spellCheck={false}
              className="h-7 font-mono text-[11px]"
              aria-label={`${label} formatter command`}
            />
            <Input
              value={draftArgs}
              onChange={(e) => setDraftArgs(e.target.value)}
              onBlur={persistArgs}
              placeholder='e.g. --emit stdout  (use "${file}" for a temp-file)'
              spellCheck={false}
              className="h-7 font-mono text-[11px]"
              aria-label={`${label} formatter args`}
            />
          </div>
          {hasPreset(language) && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground self-end text-[10px] underline-offset-2 hover:underline"
              onClick={() => {
                const preset = buildPresetConfig(language);
                if (!preset) return;
                setDraftCommand(preset.command ?? "");
                setDraftArgs(stringifyArgs(preset.args));
                void patchFormatter(snapshot, language, {
                  ...config,
                  command: preset.command,
                  args: preset.args,
                });
              }}
            >
              Use suggested:{" "}
              <span className="font-mono">
                {EXTERNAL_PRESETS[language]!.command} {EXTERNAL_PRESETS[language]!.args.join(" ")}
              </span>
            </button>
          )}
        </div>
      )}

      <div className="text-muted-foreground flex items-center justify-between gap-2 text-[10.5px]">
        <span className="min-w-0 truncate">
          {config.type === "builtin" && "Uses bundled Prettier."}
          {config.type === "external" &&
            'Pipes buffer via stdin. Use "${file}" in args for in-place temp-file mode.'}
          {config.type === "none" && "Format-on-save is skipped for this language."}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 gap-1 px-2 text-[10.5px]"
              disabled={config.type === "none"}
            >
              {config.formatOnSave === true && "Always format on save"}
              {config.formatOnSave === false && "Never format on save"}
              {config.formatOnSave === undefined && "Follow global setting"}
              <ChevronDown size={10} strokeWidth={2} className="opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem
              onSelect={() => setFormatOnSaveOverride(null)}
              className={cn("text-[11.5px]", config.formatOnSave === undefined && "bg-accent/50")}
            >
              Follow global setting
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setFormatOnSaveOverride(true)}
              className={cn("text-[11.5px]", config.formatOnSave === true && "bg-accent/50")}
            >
              Always format on save
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setFormatOnSaveOverride(false)}
              className={cn("text-[11.5px]", config.formatOnSave === false && "bg-accent/50")}
            >
              Never format on save
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
