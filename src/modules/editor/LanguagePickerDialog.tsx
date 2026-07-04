import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { fileIconUrl, useExplorerIconsReady } from "@/modules/explorer/lib/iconResolver";
import { LANGUAGES, languageIconFile, languageLabel } from "./lib/languages";
import { Search, X } from "lucide-react";

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
 * The search is controlled so it can be cleared with the inline button, and the
 * list keeps its native (themed) scrollbar instead of cmdk's hidden one.
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

  // Controlled search so the inline "clear" button can reset it. Reset on close
  // so reopening the (always-mounted) picker starts from a clean slate.
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    // Radix focuses the first tabbable element (the header close button) on
    // open; pull focus to the search field so the user can type immediately.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

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
      showCloseButton={false}
    >
      {/* Header: title + explicit close button. The dialog's own corner X is
          disabled (showCloseButton={false}) so it can't collide with the
          search field's leading magnifier. */}
      <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5">
        <span className="text-muted-foreground px-1 text-[11px] font-medium tracking-tight">
          Change Language Mode
        </span>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Search with a leading magnifier and a trailing clear button. */}
      <div className="p-1 pb-0">
        <InputGroup className="bg-input/50 h-9">
          <InputGroupAddon align="inline-start">
            <Search strokeWidth={2} className="size-4 shrink-0 opacity-50" />
          </InputGroupAddon>
          <CommandPrimitive.Input
            ref={inputRef}
            data-slot="command-input"
            value={query}
            onValueChange={setQuery}
            placeholder="Select language mode (search by name or extension)…"
            className="placeholder:text-muted-foreground w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>

      {/* Native list (no `no-scrollbar`) so the themed scrollbar shows for
          navigating the ~75-item list. */}
      <CommandPrimitive.List
        data-slot="command-list"
        className="max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none"
      >
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
      </CommandPrimitive.List>
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
