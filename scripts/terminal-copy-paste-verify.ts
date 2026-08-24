/**
 * Self-check for terminal copy/paste reaching the PC clipboard (Termius parity).
 * Run: `npx tsx scripts/terminal-copy-paste-verify.ts`.
 *
 * xterm maps bare Ctrl+V to ^V and bare Ctrl+C to ETX, so without an app-level
 * binding the PC clipboard never reaches a shell - local or over SSH. Both are
 * bound in the catalog instead, which puts three fragile joints in three files:
 *
 *  1. CATALOG: the non-macOS defaults carry BOTH the explicit chord and the bare
 *     one (Ctrl+Shift+C / Ctrl+C, Ctrl+Shift+V / Ctrl+V / Shift+Insert).
 *  2. FIRST MATCH WINS: `useGlobalShortcuts` scans SHORTCUTS in order and
 *     `return`s on the first match, disabled or not. A later id that also claims
 *     bare Ctrl+C or Ctrl+V would silently shadow copy/paste.
 *  3. GATED ON REAL FOCUS: bare Ctrl+C / Ctrl+V are `isTerminalControlChord`s,
 *     so App's `isDisabled` decides whether they reach the app or fall through
 *     to the shell. Two halves must hold, and each fails in a different
 *     direction: `appOwnsTerminalChord` must claim them (or paste is dead and
 *     Ctrl+C never copies), and the DOM-focus check must gate them (or matching
 *     while the caret is in the AI composer / an editor / a dialog field
 *     preventDefaults the keystroke and kills NATIVE copy/paste app-wide -
 *     `activeLeafKindCurrent` tracks the active leaf, not the focused element).
 *  4. NOT A ONE-WAY TRAP: copying with bare Ctrl+C clears the selection, so the
 *     next Ctrl+C is SIGINT again. Without it, a lingering highlight makes
 *     Ctrl+C copy forever and the user cannot interrupt a runaway command.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Straight from the catalog file, NOT the `@/modules/shortcuts` barrel: the
// barrel re-exports `useGlobalShortcuts`, which reaches `settings/store.ts` and
// touches `window` at module scope (dead on import under node).
import {
  SHORTCUTS,
  isTerminalControlChord,
  matchBinding,
  type ShortcutId,
} from "../src/modules/shortcuts/shortcuts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Minimal stand-in for the fields `matchBinding` / `isTerminalControlChord` read. */
type FakeKey = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; code: string };
function key({ ctrl, shift, alt, meta, code }: FakeKey): KeyboardEvent {
  const printable = code.startsWith("Key") ? code.slice(3).toLowerCase() : code;
  return {
    code,
    key: printable,
    ctrlKey: !!ctrl,
    shiftKey: !!shift,
    altKey: !!alt,
    metaKey: !!meta,
  } as KeyboardEvent;
}

/** What `useGlobalShortcuts` would dispatch: the FIRST catalog id that matches. */
function firstMatch(e: KeyboardEvent): ShortcutId | null {
  for (const s of SHORTCUTS) {
    if (s.defaultBindings.some((b) => matchBinding(e, b, s.id))) return s.id;
  }
  return null;
}

// `platform()` throws outside Tauri, so `IS_MAC` is false here: the imported
// catalog is the Windows/Linux one, which is exactly the one under test (macOS
// binds Cmd+C/Cmd+V, chords no shell ever wanted).
console.log("1. the non-macOS defaults carry the bare chords as well");
{
  const binding = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)?.defaultBindings ?? [];
  const has = (id: ShortcutId, e: KeyboardEvent) => binding(id).some((b) => matchBinding(e, b, id));

  assert(
    has("terminal.copy", key({ ctrl: true, shift: true, code: "KeyC" })),
    "terminal.copy binds Ctrl+Shift+C",
  );
  assert(has("terminal.copy", key({ ctrl: true, code: "KeyC" })), "terminal.copy binds Ctrl+C");
  assert(
    has("terminal.paste", key({ ctrl: true, shift: true, code: "KeyV" })),
    "terminal.paste binds Ctrl+Shift+V",
  );
  assert(has("terminal.paste", key({ ctrl: true, code: "KeyV" })), "terminal.paste binds Ctrl+V");
  assert(
    has("terminal.paste", key({ shift: true, code: "Insert" })),
    "terminal.paste binds Shift+Insert",
  );
}

