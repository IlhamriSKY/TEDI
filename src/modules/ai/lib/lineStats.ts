/**
 * Line-level shape of an applied edit, so the chat tool card can say WHICH
 * lines changed instead of only "1 replacement".
 *
 * This is computed where the edit is applied, because that is the only place
 * that holds both the file text and the offset the replacement landed at. The
 * card cannot re-derive it: the tool result travels through the model's context
 * and back, long after the buffer is gone.
 */

/** One replacement, in line terms. */
export type EditHunk = {
  /** 1-based line the replaced text starts on. */
  line: number;
  /** Lines the old text spanned. */
  removed: number;
  /** Lines the new text spans. */
  added: number;
};

/** Kept small: this rides in the model's context on every edit. */
export const MAX_REPORTED_HUNKS = 10;

/**
 * 1-based line number of `offset` within `text`. Counts `\n`, so it is correct
 * for CRLF files too (`\r\n` still contains one `\n`).
 */
export function lineAt(text: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * How many lines a string occupies. `""` and `"abc"` are both 1: an empty
 * replacement still sits on a line, it does not erase it. `"a\nb"` is 2.
 */
export function lineSpan(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * Read hunks back off a tool result. This is a trust boundary, not a cast: the
 * value round-trips through the model's context and through persisted session
 * history, so it arrives as whatever JSON came back. A session recorded before
 * hunks existed simply has none, and the card drops the detail rows.
 */
export function parseHunks(value: unknown): EditHunk[] {
  if (!Array.isArray(value)) return [];
  const out: EditHunk[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    // A line number is the whole point of the row; drop anything without one.
    if (typeof h.line !== "number" || !Number.isFinite(h.line) || h.line < 1) continue;
    const added = typeof h.added === "number" && Number.isFinite(h.added) ? h.added : 0;
    const removed = typeof h.removed === "number" && Number.isFinite(h.removed) ? h.removed : 0;
    out.push({
      line: Math.floor(h.line),
      added: Math.max(0, added),
      removed: Math.max(0, removed),
    });
    if (out.length >= MAX_REPORTED_HUNKS) break;
  }
  return out;
}

/**
 * Totals across hunks, for the card's `+N -M` badge. Keyed to match the tool
 * result's wire shape so it can be spread straight into the return value.
 */
export function totalLines(hunks: readonly EditHunk[]): {
  linesAdded: number;
  linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const h of hunks) {
    linesAdded += h.added;
    linesRemoved += h.removed;
  }
  return { linesAdded, linesRemoved };
}
