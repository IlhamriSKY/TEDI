/**
 * Toolbar button + panel for the notes and todo lists, sitting immediately
 * right of the SSH menu.
 *
 * Icon-only, like every other button in that cluster: the counts and the
 * shortcut chip live in the tooltip, so the row stays a line of glyphs rather
 * than a mix of pills. No unread-style badge - `border-radius` is force-zeroed
 * app-wide, so the usual 6px dot lands as a blue SQUARE stuck to the glyph.
 *
 * Open state lives in the store, not here, so `notes.toggle` (and the Command
 * Palette entry it registers) can flip the same flag the button does.
 */
import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ListTodo,
  NotepadText,
  Pin,
  PinOff,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DESTRUCTIVE_ACTION, TOOLBAR_EXPANDED, TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { shortcutHint } from "@/modules/shortcuts/shortcuts";

import { LINE_MAX_CHARS, useNotesStore, type Note } from "./store";

export function NotesMenu() {
  const open = useNotesStore((s) => s.open);
  const setOpen = useNotesStore((s) => s.setOpen);
  const load = useNotesStore((s) => s.load);
  const notes = useNotesStore((s) => s.notes);
  const todos = useNotesStore((s) => s.todos);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  const pinned = useNotesStore((s) => s.pinned);
  const togglePinned = useNotesStore((s) => s.togglePinned);
  const removeNote = useNotesStore((s) => s.removeNote);

  const [tab, setTab] = useState("todos");
  /** The note awaiting a delete confirmation, or null.
   *
   *  Lives HERE rather than in `NotesTab` because the AlertDialog has to render
   *  as a sibling of the Popover, the way `SshMenu` does it: the dialog is
   *  modal and takes focus, which dismisses the popover, and a dialog rendered
   *  inside that popover would unmount with it mid-open. */
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);

  /** Delete a note, asking first only when there is something to lose. An empty
   *  note is one line of text the user can retype; a body is not. */
  const askDeleteNote = (note: Note) => {
    if (!note.body.trim()) {
      removeNote(note.id);
      return;
    }
    setConfirmDelete(note);
    setOpen(false);
  };

  useEffect(() => {
    void load();
  }, [load]);

  const openCount = todos.filter((t) => !t.done).length;
  const hint = shortcutHint("notes.toggle", userShortcuts);

  // Spelled out rather than "3 / 2": this is the only place the two counts are
  // named, and a bare pair of numbers beside a notepad glyph says nothing about
  // which is which.
  const summary =
    todos.length === 0 && notes.length === 0
      ? "nothing saved yet"
      : `${openCount} open ${openCount === 1 ? "todo" : "todos"}, ${notes.length} ${
          notes.length === 1 ? "note" : "notes"
        }`;

  const tooltip = (
    <span className="inline-flex items-center gap-1.5">
      <span>Notes &amp; todos ({summary})</span>
      {hint ? <Kbd className="h-4 min-w-4 px-1">{hint}</Kbd> : null}
    </span>
  );

  // `setOpen` is the only close path the store knows about, and it is what
  // flushes a pending edit - see the store.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label={tooltip}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "text-muted-foreground",
              TOOLBAR_HOVER,
              TOOLBAR_EXPANDED,
              "size-7 shrink-0 rounded-md",
            )}
            aria-label="Notes and todos"
          >
            <NotepadText size={15} strokeWidth={1.75} />
          </Button>
        </PopoverTrigger>
      </IconTooltip>

      <PopoverContent
        align="end"
        sideOffset={6}
        // Radix parks focus on the content box, which leaves the panel open with
        // nothing to type into. Adding is the whole point of opening it, so the
        // add field takes focus instead (it carries `autoFocus`, and this is
        // what stops Radix taking it straight back).
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Pinned, an outside click does not dismiss - that is the whole point:
        // ticking a checklist means going back to the terminal between items.
        // Escape and the toolbar button still close it, so it is never stuck.
        onInteractOutside={(e) => {
          if (pinned) e.preventDefault();
        }}
        // `gap-0` / `p-0`: the sections carry their own dividers and padding, and
        // the popover base ships `gap-4 p-4`, which would put a 1rem hole under
        // every border. Height is capped by what is actually below the toolbar,
        // so the list scrolls instead of the footer being clipped.
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-84 flex-col gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
        >
          {/* The Settings window's tab recipe, class for class: a `bg-muted/40`
              track at h-7, h-6 triggers at 11.5px with a 12px glyph. Small
              enough that the active pill reads as a segmented control rather
              than the accent slab a full-width h-9 row turned it into. */}
          <div className="border-border/60 flex shrink-0 border-b p-1.5">
            <TabsList className="bg-muted/40 h-7 min-w-0 flex-1 px-1">
              <TabsTrigger value="todos" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                <ListTodo size={12} strokeWidth={1.75} />
                <span>Todos</span>
                {todos.length > 0 ? (
                  <span className="tabular-nums opacity-60">{openCount}</span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="notes" className="h-6 flex-1 gap-1.5 px-2.5 text-[11.5px]">
                <StickyNote size={12} strokeWidth={1.75} />
                <span>Notes</span>
                {notes.length > 0 ? (
                  <span className="tabular-nums opacity-60">{notes.length}</span>
                ) : null}
              </TabsTrigger>
            </TabsList>
            <IconTooltip label={pinned ? "Unpin panel" : "Keep panel open"} side="bottom">
              <button
                type="button"
                onClick={togglePinned}
                aria-label={pinned ? "Unpin panel" : "Keep panel open"}
                aria-pressed={pinned}
                className={cn(
                  "ml-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                  pinned
                    ? "text-primary hover:bg-primary/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
                )}
              >
                {pinned ? (
                  <Pin size={13} strokeWidth={1.75} />
                ) : (
                  <PinOff size={13} strokeWidth={1.75} />
                )}
              </button>
            </IconTooltip>
          </div>

          <TabsContent value="todos" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TodosTab />
          </TabsContent>
          <TabsContent value="notes" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <NotesTab onAskDelete={askDeleteNote} />
          </TabsContent>
        </Tabs>
      </PopoverContent>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete
                ? `"${confirmDelete.title}" and everything written in it will be gone. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target) removeNote(target.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Popover>
  );
}

/** The add row both tabs wear: one field, one `+`, Enter submits. A real
 *  `<form>` so Enter is the browser's job rather than a keydown handler. */
function AddRow({
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  placeholder: string;
  label: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="border-border/60 flex shrink-0 items-center gap-1.5 border-b p-1.5"
    >
      {/* `md:` too: the primitive bumps itself to 14px above 768px, which is
          every real window, and 14px in a 28px row beside 12px list text reads
          as a different panel. */}
      <Input
        className="h-7 text-[12px] md:text-[12px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        maxLength={LINE_MAX_CHARS}
        // Fires on open AND on a tab switch, since the inactive TabsContent is
        // unmounted: either way the caret lands where the next thing gets typed.
        autoFocus
      />
      <IconTooltip label={label} side="top">
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          disabled={value.trim().length === 0}
          className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-7 shrink-0 rounded-md")}
          aria-label={label}
        >
          <Plus size={14} strokeWidth={1.75} />
        </Button>
      </IconTooltip>
    </form>
  );
}

function EmptyList({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-3 py-8 text-center text-[11px]">{children}</p>;
}

/** Delete button for one row. Revealed on hover or keyboard focus, red once it
 *  is - the same pair `ChipsRow` and `QueueRow` use for a per-row remove. */
function RowDelete({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <IconTooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
          DESTRUCTIVE_ACTION,
        )}
      >
        <Trash2 size={12} strokeWidth={1.75} />
      </button>
    </IconTooltip>
  );
}

function TodosTab() {
  const todos = useNotesStore((s) => s.todos);
  const addTodo = useNotesStore((s) => s.addTodo);
  const setTodoDone = useNotesStore((s) => s.setTodoDone);
  const removeTodo = useNotesStore((s) => s.removeTodo);
  const clearDone = useNotesStore((s) => s.clearDoneTodos);
  const [draft, setDraft] = useState("");

  const doneCount = todos.filter((t) => t.done).length;

  return (
    <>
      <AddRow
        value={draft}
        onChange={setDraft}
        onSubmit={() => {
          addTodo(draft);
          setDraft("");
        }}
        placeholder="Add a todo, then press Enter"
        label="Add todo"
      />

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
        {todos.length === 0 ? (
          <EmptyList>No todos yet.</EmptyList>
        ) : (
          todos.map((t) => (
            <div
              key={t.id}
              className="group hover:bg-accent/40 flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
            >
              <Checkbox
                checked={t.done}
                onCheckedChange={(v) => setTodoDone(t.id, v === true)}
                aria-label={t.done ? `Reopen ${t.text}` : `Complete ${t.text}`}
                className="mt-0.5"
              />
              {/* The label, not just the box, toggles: a 14px target is the
                  smallest thing in the panel and the text is the whole row.
                  Out of the tab order, though - it is the checkbox's action, and
                  a second stop that announces nothing new is just a stop. */}
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setTodoDone(t.id, !t.done)}
                className={cn(
                  "min-w-0 flex-1 cursor-pointer text-left text-[12px] leading-snug break-words",
                  t.done && "text-muted-foreground line-through",
                )}
              >
                {t.text}
              </button>
              <RowDelete label={`Delete ${t.text}`} onClick={() => removeTodo(t.id)} />
            </div>
          ))
        )}
      </div>

      {doneCount > 0 ? (
        <div className="border-border/60 text-muted-foreground flex shrink-0 items-center justify-between gap-2 border-t px-2.5 py-1.5 text-[11px]">
          <span className="tabular-nums">
            {todos.length - doneCount} open, {doneCount} done
          </span>
          <button
            type="button"
            onClick={clearDone}
            className="hover:text-foreground cursor-pointer underline-offset-2 hover:underline"
          >
            Clear completed
          </button>
        </div>
      ) : null}
    </>
  );
}

function NotesTab({ onAskDelete }: { onAskDelete: (note: Note) => void }) {
  const notes = useNotesStore((s) => s.notes);
  const addNote = useNotesStore((s) => s.addNote);
  const updateNote = useNotesStore((s) => s.updateNote);
  const [draft, setDraft] = useState("");
  /** The note being edited, or null for the list. Master/detail rather than an
   *  accordion: a body expanded INSIDE the list put a filled title field and a
   *  filled textarea between two bare text rows, so the list stopped reading as
   *  a list. One screen shows rows, the other shows one note using the whole
   *  panel - which is also the only way a note gets room to be written in. */
  const [openId, setOpenId] = useState<string | null>(null);

  const editing = openId === null ? null : (notes.find((n) => n.id === openId) ?? null);

  if (editing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Back and delete get a strip of their own. Sharing the row with the
            title squeezed that field in by a button's width on each side, so it
            sat as a narrower grey box stacked on the wider grey box of the
            textarea - two fields, two widths, nothing lining up. Here both are
            full width under one padding. */}
        <div className="border-border/60 flex shrink-0 items-center justify-between border-b px-1 py-1">
          <button
            type="button"
            onClick={() => setOpenId(null)}
            className="text-muted-foreground hover:text-foreground hover:bg-accent/40 flex h-6 cursor-pointer items-center gap-1 rounded-md pr-2 pl-1 text-[11.5px] transition-colors"
          >
            <ChevronLeft size={12} strokeWidth={1.75} />
            All notes
          </button>
          <IconTooltip label={`Delete ${editing.title}`} side="top">
            <button
              type="button"
              onClick={() => {
                setOpenId(null);
                onAskDelete(editing);
              }}
              aria-label={`Delete ${editing.title}`}
              className={cn(
                "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                DESTRUCTIVE_ACTION,
              )}
            >
              <Trash2 size={12} strokeWidth={1.75} />
            </button>
          </IconTooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5">
          <Input
            className="h-7 shrink-0 text-[12px] md:text-[12px]"
            value={editing.title}
            onChange={(e) => updateNote(editing.id, { title: e.target.value })}
            placeholder="Untitled"
            aria-label="Note title"
            maxLength={LINE_MAX_CHARS}
            autoFocus
          />
          {/* `field-sizing-fixed` undoes the primitive's grow-with-content
              sizing, which would otherwise ignore the height and leave a
              four-line box scrolling inside a half-empty panel. */}
          <Textarea
            className="field-sizing-fixed h-full min-h-56 flex-1 py-2 text-[12px] md:text-[12px]"
            value={editing.body}
            onChange={(e) => updateNote(editing.id, { body: e.target.value })}
            placeholder="Write it down"
            aria-label={`Body of ${editing.title}`}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <AddRow
        value={draft}
        onChange={setDraft}
        onSubmit={() => {
          const id = addNote(draft);
          setDraft("");
          // Straight into the body of what was just created - the title was the
          // only thing the add row could ask for.
          if (id) setOpenId(id);
        }}
        placeholder="New note title, then press Enter"
        label="Add note"
      />

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
        {notes.length === 0 ? (
          <EmptyList>No notes yet.</EmptyList>
        ) : (
          notes.map((n) => (
            // Same row rhythm as a todo: one padding, one hover wash, the
            // delete in the same column. The two tabs are one list, twice.
            <div
              key={n.id}
              className="group hover:bg-accent/40 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors"
            >
              <button
                type="button"
                onClick={() => setOpenId(n.id)}
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
              >
                <span className="w-full truncate text-[12px] leading-snug">{n.title}</span>
                {n.body ? (
                  <span className="text-muted-foreground w-full truncate text-[10.5px] leading-snug">
                    {n.body}
                  </span>
                ) : null}
              </button>
              <ChevronRight
                size={12}
                strokeWidth={2}
                className="text-muted-foreground/50 shrink-0"
                aria-hidden
              />
              <RowDelete label={`Delete ${n.title}`} onClick={() => onAskDelete(n)} />
            </div>
          ))
        )}
      </div>
    </>
  );
}
