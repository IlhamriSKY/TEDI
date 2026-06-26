import { memo, useMemo } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { fileIconUrl, useExplorerIconsReady } from "@/modules/explorer/lib/iconResolver";
import { LANGUAGES, languageIconFile, languageLabel } from "./lib/languages";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Language currently applied to the editor (override if set, else detected). */
  currentId: string | null;
  /** Language the file path resolves to - shown with a "default" badge. */
  detectedId: string | null;
  /** Whether the user has manually overridden the language for this file. */
  isOverridden: boolean;
  /** `id` selects that language; `null` reverts to automatic detection. */
  onPick: (id: string | null) => void;
};

/** Small icon resolved through the file tree's icon pack (so it matches). */
function LangIcon({ id }: { id: string }) {
  // Re-render once the catppuccin chunk lands; `fileIconUrl` is empty until then.
  useExplorerIconsReady();
  const url = fileIconUrl(languageIconFile(id));
  return url ? (
    <img src={url} alt="" className="size-4 shrink-0" />
  ) : (
    <span className="size-4 shrink-0" />
  );
}

/**
 * VS Code-style "Change Language Mode" picker: a searchable command palette of
 * every registered language, each with the same glyph the file tree shows. The
 * path-detected language carries a "default" badge; the active one is checked.
 */
function LanguagePickerDialogImpl({
  open,
  onOpenChange,
  currentId,
  detectedId,
  isOverridden,
  onPick,
}: Props) {
  // Alphabetical for predictable scanning; search reorders by relevance anyway.
  const sorted = useMemo(() => [...LANGUAGES].sort((a, b) => a.label.localeCompare(b.label)), []);

  const pick = (id: string | null) => {
    onPick(id);
    onOpenChange(false);
  };

  const detectedLabel = detectedId ? languageLabel(detectedId) : "Plain Text";

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change Language Mode"
      description="Select the syntax highlighting language for the active editor."
      className="sm:max-w-lg"
    >
      <CommandInput placeholder="Select language mode (search by name or extension)…" />
      <CommandList className="max-h-80">
        <CommandEmpty>No matching language.</CommandEmpty>
        <CommandGroup heading="Detection">
          <CommandItem
            value="auto detect default plain text"
            keywords={["auto", "detect", "default", "automatic"]}
            data-checked={!isOverridden ? "true" : undefined}
            onSelect={() => pick(null)}
          >
            {detectedId ? <LangIcon id={detectedId} /> : <span className="size-4 shrink-0" />}
            <span className="flex-1">Auto Detect</span>
            <span className="text-muted-foreground text-xs">{detectedLabel}</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Languages">
          {sorted.map((def) => {
            const isDefault = def.id === detectedId;
            const isActive = def.id === currentId;
            return (
              <CommandItem
                key={def.id}
                value={def.label}
                keywords={[def.id, ...(def.aliases ?? []), ...(def.extensions ?? [])]}
                data-checked={isActive ? "true" : undefined}
                onSelect={() => pick(def.id)}
              >
                <LangIcon id={def.id} />
                <span className={cn("flex-1", isActive && "font-semibold")}>{def.label}</span>
                {isDefault && (
                  <span className="border-border text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px] leading-none">
                    default
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/**
 * Memoized so the always-mounted (but usually closed) picker doesn't rebuild
 * its ~75-item list every time the editor re-renders on cursor moves. With a
 * stable `onPick` the props stay referentially equal until the file or
 * override changes.
 */
export const LanguagePickerDialog = memo(LanguagePickerDialogImpl);
