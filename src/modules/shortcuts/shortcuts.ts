import { IS_MAC, MOD_PROP } from "@/lib/platform";

/** Keyboard shortcut catalog. */

export type ShortcutId =
  | "tab.new"
  | "tab.newPrivate"
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
  | "explorer.replaceAll"
  | "editor.findReplace"
  | "ai.toggle"
  | "ai.askSelection"
  | "ai.send"
  | "ai.queueWhileBusy"
  | "ai.newline"
  | "shortcuts.open"
  | "settings.open"
  | "sidebar.toggle"
  | "scm.open"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "editor.toggleWordWrap"
  | "editor.formatDocument"
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
  /** List in settings but disable recorder + reset. For component-hardcoded
   *  keys (e.g. textarea Enter) shown for documentation. */
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
    id: "tab.newPrivate",
    label: "New private terminal tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "t" }],
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
    // Horizontal split: new tab beside the focused one.
    id: "pane.splitRight",
    label: "Split pane horizontally",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "d" }],
  },
  {
    // Vertical split: new tab stacked below the focused one.
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
    id: "explorer.replaceAll",
    label: "Replace in files",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "h" }],
  },
  {
    id: "editor.findReplace",
    label: "Find and replace in editor",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "h" }],
  },
  {
    id: "explorer.search",
    label: "Go to file",
    group: "Search",
    defaultBindings: [
      { [MOD_PROP]: true, shift: true, key: "p" },
      // VS Code uses Ctrl+P for the fuzzy file picker; we ship Ctrl+G as an
      // explicit alternative requested by Indonesian users who already bind
      // Ctrl+G to "open file" in their muscle memory.
      { [MOD_PROP]: true, key: "g" },
    ],
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
    id: "scm.open",
    label: "Open Source Control in a tab",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "g" }],
  },
  {
    // `=` is the unshifted "+" on US layouts. Matches VS Code and browsers,
    // so Cmd/Ctrl + "+" works with or without Shift.
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
    // VSCode parity. Runs the configured formatter (built-in Prettier or
    // user external command) against the active editor and rewrites the
    // buffer. Does not save — pair with Mod+S for format-then-save.
    id: "editor.formatDocument",
    label: "Format document",
    group: "Editor",
    defaultBindings: [{ shift: true, alt: true, key: "f" }],
  },
  {
    // Ctrl+C in a shell is SIGINT, so copy is Ctrl+Shift+C on Linux/Windows.
    // Matches GNOME Terminal, Konsole, Windows Terminal, VS Code. On macOS
    // the convention (Terminal.app, iTerm2) is Cmd+C - Cmd is not a shell
    // signal, so it's safe to bind unconditionally.
    id: "terminal.copy",
    label: "Copy selection",
    group: "Terminal",
    defaultBindings: IS_MAC
      ? [{ meta: true, key: "c" }]
      : [{ ctrl: true, shift: true, key: "c" }],
  },
  {
    // Uses xterm's bracketed-paste so multi-line snippets aren't executed
    // line-by-line. Cmd+V on macOS; Ctrl+Shift+V elsewhere. Shift+Insert is
    // a de-facto universal terminal paste on Linux/Windows - included as a
    // secondary default for muscle memory from other emulators.
    id: "terminal.paste",
    label: "Paste from clipboard",
    group: "Terminal",
    defaultBindings: IS_MAC
      ? [{ meta: true, key: "v" }]
      : [
          { ctrl: true, shift: true, key: "v" },
          { shift: true, key: "Insert" },
        ],
  },
  {
    // Closes the focused terminal pane. No-op for the last terminal.
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
 * Layout-independent key canonicalization. Uses `e.code` for letters/digits
 * because `e.key` varies with layout and modifiers:
 *   - macOS Option produces composed glyphs (`Option+Z` -> "Omega"), so a
 *     binding `{ alt: true, key: "z" }` would never match.
 *   - Non-Latin layouts (Cyrillic, Greek, Arabic) emit non-Latin `key`
 *     values, breaking Latin-letter defaults.
 * `e.code` is stable across layouts (`KeyT`, `Digit5`, `BracketLeft`).
 * For everything else (punctuation, function/navigation/named keys) fall
 * back to `e.key`. Same hybrid VS Code and CodeMirror use.
 */
function canonicalKey(e: KeyboardEvent): string {
  const code = e.code;
  // KeyA..KeyZ -> "a".."z"
  if (code.length === 4 && code.startsWith("Key")) {
    return code.slice(3).toLowerCase();
  }
  // Digit0..Digit9 -> "0".."9". Skip Numpad0..9 so a top-row digit binding
  // doesn't fire from numpad input.
  if (code.length === 6 && code.startsWith("Digit")) {
    return code.slice(5);
  }
  return e.key.toLowerCase();
}

/** Returns true if the KeyboardEvent matches the KeyBinding. */
export function matchBinding(e: KeyboardEvent, binding: KeyBinding, id?: ShortcutId): boolean {
  const eventKey = canonicalKey(e);
  const bindingKey = binding.key.toLowerCase();

  // Jump-to-tab matches via canonical key (e.code for digits) so the shortcut
  // works on layouts where Shift+digit or Alt changes the printable char.
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
 * Recorder counterpart. Returns the canonical key so bindings recorded with
 * Option held or on non-Latin layouts still match on replay.
 */
export function canonicalKeyFromEvent(e: KeyboardEvent): string {
  return canonicalKey(e);
}

/**
 * Parses an extension's `contributes.keybindings[].key` string
 * (e.g. "Mod+Shift+E", "Ctrl+K", "Alt+Shift+ArrowLeft") into a `KeyBinding`.
 * VS Code grammar:
 *   `Mod` is `meta` on macOS, `ctrl` elsewhere (matches `MOD_PROP`).
 *   Modifiers (case-insensitive): ctrl/control, shift, alt/option/opt,
 *   meta/cmd/command/win/super, mod. Separated by `+`. Trailing token is the key.
 *   Single chars are lowercased; named keys pass through.
 * Returns `null` when input is empty or has no key token. Unknown modifiers
 * are skipped silently.
 */
export function parseKeybindingString(input: string): KeyBinding | null {
  if (typeof input !== "string") return null;
  const parts = input
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const binding: KeyBinding = { key: "" };
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    const isLast = i === parts.length - 1;
    const lower = token.toLowerCase();
    if (!isLast) {
      switch (lower) {
        case "ctrl":
        case "control":
          binding.ctrl = true;
          break;
        case "shift":
          binding.shift = true;
          break;
        case "alt":
        case "option":
        case "opt":
          binding.alt = true;
          break;
        case "meta":
        case "cmd":
        case "command":
        case "win":
        case "super":
          binding.meta = true;
          break;
        case "mod":
          // VS Code alias: Cmd on Mac, Ctrl elsewhere. Aligns with `MOD_PROP`.
          binding[MOD_PROP] = true;
          break;
        default:
          // Unknown modifier: drop it so a single typo doesn't kill the binding.
          break;
      }
      continue;
    }
    // Last token is the key. Lowercase single chars so `matchBinding`'s
    // canonical comparison matches regardless of manifest casing.
    binding.key = token.length === 1 ? token.toLowerCase() : token;
  }
  if (!binding.key) return null;
  return binding;
}

/** Display tokens for a binding (platform-specific glyphs on macOS). */
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
