import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { GitBranch } from "../types";
import { Check, ChevronDown, Cloud, GitBranch as GitBranchIcon } from "lucide-react";

/** Labelled form row. Same shape `SshConnectionDialog` uses, so every dialog in
 *  the app stacks its fields identically. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{label}</span>
      {children}
    </div>
  );
}

type ComboboxProps = {
  branches: GitBranch[];
  value: string;
  onChange: (name: string) => void;
  /** Never offered, and never matched: the branch the operation runs FROM. */
  exclude?: string | null;
  placeholder?: string;
  emptyText?: string;
  /** Extra choice pinned to the top, e.g. "None". Its value is the empty string. */
  noneLabel?: string;
  disabled?: boolean;
};

/**
 * Searchable branch picker.
 *
 * Popover + cmdk rather than a Radix menu or a native `<select>`: this is the
 * app's existing combobox (see the jump-host field in `SshConnectionDialog`),
 * a branch list is long enough to need typing, and a native control cannot be
 * themed to match the rest of a dialog.
 *
 * Deliberately NOT `modal`. It reads like the fix for "cmdk items only answer
 * Enter, never a click" inside a Dialog, but it buys that by making the whole
 * page inert - every field behind it freezes and clicking away cannot even
 * close it. `PopoverContent` already overrides the inherited
 * `pointer-events: none` that caused the dead click.
 */
export function BranchCombobox({
  branches,
  value,
  onChange,
  exclude,
  placeholder = "Select a branch",
  emptyText = "No branch found.",
  noneLabel,
  disabled,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  // `role="combobox"` is only half a promise without it: a screen reader needs
  // `aria-controls` to know which list `aria-expanded` just opened.
  const listId = useId();

  /** Locals first, then remote-only entries under their short name, which is
   *  what every git command here takes. A remote already followed by a local
   *  branch is dropped: checking either out lands on the same commit. */
  const options = useMemo(() => {
    const followed = new Set<string | null>();
    for (const b of branches) if (!b.remote) followed.add(b.upstream);
    const locals: GitBranch[] = [];
    const remotes: GitBranch[] = [];
    for (const b of branches) {
      if (b.name === exclude) continue;
      if (!b.remote) locals.push(b);
      else if (!followed.has(b.name)) remotes.push(b);
    }
    return { locals, remotes };
  }, [branches, exclude]);

  const label = value || (noneLabel ?? placeholder);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className="h-8 w-full justify-between px-2.5 text-[12px] font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>{label}</span>
          <ChevronDown size={13} strokeWidth={2} className="ml-2 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={listId}
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Command className="rounded-2xl">
          <CommandInput placeholder="Search branches…" className="text-[12px]" />
          <CommandList className="max-h-56">
            <CommandEmpty className="py-4 text-[11px]">{emptyText}</CommandEmpty>
            {noneLabel ? (
              <CommandGroup>
                <CommandItem
                  value={noneLabel}
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                  className="gap-2 rounded-xl px-2.5 py-1.5 text-[12px]"
                >
                  <Check
                    size={12}
                    strokeWidth={2.5}
                    className={cn("shrink-0", value && "invisible")}
                  />
                  <span className="truncate">{noneLabel}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {options.locals.length > 0 ? (
              <CommandGroup heading="Local">
                {options.locals.map((b) => (
                  <Row
                    key={`l:${b.name}`}
                    name={b.name}
                    value={value}
                    onPick={onChange}
                    close={setOpen}
                  />
                ))}
              </CommandGroup>
            ) : null}
            {options.remotes.length > 0 ? (
              <CommandGroup heading="Remote">
                {options.remotes.map((b) => (
                  <Row
                    key={`r:${b.name}`}
                    name={b.name}
                    value={value}
                    onPick={onChange}
                    close={setOpen}
                    remote
                  />
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Row({
  name,
  value,
  onPick,
  close,
  remote,
}: {
  name: string;
  value: string;
  onPick: (name: string) => void;
  close: (open: boolean) => void;
  remote?: boolean;
}) {
  return (
    <CommandItem
      value={name}
      onSelect={() => {
        onPick(name);
        close(false);
      }}
      className="gap-2 rounded-xl px-2.5 py-1.5 text-[12px]"
    >
      <Check
        size={12}
        strokeWidth={2.5}
        className={cn("shrink-0", value !== name && "invisible")}
      />
      {remote ? (
        <Cloud size={12} strokeWidth={2} className="shrink-0 opacity-70" />
      ) : (
        <GitBranchIcon size={12} strokeWidth={2} className="text-icon-branch shrink-0" />
      )}
      <span className="truncate">{name}</span>
    </CommandItem>
  );
}
