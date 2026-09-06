/**
 * Shortcut-collision audit across all four layers that can claim a keystroke:
 * the core catalog, an installed extension, a focused terminal (local or SSH),
 * and vim mode in the editor. Checked for the Windows/Linux expansion (Mod =
 * Ctrl, the case where app chords can shadow shell control codes):
 *
 *   A. No two DIFFERENT catalog actions share the same chord (intra-app clash).
 *   B. In a focused terminal (local PTY and SSH are the same "terminal" leaf),
 *      every shell control code reaches xterm instead of firing an app action:
 *      bare Ctrl+letter / Ctrl+[ / Ctrl+] / Ctrl+\ (via isTerminalControlChord),
 *      plus Enter / Ctrl+Enter / Shift+Enter (no global handler -> fall through).
 *   C. No extension binds a chord core already owns, or one another extension
 *      binds. Core wins a shared chord (`coreShortcutFor`), so a collision here
 *      is a shortcut that silently does nothing.
 *   D. Every Ctrl chord the vim keymap defines AND core also binds falls through
 *      to a focused vim editor (`isVimControlChord`), plus a drift guard against
 *      the installed `@replit/codemirror-vim`.
 *
 * Run: `npx tsx scripts/ui/keybindings-collision-verify.ts`.
 *
 * Under node, platform() throws so MOD_PROP resolves to "ctrl" (see platform.ts),
 * i.e. this checks exactly the Windows/Linux bindings. macOS is safer by
 * construction: Mod = Cmd (meta), so no bare-Ctrl chord is ever an app shortcut.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHORTCUTS,
  isTerminalControlChord,
  isTerminalMetaChord,
  isVimControlChord,
  parseKeybindingString,
  type KeyBinding,
} from "../../src/modules/shortcuts/shortcuts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Actions with a global handler in src/app/lib/shortcutHandlers.ts. The
// readOnly Enter-family (ai.send / ai.queueWhileBusy / ai.newline) is NOT here:
// it is documentation-only and handled locally in the AI input, so those chords
// fall through globally (that is how Enter reaches the shell in a terminal).
const HANDLED = new Set<string>([
  "commandPalette.open",
  "tab.new",
  "tab.newPrivate",
  "tab.newEditor",
  "tab.newAgent",
  "tab.close",
  "tab.next",
  "tab.prev",
  "tab.selectByIndex",
  "pane.splitRight",
  "pane.splitDown",
  "pane.focusNext",
  "pane.focusPrev",
  "search.focus",
  "editor.findReplace",
  "ai.toggle",
  "ai.askSelection",
  "scm.open",
  "shortcuts.open",
  "settings.open",
  "sidebar.toggle",
  "rightPanel.toggle",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomReset",
  "editor.toggleWordWrap",
  "editor.formatDocument",
  "editor.saveAs",
  "terminal.copy",
  "terminal.paste",
  "terminal.close",
]);

function canon(b: KeyBinding): string {
  const mods = [b.ctrl && "Ctrl", b.shift && "Shift", b.alt && "Alt", b.meta && "Meta"]
    .filter(Boolean)
    .join("+");
  return (mods ? mods + "+" : "") + b.key.toLowerCase();
}

// Map a binding's key to a KeyboardEvent.code so isTerminalControlChord (which
// reads e.code) sees what the browser would emit.
function keyToCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return "Digit" + key;
  if (key === "[") return "BracketLeft";
  if (key === "]") return "BracketRight";
  if (key === "\\") return "Backslash";
  return key; // Tab, Enter, Escape, ArrowLeft, ... (not control-code producers)
}

function toEvent(b: KeyBinding): KeyboardEvent {
  return {
    ctrlKey: !!b.ctrl,
    shiftKey: !!b.shift,
    altKey: !!b.alt,
    metaKey: !!b.meta,
    code: keyToCode(b.key),
    key: b.key,
  } as KeyboardEvent;
}

let failed = 0;

// --- A. Intra-app duplicate chords ---------------------------------------
console.log("[A] intra-app duplicate chords (same key -> two actions; first in array wins)");
const byChord = new Map<string, string[]>();
for (const s of SHORTCUTS) {
  const bindings = s.defaultBindings;
  for (const b of bindings) {
    const c = canon(b);
    const arr = byChord.get(c) ?? [];
    arr.push(s.id);
    byChord.set(c, arr);
  }
}
let dupes = 0;
for (const [chord, ids] of byChord) {
  const distinct = [...new Set(ids)];
  if (distinct.length > 1) {
    console.error(`  CLASH: ${chord} -> ${distinct.join(", ")}`);
    dupes++;
    failed++;
  }
}
if (dupes === 0) console.log("  ok: no chord is bound to two different actions");

// --- B. Terminal focus: every shell control code must fall through ---------
console.log("\n[B] terminal focus: shell control codes must reach xterm, not fire an app action");
// Which action (if any) fires for a chord when a terminal is focused. Mirrors
// useGlobalShortcuts (first match in array order wins) + App's isDisabled gate.
function terminalAction(ev: KeyboardEvent): string | null {
  for (const s of SHORTCUTS) {
    const match = s.defaultBindings.some(
      (b) =>
        !!ev.ctrlKey === !!b.ctrl &&
        !!ev.shiftKey === !!b.shift &&
        !!ev.altKey === !!b.alt &&
        !!ev.metaKey === !!b.meta &&
        b.key.toLowerCase() === ev.key.toLowerCase(),
    );
    if (!match) continue;
    // App.tsx isDisabled: terminal focused + control/meta chord -> fall through.
    if (isTerminalControlChord(ev) || isTerminalMetaChord(ev)) return null;
    // No global handler -> early return without preventDefault -> fall through.
    if (!HANDLED.has(s.id)) return null;
    return s.id; // captured: this app action fires, shell never sees the key
  }
  return null; // unbound -> reaches the shell
}

// The keys a shell/readline/tmux/screen actually needs to receive.
const SHELL_KEYS: KeyBinding[] = [
  ..."abcdefghijklmnopqrstuvwxyz".split("").map((k) => ({ key: k, ctrl: true })),
  { key: "[", ctrl: true },
  { key: "]", ctrl: true },
  { key: "\\", ctrl: true },
  { key: "Enter" },
  { key: "Enter", ctrl: true },
  { key: "Enter", shift: true },
  { key: "Tab" },
  { key: "Escape" },
  { key: "Backspace" },
  { key: "ArrowUp" },
  { key: "ArrowDown" },
  { key: "ArrowLeft" },
  { key: "ArrowRight" },
  // readline meta sequences (M-b/f/d/. word ops, M-1..9 digit-argument).
  { key: "b", alt: true },
  { key: "f", alt: true },
  { key: "d", alt: true },
  { key: "z", alt: true },
  { key: "1", alt: true },
];
let shadowed = 0;
for (const b of SHELL_KEYS) {
  const fired = terminalAction(toEvent(b));
  if (fired) {
    console.error(`  SHADOWED: ${canon(b)} is eaten by ${fired} instead of reaching the shell`);
    shadowed++;
    failed++;
  }
}
if (shadowed === 0)
  console.log("  ok: all bare-Ctrl control codes + Enter/Tab/Esc/arrows reach the shell");

// --- C. Extension keybindings vs core, and vs each other -------------------
// The two dispatchers are BOTH capture-phase `window` listeners, so before
// `coreShortcutFor` the winner of a shared chord was decided by registration
// order - and `useGlobalShortcuts` re-registers on every rebind, which flipped
// it. Core now always wins, which means a colliding extension binding is simply
// dead: catch it here instead of shipping a shortcut that does nothing.
// (`tedi.beautify` shipped `Mod+Alt+B`, the same chord as `rightPanel.toggle`.)
console.log("\n[C] extension keybindings: no chord shared with core, or with another extension");
const EXT_DIR = join(ROOT, "extensions");
type ExtBinding = { ext: string; command: string; raw: string; chord: string };
const extBindings: ExtBinding[] = [];
let extDirs: string[] = [];
try {
  extDirs = readdirSync(EXT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("tedi."))
    .map((d) => d.name);
} catch {
  // `extensions/` holds gitignored working copies; a fresh clone has none.
}
for (const name of extDirs) {
  let manifest: { contributes?: { keybindings?: { command?: string; key?: string }[] } };
  try {
    manifest = JSON.parse(readFileSync(join(EXT_DIR, name, "manifest.json"), "utf8"));
  } catch {
    continue;
  }
  for (const kb of manifest.contributes?.keybindings ?? []) {
    if (!kb.key) continue;
    const parsed = parseKeybindingString(kb.key);
    if (!parsed) continue;
    extBindings.push({
      ext: name,
      command: kb.command ?? "?",
      raw: kb.key,
      chord: canon(parsed),
    });
  }
}
if (extDirs.length === 0) {
  console.log("  skipped: no extensions/ working copies present");
} else {
  let extClashes = 0;
  for (const b of extBindings) {
    const owner = byChord.get(b.chord);
    if (owner) {
      console.error(
        `  CLASH: ${b.ext} binds ${b.raw} (${b.chord}), which core's ${owner.join(", ")} owns - core wins, the extension shortcut is dead`,
      );
      extClashes++;
      failed++;
    }
  }
  const seenExt = new Map<string, string[]>();
  for (const b of extBindings) seenExt.set(b.chord, [...(seenExt.get(b.chord) ?? []), b.ext]);
  for (const [chord, owners] of seenExt) {
    if (owners.length > 1) {
      console.error(`  CLASH: ${chord} is bound by ${owners.join(" and ")} - first declared wins`);
      extClashes++;
      failed++;
    }
  }
  if (extClashes === 0)
    console.log(
      `  ok: ${extBindings.length} extension binding(s) across ${extDirs.length} extension(s), none shared`,
    );
}

// --- D. Vim mode: the editor keeps the Ctrl chords vim defines -------------
// `Prec.highest` inside CodeMirror does NOT help: `useGlobalShortcuts` is a
// window capture-phase listener that preventDefaults before CodeMirror sees the
// key at all. App's `isDisabled` hands these back via `isVimControlChord`.
console.log("\n[D] vim mode: every vim Ctrl chord core also binds falls through to the editor");
const VIM_CTRL_KEYS = "abcdefinopqrtuvwxy".split("").concat(["["]);
let vimHeld = 0;
for (const k of VIM_CTRL_KEYS) {
  const ev = toEvent({ key: k, ctrl: true });
  if (!byChord.has(canon({ key: k, ctrl: true }))) continue; // core does not want it
  if (!isVimControlChord(ev)) {
    console.error(`  HELD: Ctrl+${k} is a vim chord but core keeps it - vim never sees the key`);
    vimHeld++;
    failed++;
  }
}
if (vimHeld === 0) console.log("  ok: no core chord shadows a vim chord in a focused vim editor");

// Drift guard: the set above is hand-maintained, so assert it still matches
// what the installed `@replit/codemirror-vim` actually binds. A version bump
// that adds `<C-g>` must widen `VIM_CONTROL_CODES`, not silently lose the key.
try {
  const pkg = readFileSync(
    join(ROOT, "node_modules/@replit/codemirror-vim/dist/index.cjs"),
    "utf8",
  );
  const bound = new Set([...pkg.matchAll(/['"]<C-([a-z[])>['"]/g)].map((m) => m[1]));
  const missing = [...bound].filter((k) => !VIM_CTRL_KEYS.includes(k));
  if (missing.length > 0) {
    console.error(
      `  DRIFT: codemirror-vim also binds Ctrl+${missing.join(", Ctrl+")} - add to VIM_CONTROL_CODES + VIM_CTRL_KEYS`,
    );
    failed++;
  } else {
    console.log(`  ok: the ${bound.size} chords the installed vim package binds are all covered`);
  }
} catch {
  console.log("  (drift guard skipped: @replit/codemirror-vim not installed)");
}

// --- Informational: app chords that still fire inside a terminal ----------
console.log(
  "\n[info] app chords that stay active INSIDE a terminal (need Shift/Alt/Meta, non-control):",
);
const active = new Set<string>();
for (const s of SHORTCUTS) {
  for (const b of s.defaultBindings) {
    const fired = terminalAction(toEvent(b));
    if (fired) active.add(`${canon(b)} -> ${fired}`);
  }
}
[...active].sort().forEach((x) => console.log("  " + x));

if (failed > 0) throw new Error(`${failed} collision issue(s) found`);
console.log("\nAll checks passed: no clashes, terminal keeps every shell control code.");