console.log("2. no other shortcut shadows the bare chords");
{
  assert(
    firstMatch(key({ ctrl: true, code: "KeyC" })) === "terminal.copy",
    "Ctrl+C -> terminal.copy",
  );
  assert(
    firstMatch(key({ ctrl: true, code: "KeyV" })) === "terminal.paste",
    "Ctrl+V -> terminal.paste",
  );
  // The explicit chords must keep working too - they are the ones a shell can
  // never claim, and the only copy/paste on a terminal running nano or readline
  // (where the bare pair may be cleared in Settings > Shortcuts).
  assert(
    firstMatch(key({ ctrl: true, shift: true, code: "KeyC" })) === "terminal.copy",
    "Ctrl+Shift+C -> terminal.copy",
  );
  assert(
    firstMatch(key({ ctrl: true, shift: true, code: "KeyV" })) === "terminal.paste",
    "Ctrl+Shift+V -> terminal.paste",
  );
  // Bare Ctrl+C/V must NOT be reachable when the app is not the target: they are
  // control chords, so App's isDisabled is what decides. Assert the premise.
  assert(
    isTerminalControlChord(key({ ctrl: true, code: "KeyC" })) &&
      isTerminalControlChord(key({ ctrl: true, code: "KeyV" })),
    "both bare chords route through the terminal control-chord gate",
  );
  assert(
    !isTerminalControlChord(key({ ctrl: true, shift: true, code: "KeyV" })),
    "Ctrl+Shift+V bypasses that gate (Shift excludes it), so it fires anywhere",
  );
}

