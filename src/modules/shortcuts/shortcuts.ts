import { IS_MAC, MOD_PROP } from "@/lib/platform";

/**
 * Single source of truth for keyboard shortcuts.
 */

export type ShortcutId =
  | "tab.new"
  | "tab.newPreview"
  | "tab.newEditor"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.selectByIndex"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "search.focus"
  | "explorer.search"
  | "explorer.grep"
  | "ai.toggle"
  | "ai.askSelection"
  | "ai.send"
  | "ai.queueWhileBusy"
  | "ai.newline"
  | "shortcuts.open"
  | "settings.open"
  | "sidebar.toggle"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "editor.toggleWordWrap"
  | "terminal.copy"
  | "terminal.paste"
  | "terminal.close";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Panes"
  | "Search"
  | "AI"
  | "View"
  | "Editor"
  | "Terminal";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
  /** Show in the settings list but disable the recorder + clear/reset
   *  buttons. Used for keys that are hardcoded in a component handler
   *  (e.g. textarea Enter) and only listed here as documentation. */
  readOnly?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: "settings.open",
    label: "Open settings",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "," }],
  },
  {
    id: "shortcuts.open",
    label: "Show keyboard shortcuts",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "k" }],
  },
  {
    id: "tab.new",
    label: "New tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "t" }],
  },
  {
    id: "tab.newPreview",
    label: "New preview tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "p" }],
  },
  {
    id: "tab.newEditor",
    label: "New editor tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "e" }],
  },
  {
    id: "tab.close",
    label: "Close tab or pane",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "w" }],
  },
  {
    // Triggers a horizontal split (new tab beside the focused one).
    id: "pane.splitRight",
    label: "Split pane horizontally",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "d" }],
  },
  {
    // Triggers a vertical split (new tab stacked below the focused one).
    id: "pane.splitDown",
    label: "Split pane vertically",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "d" }],
  },
  {
    id: "pane.focusNext",
    label: "Focus next pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "]" }],
  },
  {
    id: "pane.focusPrev",
    label: "Focus previous pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "[" }],
  },
  {
    id: "tab.next",
    label: "Next tab",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, key: "Tab" }],
  },
  {
    id: "tab.prev",
    label: "Previous tab",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
  },
  {
    id: "tab.selectByIndex",
    label: "Jump to tab 1–9",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "1" }],
  },
  {
    id: "explorer.grep",
    label: "Search in files",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "f" }],
  },
  {
    id: "explorer.search",
    label: "Search files",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "p" }],
  },
  {
    id: "search.focus",
    label: "Find in terminal",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, key: "f" }],
  },
  {
    id: "ai.toggle",
    label: "Toggle AI agent",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "i" }],
  },
  {
    id: "ai.askSelection",
    label: "Ask AI about selection",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "l" }],
  },
  {
    id: "ai.send",
    label: "Send prompt",
    group: "AI",
    defaultBindings: [{ key: "Enter" }],
    readOnly: true,
  },
  {
    id: "ai.queueWhileBusy",
    label: "Queue prompt while AI is busy",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "Enter" }],
    readOnly: true,
  },
  {
    id: "ai.newline",
    label: "New line in prompt",
    group: "AI",
    defaultBindings: [{ shift: true, key: "Enter" }],
    readOnly: true,
  },
  {
    id: "sidebar.toggle",
    label: "Toggle file explorer",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "b" }],
  },
  {
    // `=` is the unshifted "+" on a US layout. Matches VS Code / browser
    // convention so Cmd/Ctrl + "+" (with or without Shift) feels natural.
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "=" },
      { [MOD_PROP]: true, shift: true, key: "=" },
    ],
  },
  {
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "-" }],
  },
  {
    id: "view.zoomReset",
    label: "Reset zoom",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "0" }],
  },
  {
    id: "editor.toggleWordWrap",
    label: "Toggle word wrap",
    group: "Editor",
    defaultBindings: [{ alt: true, key: "z" }],
  },
  {
    // Cross-platform terminal convention: Ctrl+C in the active shell is
    // reserved for SIGINT, so the copy binding moves to Ctrl+Shift+C
    // (matches GNOME Terminal, Konsole, Windows Terminal, VS Code). macOS
    // users who prefer Cmd+C can rebind in Settings → Shortcuts → Terminal.
    id: "terminal.copy",
    label: "Copy selection",
    group: "Terminal",
    defaultBindings: [{ ctrl: true, shift: true, key: "c" }],
  },
  {
    // Paste from system clipboard. Goes through xterm's bracketed-paste
    // path so multi-line snippets aren't executed line-by-line by bash/zsh.
    id: "terminal.paste",
    label: "Paste from clipboard",
    group: "Terminal",
    defaultBindings: [{ ctrl: true, shift: true, key: "v" }],
  },
  {
    // Close the focused terminal pane. No-op when it's the last terminal
    // left in the workspace so the user never lands in an empty UI.
    id: "terminal.close",
    label: "Close focused terminal",
    group: "Terminal",
    defaultBindings: [{ ctrl: true, shift: true, key: "x" }],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Panes",
  "View",
  "Editor",
  "Terminal",
  "Search",
  "AI",
];

