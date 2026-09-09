/**
 * Notes and todos: two short lists the user keeps beside the terminal, opened
 * from the toolbar button next to the SSH menu.
 *
 * ONE store for both, because they are one panel. The tabs switch lists without
 * either half loading separately, the toolbar tooltip counts both, and the
 * shortcut has a single thing to toggle. Splitting them would buy two of
 * everything and no isolation worth having.
 *
 * Main window only, so there is no cross-webview change event here (the SSH
 * connection list needs one because Settings edits it too; nothing else writes
 * these files).
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";

/** A free-text note. `title` is what the collapsed row shows; `body` is the
 *  expanded editor. Both are editable in place. */
export type Note = {
  id: string;
  title: string;
  body: string;
  /** Epoch ms of the last edit to either field. */
  updatedAt: number;
};

/** One checklist line. Kept in insertion order, ticked or not - a done item
 *  that jumps to the bottom moves the row under the pointer that ticked it. */
export type Todo = {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
};

const STORE_PATH = "tedi-notes.json";
const KEY_NOTES = "notes";
const KEY_TODOS = "todos";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Max characters kept for a title or a todo line. Long enough for a sentence,
 *  short enough that a paste of a whole log file cannot become a list row. */
export const LINE_MAX_CHARS = 200;

/** Trim and cap one line of user input. Returns "" when nothing usable is left,
 *  so callers can treat "blank" and "whitespace" the same. */
export function normalizeLine(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, LINE_MAX_CHARS);
}

async function write(notes: Note[], todos: Todo[]): Promise<void> {
  await store.set(KEY_NOTES, notes);
  await store.set(KEY_TODOS, todos);
  await store.save();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Persist both lists, debounced.
 *
 * A note body is edited one keystroke at a time and each one would otherwise
 * rewrite the whole file. `flushNotes` closes the window this opens: the panel
 * calls it on close, so an edit typed and then dismissed is on disk before the
 * app can be.
 *
 * ponytail: whole-file write per change. Fine for two lists a person maintains
 * by hand; only worth diffing if these ever hold thousands of rows.
 */
function persist(notes: Note[], todos: Todo[]): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void write(notes, todos);
  }, 300);
}

/** Write a pending change immediately. No-op when nothing is pending. */
export function flushNotes(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const { notes, todos } = useNotesStore.getState();
  void write(notes, todos);
}

type State = {
  /** Whether the toolbar panel is showing. Lives here so the global shortcut
   *  and the header button toggle the same flag without prop-drilling. */
  open: boolean;
  /** True once the lists have been read off disk. Until then they are empty,
   *  which is also what a first run looks like - hence the flag. */
  loaded: boolean;
  /**
   * Keeps the panel open when the user clicks away, so a checklist survives
   * going back to the terminal to do the thing on it.
   *
   * Session-only, deliberately: pinning is "I am working through this list now",
   * not a lasting preference, and a panel that reopens pinned three days later
   * is covering the pane for a reason nobody remembers.
   */
  pinned: boolean;
  notes: Note[];
  todos: Todo[];
};

type Actions = {
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  togglePinned: () => void;
  /** Read both lists off disk. Idempotent; the panel calls it on mount. */
  load: () => Promise<void>;
  /** Adds an untitled-safe note at the top and returns its id, so the caller
   *  can expand the row it just created. Returns null for blank input. */
  addNote: (title: string) => string | null;
  updateNote: (id: string, patch: Partial<Pick<Note, "title" | "body">>) => void;
  removeNote: (id: string) => void;
  addTodo: (text: string) => void;
  /** Set, not flip. The AI tool completes a todo by id and a toggle there would
   *  reopen one that was already done; the checkbox passes its own next value. */
  setTodoDone: (id: string, done: boolean) => void;
  removeTodo: (id: string) => void;
  clearDoneTodos: () => void;
};

export const useNotesStore = create<State & Actions>((set, get) => {
  /** Apply a change and schedule the write. Every mutation goes through here so
   *  none can update the UI without reaching disk. */
  const commit = (next: Partial<Pick<State, "notes" | "todos">>) => {
    const notes = next.notes ?? get().notes;
    const todos = next.todos ?? get().todos;
    set({ notes, todos });
    persist(notes, todos);
  };

  return {
    open: false,
    loaded: false,
    pinned: false,
    notes: [],
    todos: [],

    // Closing flushes HERE, not in the component's `onOpenChange`: Radix does
    // not fire that when a controlled `open` prop changes underneath it, so the
    // shortcut - which flips this flag directly - would have skipped the write.
    setOpen: (open) => {
      set({ open });
      if (!open) flushNotes();
    },
    toggleOpen: () => {
      const next = !get().open;
      set({ open: next });
      if (!next) flushNotes();
    },

    togglePinned: () => set({ pinned: !get().pinned }),

    load: async () => {
      if (get().loaded) return;
      const [notes, todos] = await Promise.all([
        store.get<Note[]>(KEY_NOTES),
        store.get<Todo[]>(KEY_TODOS),
      ]);
      set({ notes: notes ?? [], todos: todos ?? [], loaded: true });
    },

    addNote: (title) => {
      const clean = normalizeLine(title);
      if (!clean) return null;
      const note: Note = { id: newId("nt"), title: clean, body: "", updatedAt: Date.now() };
      commit({ notes: [note, ...get().notes] });
      return note.id;
    },

    updateNote: (id, patch) => {
      commit({
        notes: get().notes.map((n) =>
          n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n,
        ),
      });
    },

    removeNote: (id) => commit({ notes: get().notes.filter((n) => n.id !== id) }),

    addTodo: (text) => {
      const clean = normalizeLine(text);
      if (!clean) return;
      const todo: Todo = { id: newId("td"), text: clean, done: false, createdAt: Date.now() };
      commit({ todos: [...get().todos, todo] });
    },

    setTodoDone: (id, done) =>
      commit({ todos: get().todos.map((t) => (t.id === id ? { ...t, done } : t)) }),

    removeTodo: (id) => commit({ todos: get().todos.filter((t) => t.id !== id) }),

    clearDoneTodos: () => commit({ todos: get().todos.filter((t) => !t.done) }),
  };
});
