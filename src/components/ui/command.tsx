import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { Check, Search } from "lucide-react";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-4xl p-1",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run",
  children,
  className,
  showCloseButton = false,
  onCloseAutoFocus,
  shouldFilter,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  /** Forwarded to cmdk. Pass `false` when the list is already ranked by
   *  something else (a server-side fuzzy search) - cmdk would otherwise filter
   *  those results a second time against the raw query and hide them. */
  shouldFilter?: boolean;
  /** Forwarded to DialogContent. Radix restores focus on close (after the exit
   *  animation); a consumer can preventDefault here to keep focus it moved. */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn("top-1/3 translate-y-0 overflow-hidden rounded-4xl! p-0", className)}
        showCloseButton={showCloseButton}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {/* cmdk's Input/List/Item read their state from this root store via
            context; without it they hit `store.subscribe` on `undefined` and
            throw "Cannot read properties of undefined (reading 'subscribe')". */}
        <Command className="rounded-none bg-transparent" shouldFilter={shouldFilter}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="bg-input/50 h-9">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <Search strokeWidth={2} className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  onWheel,
  scrollbar,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & {
  /**
   * Show the app's scrollbar instead of hiding it.
   *
   * Hidden by default because a command PALETTE is a short, keyboard-driven
   * menu where a bar is clutter. A long picker is the other case: a branch list
   * forty deep with no bar looks like it ends at the tenth entry, and nothing
   * tells you it can move. Opt-in rather than opt-out so the palettes keep the
   * look they were designed with.
   */
  scrollbar?: boolean;
}) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      // WITHOUT THIS, a command list inside a Popover inside a modal Dialog
      // cannot be wheel-scrolled at all - the keyboard still works, so it reads
      // as "the dropdown is stuck". `react-remove-scroll`, which the Dialog uses
      // to lock the page, listens for `wheel` on DOCUMENT and calls
      // `preventDefault()` on every event that is neither inside the dialog's
      // own subtree nor one of its `shards`. A `PopoverContent` is portaled to
      // `body`, so it is neither, and Radix's Dialog does not expose `shards` to
      // add it. Stopping the event here keeps it from ever reaching that
      // listener, and the browser then scrolls this list natively.
      //
      // Not `preventDefault`: the default IS the scrolling we want. And not
      // chaining the wheel past a scroll container is the right behaviour
      // anyway, which is why this is safe for every other list too.
      onWheel={(e) => {
        e.stopPropagation();
        onWheel?.(e);
      }}
      className={cn(
        "max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        // Not a `cn` override: `no-scrollbar` is a plain CSS class, so
        // tailwind-merge cannot drop it for a caller. It has to not be added.
        !scrollbar && "no-scrollbar",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground **:[[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1.5 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-muted-foreground/20 my-1.5 h-px", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item data-selected:bg-accent data-selected:text-accent-foreground data-selected:*:[svg]:text-accent-foreground relative flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium outline-hidden select-none in-data-[slot=dialog-content]:rounded-3xl data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <Check
        strokeWidth={2}
        className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100"
      />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "text-muted-foreground group-data-selected/command-item:text-accent-foreground ml-auto text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
