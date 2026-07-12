/**
 * Main-window taps that let a floating window mirror a live terminal leaf.
 * These reach straight into the off-React `sessions` map (same module) so the
 * float host (modules/panes/floatHost) can forward output, replay scrollback,
 * report size, and inject input without threading refs through React.
 */
import { sessions } from "./sessionState";

/** Subscribe to a leaf's raw PTY output. Returns an unsubscribe. No-op (still
 *  returns a cleanup) if the session isn't live yet. */
export function subscribeTerminalOutput(
  leafId: number,
  fn: (bytes: Uint8Array) => void,
): () => void {
  const s = sessions.get(leafId);
  if (!s) return () => {};
  s.onOutputTap = fn;
  return () => {
    if (s.onOutputTap === fn) s.onOutputTap = null;
  };
}

/** Current viewport dimensions, so the float sizes its xterm to match. */
export function terminalSize(leafId: number): { cols: number; rows: number } | null {
  const s = sessions.get(leafId);
  return s ? { cols: s.term.cols, rows: s.term.rows } : null;
}

/** A slice of scrollback as plain text the float writes on open, so it starts
 *  already showing recent history (colour is dropped; live bytes after the
 *  snapshot carry full ANSI). */
export function serializeTerminal(leafId: number, scrollback = 2000): string | null {
  const s = sessions.get(leafId);
  if (!s) return null;
  const buf = s.term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - scrollback);
  const lines: string[] = [];
  for (let i = start; i < total; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\r\n");
}

/** Send input from the float back to the leaf's PTY. */
export function writeTerminalInput(leafId: number, data: string): void {
  void sessions.get(leafId)?.pty?.write(data);
}
