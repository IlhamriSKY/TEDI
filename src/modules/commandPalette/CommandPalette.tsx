import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  SHORTCUTS,
  type Shortcut,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import { runCommand } from "@/modules/shortcuts";
import { Kbd } from "@/components/ui/kbd";
import { KEY_SEP } from "@/lib/platform";
import { Search, X } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function CommandPaletteImpl({ open, onOpenChange }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // The command to run once the dialog has closed, run from onCloseAutoFocus so
  // it lands after Radix's focus restore instead of racing it.
  const pendingId = useRef<ShortcutId | null>(null);

  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const select = useCallback(
    (id: ShortcutId) => {
      // Stash the command and close; it runs from onCloseAutoFocus below.
      pendingId.current = id;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  // Radix restores focus when the close animation ends. Run the command here, at
  // that moment: if the command moves focus to its own target (Go to file,
  // Search in files, Find and replace, address bar, …), preventDefault so that
  // focus sticks; otherwise let Radix restore focus to where it was.
  const runPending = useCallback((e: Event) => {
    const id = pendingId.current;
    if (!id) return;
    pendingId.current = null;
    const before = document.activeElement;
    runCommand(id);
    if (document.activeElement !== before) e.preventDefault();
  }, []);

  const items = useMemo(() => {
    const groups = new Map<string, Shortcut[]>();
    for (const s of SHORTCUTS) {
      // Skip commands that can't be run from a list: readOnly ones are
      // documentation-only key hints (e.g. Enter to send) with no handler;
      // tab.selectByIndex needs a specific digit; commandPalette.open is this
      // palette itself.
      if (s.readOnly || s.id === "tab.selectByIndex" || s.id === "commandPalette.open") {
        continue;
      }
      const g = groups.get(s.group) ?? [];
      g.push(s);
      groups.set(s.group, g);
    }
    return groups;
  }, []);

  const bindingTokens = useCallback(
    (s: Shortcut): string[] => {
      const bindings = userShortcuts[s.id] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return [];
      return getBindingTokens(bindings[0]);
    },
    [userShortcuts],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command Palette"
      description="Search for a command to run..."
      className="sm:max-w-lg"
      showCloseButton={false}
      onCloseAutoFocus={runPending}
    >
      <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5">
        <span className="text-muted-foreground px-1 text-[11px] font-medium tracking-tight">
          Command Palette
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
            placeholder="Type a command to run…"
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

      <CommandPrimitive.List
        data-slot="command-list"
        className="max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none"
      >
        <CommandEmpty>No matching command.</CommandEmpty>
        {[...items.entries()].map(([group, shortcuts]) => (
          <CommandGroup key={group} heading={group}>
            {shortcuts.map((s) => {
              const tokens = bindingTokens(s);
              return (
                <CommandItem
                  key={s.id}
                  value={`${s.id} ${s.label}`}
                  keywords={[s.label, s.id, group]}
                  onSelect={() => select(s.id)}
                >
                  <span className="flex-1">{s.label}</span>
                  {tokens.length > 0 ? (
                    <Kbd className="ml-auto">{tokens.join(KEY_SEP)}</Kbd>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandPrimitive.List>
    </CommandDialog>
  );
}

export const CommandPalette = memo(CommandPaletteImpl);