console.log("3. App decides them off REAL keyboard focus, not the active leaf");
{
  const app = read("src/app/App.tsx");
  // The regression that costs the most: keyed off `activeLeafKindCurrent`, a
  // bare Ctrl+V typed into the AI composer still matches terminal.paste, gets
  // preventDefault()ed, and then pastes nowhere. So with nothing focused the
  // BARE pair, and any editable target, must still be disabled.
  assert(
    /id === "terminal\.copy" \|\| id === "terminal\.paste"[\s\S]{0,200}?focusedTerminalLeafId\(\)[\s\S]{0,80}?if \(leafId === null\) \{/.test(
      app,
    ),
    "the gate branches on whether a terminal pane holds keyboard focus",
  );
  assert(
    /if \(leafId === null\) \{[\s\S]{0,1400}?e\.ctrlKey && !e\.shiftKey && !e\.altKey && !e\.metaKey\) return true;/.test(
      app,
    ),
    "with no terminal focused the bare Ctrl+C / Ctrl+V variants stay disabled",
  );
  assert(
    /if \(leafId === null\) \{[\s\S]{0,1600}?isContentEditable[\s\S]{0,140}?return true;/.test(app),
    "and an editable target keeps its native paste (Ctrl+Shift+V, Shift+Insert)",
  );
  // The mirror-image failure, and the one users actually hit: clicking a tab, a
  // pane-header icon or the SSH menu that opened the session leaves focus on a
  // BUTTON, so a null leaf must fall back to the active pane rather than make
  // Ctrl+Shift+C / Ctrl+Shift+V silently do nothing (Termius parity).
  assert(
    /if \(leafId === null\) \{[\s\S]{0,1800}?return activeLeafKindCurrent !== "terminal" \|\| activeLeafIdInTab === null;/.test(
      app,
    ),
    "otherwise they act on the ACTIVE terminal pane instead of doing nothing",
  );
  // ...and the mirror-image regression: consume bare Ctrl+C with nothing
  // selected and the shell never sees SIGINT.
  assert(
    /id === "terminal\.copy" && isTerminalControlChord\(e\)[\s\S]{0,200}?getSelection\(\)/.test(
      app,
    ),
    "bare Ctrl+C is disabled (falls through as SIGINT) with no selection",
  );
  assert(
    /focusedTerminalLeafId\(\) \?\?/.test(read("src/app/lib/shortcutHandlers.ts")),
    "the handlers act on the focused terminal too, not just the gate",
  );
  assert(
    /export function focusedTerminalLeafId\(\)[\s\S]{0,200}?document\.activeElement/.test(
      read("src/modules/terminal/lib/session-lifecycle.ts"),
    ),
    "focusedTerminalLeafId resolves the pane from document.activeElement",
  );
  assert(
    read("src/modules/terminal/TerminalPane.tsx").includes("data-terminal-leaf-id={leafId}"),
    "the terminal pane host still carries the data-terminal-leaf-id it resolves",
  );
}

console.log("4. bare Ctrl+C copy clears the selection, so the next press is SIGINT");
{
  const handlers = read("src/app/lib/shortcutHandlers.ts");
  assert(
    /"terminal\.copy": \(e\)/.test(handlers),
    "terminal.copy receives the KeyboardEvent (it needs the modifiers)",
  );
  assert(
    /e\.ctrlKey && !e\.shiftKey && !e\.altKey && !e\.metaKey[\s\S]{0,40}?clearSelection\(\)/.test(
      handlers,
    ),
    "it clears the selection on the bare-Ctrl chord only",
  );
  assert(
    /clearSelection: \(\) => void;/.test(read("src/modules/terminal/TerminalPane.tsx")),
    "TerminalPaneHandle exposes clearSelection",
  );
  // Paste must stay on term.paste: the raw pty write would skip bracketed paste
  // and run every line of a multi-line snippet on arrival.
  assert(
    /"terminal\.paste"[\s\S]{0,400}?term\.paste\(text\)/.test(handlers),
    "terminal.paste goes through xterm's bracketed paste, not a raw pty write",
  );
}

console.log("5. every OTHER xterm that can drive a live (SSH) shell can paste too");
{
  // A docked pane is not the only place an SSH session takes keystrokes. Both of
  // these render their own `new Terminal(...)` and write back to the real PTY,
  // and neither is reached by the shortcut catalog, so each needs its own
  // wiring. `grep -rn "new Terminal(" src/ extensions/` is the sweep that finds
  // a fourth one if it ever appears.
  const float = read("src/float/FloatTerminal.tsx");
  assert(
    /attachCustomKeyEventHandler[\s\S]{0,900}?pasteClipboard\(\)/.test(float),
    "the floated pane (a live mirror, SSH included) binds a paste chord",
  );
  assert(
    /bare && !term\.hasSelection\(\)/.test(float),
    "and its bare Ctrl+C still falls through as SIGINT with nothing selected",
  );

  // The remote web client runs in a real browser, so it takes the cheaper route:
  // return false WITHOUT preventDefault and the browser's own paste command
  // fires the `paste` event xterm already listens for. Asserted because adding a
  // preventDefault there silently kills paste again.
  const remote = read("extensions/tedi.remote-access/client/src/hooks/useRemote.ts");
  assert(
    /if \(key === "v"\) return false;/.test(remote),
    "the remote web client hands Ctrl+V to the browser's native paste",
  );
  assert(
    !/if \(key === "v"\)[\s\S]{0,80}?preventDefault/.test(remote),
    "and does NOT preventDefault it (that is what stops the paste event firing)",
  );
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`terminal-copy-paste-verify: ${failed} check(s) failed`);
console.log("\nterminal-copy-paste-verify: all checks passed");
