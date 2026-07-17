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
import { KEY_SEP } from "@/lib/platform";
import { Search, X } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDispatch: (id: ShortcutId) => void;
};

function CommandPaletteImpl({ open, onOpenChange, onDispatch }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
      onDispatch(id);
      onOpenChange(false);
    },
    [onDispatch, onOpenChange],
  );

  const items = useMemo(() => {
    const groups = new Map<string, Shortcut[]>();
    for (const s of SHORTCUTS) {
      const g = groups.get(s.group) ?? [];
      g.push(s);
      groups.set(s.group, g);
    }
    return groups;
  }, []);

  const bindingString = useCallback(
    (s: Shortcut): string => {
      const bindings = userShortcuts[s.id] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      return getBindingTokens(bindings[0]).join(KEY_SEP);
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
              const hint = bindingString(s);
              return (
                <CommandItem
                  key={s.id}
                  value={`${s.id} ${s.label}`}
                  keywords={[s.label, s.id, group]}
                  onSelect={() => select(s.id)}
                >
                  <span className="flex-1">{s.label}</span>
                  {hint ? (
                    <span className="text-muted-foreground/70 ml-auto text-xs tracking-widest">
                      {hint}
                    </span>
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
