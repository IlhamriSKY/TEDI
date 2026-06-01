export type PickerTrigger = {
  start: number;
  end: number;
  query: string;
  /** Sigil that triggered the picker. `slash` is commands-only, `hash` is snippets plus commands, `mention` is file/folder. */
  kind: "slash" | "hash" | "mention";
};

/** Mention scanner. Allows path chars (`/`, `.`, `_`, `-`) so `@src/foo/bar` works.
 *  Scans backward for `@`; bails on other sigils or whitespace. */
function detectMentionTrigger(value: string, caret: number): PickerTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice, kind: "mention" };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-zA-Z0-9_\-./]/.test(ch)) return null;
  }
  return null;
}

/** Command scanner. `/` or `#` followed by `[a-z0-9-]*`. Returns null on any
 *  non-command char so it never collides with the mention scanner. */
function detectCommandTrigger(value: string, caret: number): PickerTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#" || ch === "/") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return {
        start: i,
        end: caret,
        query: slice.toLowerCase(),
        kind: ch === "/" ? "slash" : "hash",
      };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

export function detectPickerTrigger(value: string, caret: number): PickerTrigger | null {
  // Mention wins over command on `@src/foo` (both `@` and `/` in scope).
  return detectMentionTrigger(value, caret) ?? detectCommandTrigger(value, caret);
}