/**
 * Layout-independent canonical key form. We prefer `KeyboardEvent.code` for
 * the physical letter/digit positions on the keyboard because `e.key` is
 * derived from the active layout + active modifier, and two real-world
 * cases trip a naive `e.key`-only match:
 *
 *  1. macOS Option-modifier dead chars. With Option held, the layout
 *     emits a composed glyph: `Option+Z` → `key: "Ω"`, `Option+E` → `key:
 *     "´"` (combining acute), and so on. A binding stored as
 *     `{ alt: true, key: "z" }` (which is what the user wanted to record
 *     by pressing Option+Z) would never match because "Ω".toLowerCase()
 *     !== "z".
 *  2. Non-Latin layouts (Cyrillic, Greek, Arabic, Devanagari…). Pressing
 *     the same physical "T" key on a Russian layout fires `key: "т"`.
 *     Default bindings ship Latin letters, so the non-Latin user would
 *     have no working shortcuts at all.
 *
 * `e.code` is identical across layouts and modifier states ("KeyT" /
 * "Digit5" / "BracketLeft"), so for the keys it covers we use it directly.
 * For everything else (punctuation, function keys, navigation, named keys
 * like "Enter"/"Tab"/"Escape") we fall back to `e.key`. That hybrid is
 * what every shortcut-driven app (VS Code, Codemirror, Chrome DevTools)
 * does too.
 */
function canonicalKey(e: KeyboardEvent): string {
  const code = e.code;
  // KeyA..KeyZ → "a".."z"
  if (code.length === 4 && code.startsWith("Key")) {
    return code.slice(3).toLowerCase();
  }
  // Digit0..Digit9 → "0".."9". Note: numpad digits arrive as "Numpad0"
  // etc. — we deliberately don't map those so a user who recorded a
  // top-row digit shortcut isn't unexpectedly triggered by NumLock input.
  if (code.length === 6 && code.startsWith("Digit")) {
    return code.slice(5);
  }
  return e.key.toLowerCase();
}

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
export function matchBinding(e: KeyboardEvent, binding: KeyBinding, id?: ShortcutId): boolean {
  const eventKey = canonicalKey(e);
  const bindingKey = binding.key.toLowerCase();

  // Special case for Jump to Tab 1-9. We match against the canonical key
  // (which uses e.code for digits) so the shortcut still fires on layouts
  // where Shift+digit produces a different glyph or where altKey changes
  // the printable char.
  if (id === "tab.selectByIndex") {
    if (!/^[1-9]$/.test(eventKey)) return false;
  } else if (eventKey !== bindingKey) {
    return false;
  }

  return (
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * Recorder-side counterpart. Stores the canonical form so a binding
 * recorded on a Mac with Option held or on a non-Latin layout still
 * matches when replayed. Used by the settings recorder.
 */
export function canonicalKeyFromEvent(e: KeyboardEvent): string {
  return canonicalKey(e);
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (IS_MAC) {
    if (binding.ctrl) tokens.push("⌃");
    if (binding.alt) tokens.push("⌥");
    if (binding.shift) tokens.push("⇧");
    if (binding.meta) tokens.push("⌘");
  } else {
    if (binding.ctrl) tokens.push("Ctrl");
    if (binding.alt) tokens.push("Alt");
    if (binding.shift) tokens.push("Shift");
    if (binding.meta) tokens.push("Win");
  }

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
