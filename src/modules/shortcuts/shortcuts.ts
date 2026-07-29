import { IS_MAC, KEY_SEP, MOD_PROP } from "@/lib/platform";

/** Keyboard shortcut catalog. */

export type ShortcutId =
  | "tab.new"
  | "tab.newPrivate"
  | "tab.newPreview"
  | "tab.newEditor"
  | "tab.newAgent"
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
  | "terminal.close"
  | "pane.splitBrowser"
  | "browser.focusAddressBar"
  | "browser.reload"
  | "browser.back"
  | "browser.forward"
  | "commandPalette.open";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Panes"
  | "Search"
  | "AI"
  | "View"
  | "Editor"
  | "Terminal"
  | "Browser"
  | "Command Palette";

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
    label: "New browser tab",
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
    // Opens the AI-CLI picker, not a tab directly - the dialog decides how many
    // panes and in what layout. N for "new agents": Mod+Shift+N is free, and
    // being Mod+Shift it never shadows a shell control code the way a bare
    // Mod+letter would. Deliberately NOT A or B - those are the GNU screen and
    // tmux prefixes, so muscle memory in a multiplexer session would keep
    // hitting this by mistake even though the bare-Ctrl form still reaches the
    // shell.
    id: "tab.newAgent",
    label: "Run AI agents...",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "n" }],
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
    // Split the active pane to the right with an in-app browser, vs. the
    // terminal that splitRight/splitDown create. Mnemonic: B = Browser.
    // Mod+Shift+B (Ctrl+Shift+B / Cmd+Shift+B) is in the terminal-UI modifier
    // family (like the app's Ctrl+Shift+C/V/X), so it never shadows a shell
    // control code. Works from any focused pane, like the other splits.
    id: "pane.splitBrowser",
    label: "Split with browser",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "b" }],
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
    // VS Code uses Ctrl+P for the fuzzy file picker; we ship Mod+P as an
    // equivalent. Mod+Shift+P is claimed by the Command Palette (VS Code
    // convention). Mod+G is an explicit alternative requested by Indonesian
    // users who already bind Ctrl+G to "open file" in their muscle memory.
    id: "explorer.search",
    label: "Go to file",
    group: "Search",
    defaultBindings: [
      { [MOD_PROP]: true, key: "p" },
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
    // Opens the Command Palette — a searchable list of all commands. VS Code
    // parity: Cmd+Shift+P on macOS, Ctrl+Shift+P on Win/Linux.
    id: "commandPalette.open",
    label: "Command Palette",
    group: "Command Palette",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "p" }],
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
    defaultBindings: IS_MAC ? [{ meta: true, key: "c" }] : [{ ctrl: true, shift: true, key: "c" }],
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
  // Browser-pane actions. All four are gated to a focused browser pane in
  // App's `useGlobalShortcuts` isDisabled, so when a terminal or editor is
  // focused they fall through instead of being captured - the shell keeps
  // Ctrl+Shift+R, Alt+Left/Right, etc. on every OS. The native browser webview
  // floats above the DOM, so these fire from the address bar / pane chrome
  // (when our window, not the page, holds keyboard focus).
  {
    // Edge/Chrome "focus location bar" is Ctrl+L, but that's taken by
    // ai.askSelection; Mod+Shift+L keeps the L (Location) mnemonic, unused.
    id: "browser.focusAddressBar",
    label: "Focus address bar",
    group: "Browser",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "l" }],
  },
  {
    // Matches browsers' hard-reload chord; bare Mod+R is left free so the
    // shell's Ctrl+R reverse-search is never at risk even if gating regresses.
    id: "browser.reload",
    label: "Reload page",
    group: "Browser",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "r" }],
  },
  {
    // Alt+Arrow (the universal browser back/forward), NOT Mod+Shift+Arrow, so
    // editing address-bar text with Shift+Arrow selection still works.
    id: "browser.back",
    label: "Go back",
    group: "Browser",
    defaultBindings: [{ alt: true, key: "ArrowLeft" }],
  },
  {
    id: "browser.forward",
    label: "Go forward",
    group: "Browser",
    defaultBindings: [{ alt: true, key: "ArrowRight" }],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Panes",
  "View",
  "Editor",
  "Terminal",
  "Browser",
  "Search",
  "AI",
  "Command Palette",
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
 * True when `e` is a bare-Ctrl chord (Ctrl held, no Shift/Alt/Meta) whose key
 * produces a C0 control code a shell needs: Ctrl+A..Z -> 0x01-0x1A, Ctrl+[ =
 * Esc (0x1B), Ctrl+\ = FS/SIGQUIT (0x1C), Ctrl+] = GS (0x1D). On Windows/Linux
 * `Mod` is Ctrl, so the catalog's Mod+letter defaults (Ctrl+E, Ctrl+W, Ctrl+K,
 * Ctrl+L, Ctrl+B, …) otherwise steal readline editing keys and the GNU
 * screen / tmux prefix from a focused terminal. App's `useGlobalShortcuts`
 * `isDisabled` returns true for this while a terminal is focused, so the byte
 * falls through to xterm instead of firing an app action. Uses `e.code` so it
 * holds on non-US layouts (Ctrl+Shift+letter app chords keep Shift, so they are
 * excluded here and stay active). No-op on macOS: Mod is Cmd there, so no bare-
 * Ctrl chord matches an app shortcut in the first place.
 */
