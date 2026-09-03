import { IS_MAC, KEY_SEP, MOD_PROP } from "@/lib/platform";

/** Keyboard shortcut catalog. */

export type ShortcutId =
  | "tab.new"
  | "tab.newPrivate"
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
  | "rightPanel.toggle"
  | "scm.open"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.cycleWorkspaceView"
  | "editor.toggleWordWrap"
  | "editor.formatDocument"
  | "editor.toggleComment"
  | "terminal.copy"
  | "terminal.paste"
  | "terminal.close"
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
    // The right column (AI panel, docked sections, extension panels). VS Code
    // parity for its secondary side bar: Mod+Alt+B, beside the sidebar’s Mod+B.
    id: "rightPanel.toggle",
    label: "Toggle right panel",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "b" }],
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
    // The workspace view is a one-click toggle in the toolbar, but it is the
    // only major surface with no command - so it could not be reached from the
    // palette or rebound, unlike the sidebar, the right slot and the splits.
    // One cycling command rather than three jumps: `m` for mode is free, and
    // three chords for a three-state toggle is three chords spent.
    id: "view.cycleWorkspaceView",
    label: "Cycle workspace view (tabs / kanban / canvas)",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "m" }],
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
    // CodeMirror's own `defaultKeymap` binds this, so it is documentation, not
    // a command we dispatch - listing it is what puts it in Settings >
    // Shortcuts. `readOnly` matters for more than the label: an entry with no
    // handler makes `useGlobalShortcuts` bail BEFORE `preventDefault`, so the
    // keystroke still reaches the editor. The comment syntax comes from the
    // language itself, see `COMMENT_TOKENS` in editor/lib/languages.ts.
    id: "editor.toggleComment",
    label: "Toggle comment",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "/" }],
    readOnly: true,
  },
  {
    // Ctrl+C in a shell is SIGINT, so the primary copy chord is Ctrl+Shift+C on
    // Linux/Windows - GNOME Terminal, Konsole, Windows Terminal, VS Code. Bare
    // Ctrl+C is a SECOND binding for Termius / Windows Terminal muscle memory:
    // App's `isDisabled` lets it through only when the focused terminal has a
    // selection, and the handler then clears that selection, so pressing Ctrl+C
    // again falls through to the shell as SIGINT. On macOS the convention
    // (Terminal.app, iTerm2) is Cmd+C - Cmd is not a shell signal, so it's safe
    // to bind unconditionally.
    id: "terminal.copy",
    label: "Copy selection",
    group: "Terminal",
    defaultBindings: IS_MAC
      ? [{ meta: true, key: "c" }]
      : [
          { ctrl: true, shift: true, key: "c" },
          { ctrl: true, key: "c" },
        ],
  },
  {
    // Uses xterm's bracketed-paste so multi-line snippets aren't executed
    // line-by-line. Cmd+V on macOS; Ctrl+Shift+V elsewhere, with bare Ctrl+V and
    // Shift+Insert as secondary defaults. Ctrl+V is what Termius and Windows
    // Terminal bind, and it is the chord people actually reach for when pasting
    // something from the PC into an SSH session (a Claude Code login code, an
    // API key, a long command). Without it xterm maps Ctrl+V to ^V and the PC
    // clipboard simply never reaches the remote shell.
    //
    // Cost: the shell no longer receives ^V (readline quoted-insert, nano's
    // page-down). Clear or rebind this in Settings > Shortcuts to get it back.
    id: "terminal.paste",
    label: "Paste from clipboard",
    group: "Terminal",
    defaultBindings: IS_MAC
      ? [{ meta: true, key: "v" }]
      : [
          { ctrl: true, shift: true, key: "v" },
          { ctrl: true, key: "v" },
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
 * Bare-Ctrl chords `@replit/codemirror-vim` binds, so a focused vim editor can
 * own them the way a focused terminal owns its control codes.
 *
 * On Windows/Linux `Mod` is Ctrl, so the catalog claimed nine of these
 * (Ctrl+B page-up, Ctrl+D half-page, Ctrl+E scroll, Ctrl+F page-down, Ctrl+I
 * jump-forward, Ctrl+P, Ctrl+T, Ctrl+W, Ctrl+[ Escape) and vim never saw the
 * key. Ctrl+C / Ctrl+V already fell through via the copy/paste branch of App's
 * `isDisabled`; they are listed anyway so this set is the vim keymap, not a
 * subset that happens to be enough today.
 *
 * The list is exactly what the package binds - checked against its
 * `defaultKeymap`, NOT vim's full manual - so a chord vim does not define
 * (Ctrl+K, Ctrl+G, Ctrl+H, Ctrl+comma) keeps its app action instead of going
 * silently dead in an editor. macOS is unaffected: Mod is Cmd there.
 */
const VIM_CONTROL_CODES: ReadonlySet<string> = new Set([
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyI",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "BracketLeft",
]);

/** True when `e` is a bare-Ctrl chord the vim keymap defines. See
 *  [[VIM_CONTROL_CODES]]; gated on a focused vim editor in App's `isDisabled`. */
export function isVimControlChord(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  return VIM_CONTROL_CODES.has(e.code);
}

/**
 * The core shortcut that claims this chord, or null.
 *
 * Reserved even when the entry is `readOnly`: those document a key CodeMirror
 * or the AI composer owns (Mod+/ toggle-comment, Enter send), so an extension
 * taking one still breaks that surface. Used by `useExtensionShortcuts` to make
 * core win a shared chord deterministically - both dispatchers are capture-phase
 * `window` listeners, so the winner used to be decided by registration order,
 * and `useGlobalShortcuts` re-registers on every rebind (flipping it).
 */
export function coreShortcutFor(
  e: KeyboardEvent,
  userShortcuts: Partial<Record<ShortcutId, KeyBinding[]>>,
): ShortcutId | null {
  for (const s of SHORTCUTS) {
    const bindings = userShortcuts[s.id] || s.defaultBindings;
    if (bindings.some((b) => matchBinding(e, b, s.id))) return s.id;
  }
  return null;
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
