/**
 * Self-check for `isTerminalControlChord`, the gate that lets a focused
 * terminal keep every bare-Ctrl control code (readline editing, Ctrl+D EOF /
 * screen detach, Ctrl+I Tab, Ctrl+[ Esc, the tmux/screen prefix) instead of the
 * app's Mod+letter shortcuts stealing them on Windows/Linux.
 * Run: `npx tsx scripts/keybindings-terminal-verify.ts`.
 */
import { isTerminalControlChord } from "../src/modules/shortcuts/shortcuts";

type Ev = {
  code: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};
const ev = (e: Ev) =>
  isTerminalControlChord({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...e,
  } as KeyboardEvent);

let failed = 0;
function expect(label: string, e: Ev, want: boolean): void {
  const got = ev(e);
  if (got !== want) {
    console.error(`  FAIL: ${label} = ${got}, want ${want}`);
    failed++;
  } else {
    console.log(`  ok: ${want ? "pass-to-shell" : "keep-app-shortcut"} <- ${label}`);
  }
}

console.log("[bare Ctrl + control-code key] -> reach the shell");
for (const [code, name] of [
  ["KeyD", "Ctrl+D (EOF / screen detach)"],
  ["KeyE", "Ctrl+E (end-of-line)"],
  ["KeyW", "Ctrl+W (kill-word)"],
  ["KeyK", "Ctrl+K (kill-line)"],
  ["KeyL", "Ctrl+L (clear)"],
  ["KeyB", "Ctrl+B (back-char / tmux prefix)"],
  ["KeyA", "Ctrl+A (start-of-line / screen prefix)"],
  ["KeyI", "Ctrl+I (Tab)"],
  ["BracketLeft", "Ctrl+[ (Esc)"],
  ["BracketRight", "Ctrl+] (GS)"],
  ["Backslash", "Ctrl+\\ (SIGQUIT)"],
] as const) {
  expect(name, { code, ctrlKey: true }, true);
}

console.log("\n[app chords] -> stay active, never stolen from");
expect("Ctrl+Shift+C (copy)", { code: "KeyC", ctrlKey: true, shiftKey: true }, false);
expect("Ctrl+Shift+V (paste)", { code: "KeyV", ctrlKey: true, shiftKey: true }, false);
expect("Ctrl+Shift+X (close terminal)", { code: "KeyX", ctrlKey: true, shiftKey: true }, false);
expect("Ctrl+Tab (next tab)", { code: "Tab", ctrlKey: true }, false);
expect("Ctrl+1 (jump to tab)", { code: "Digit1", ctrlKey: true }, false);
expect("Ctrl+= (zoom in)", { code: "Equal", ctrlKey: true }, false);
expect("Ctrl+, (settings)", { code: "Comma", ctrlKey: true }, false);
expect("Alt+D (not Ctrl)", { code: "KeyD", altKey: true }, false);
expect("Cmd+D on macOS (meta, not ctrl)", { code: "KeyD", metaKey: true }, false);
expect("plain D (no modifier)", { code: "KeyD" }, false);

if (failed > 0) throw new Error(`${failed} check(s) failed`);
console.log("\nAll checks passed.");