export function isTerminalControlChord(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  const code = e.code;
  if (code.length === 4 && code.startsWith("Key")) return true; // KeyA..KeyZ
  return code === "BracketLeft" || code === "BracketRight" || code === "Backslash";
}

/**
 * True when `e` is a bare-Alt chord (Alt held, no Ctrl/Shift/Meta) on a
 * letter or digit. xterm sends these to the shell as ESC-prefixed meta
 * sequences that readline uses: M-b / M-f word movement, M-d kill-word,
 * M-. last-arg, M-1..M-9 digit-argument, etc. Like [[isTerminalControlChord]]
 * this is gated on in App's `isDisabled` so a focused terminal owns them
 * instead of an app Alt+letter shortcut (only Alt+Z = word-wrap today, which
 * is an editor action with no meaning in a terminal anyway). Uses `e.code` for
 * layout independence; app chords that add Ctrl/Shift/Meta (Ctrl+Alt+P,
 * Shift+Alt+F) keep those modifiers and are excluded, so they stay active.
 */
export function isTerminalMetaChord(e: KeyboardEvent): boolean {
  if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return false;
  const code = e.code;
  if (code.length === 4 && code.startsWith("Key")) return true; // KeyA..KeyZ
  return code.length === 6 && code.startsWith("Digit"); // Digit0..Digit9
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

  // Compare case-insensitively: defaults store "ArrowLeft" but the recorder
  // stores the canonical lowercase ("arrowleft"), so a rebind to an arrow must
  // still render as a glyph.
  let keyLabel = binding.key;
  const lowerKey = keyLabel.toLowerCase();
  if (lowerKey === " ") keyLabel = "Space";
  else if (lowerKey === "arrowup") keyLabel = "↑";
  else if (lowerKey === "arrowdown") keyLabel = "↓";
  else if (lowerKey === "arrowleft") keyLabel = "←";
  else if (lowerKey === "arrowright") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}

/** Display string for a shortcut's first binding: the user override if set, else
 *  the default, rendered as glyph tokens joined by KEY_SEP. Returns "" when the
 *  id is unknown or has no binding. Shared by the header search hint and the
 *  toolbar tooltip labels. */
export function shortcutHint(
  id: ShortcutId,
  userShortcuts: Record<ShortcutId, KeyBinding[]>,
): string {
  const s = SHORTCUTS.find((s) => s.id === id);
  if (!s) return "";
  const bindings = userShortcuts[id] || s.defaultBindings;
  if (!bindings || bindings.length === 0) return "";
  return getBindingTokens(bindings[0]).join(KEY_SEP);
}
