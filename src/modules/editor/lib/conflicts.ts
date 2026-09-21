/**
 * Merge conflict resolution inside the editor. A file with `<<<<<<<` /
 * `=======` / `>>>>>>>` blocks gets each side tinted and a bar above every
 * block to keep the current side, the incoming side, or both, the way VS Code
 * does it. Source Control already refuses to commit while a file is conflicted
 * and stages it once you check it off; this is the missing step in between.
 *
 * diff3 style (`|||||||` base section) is understood too; the base is dropped
 * by every choice, as git's own `--ours` / `--theirs` do.
 */
import { StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export type ConflictBlock = {
  /** Start of the `<<<<<<<` line. */
  from: number;
  /** End of the `>>>>>>>` line, before its line break. */
  to: number;
  /** Each section's text as [from, to), line breaks included. */
  ours: [number, number];
  base: [number, number] | null;
  theirs: [number, number];
  oursLabel: string;
  theirsLabel: string;
  /** 1-indexed marker lines, for the line tints. */
  startLine: number;
  baseLine: number | null;
  sepLine: number;
  endLine: number;
};

/** A document this large is not scanned on every keystroke. */
const MAX_SCAN_CHARS = 3_000_000;

/** Every complete conflict block in `doc`. Pure, so a verify can pin it. */
export function findConflicts(doc: Text): ConflictBlock[] {
  if (doc.length > MAX_SCAN_CHARS) return [];
  const out: ConflictBlock[] = [];
  let start: { line: number; from: number; to: number; label: string } | null = null;
  let base: { line: number; from: number; to: number } | null = null;
  let sep: { line: number; from: number; to: number } | null = null;
  let pos = 0;
  let n = 0;
  for (const text of doc.iterLines()) {
    n++;
    const from = pos;
    const to = pos + text.length;
    pos = to + 1;
    if (text.startsWith("<<<<<<<")) {
      start = { line: n, from, to, label: text.slice(7).trim() };
      base = null;
      sep = null;
    } else if (!start) {
      continue;
    } else if (!sep && !base && text.startsWith("|||||||")) {
      base = { line: n, from, to };
    } else if (!sep && text.trimEnd() === "=======") {
      sep = { line: n, from, to };
    } else if (sep && text.startsWith(">>>>>>>")) {
      out.push({
        from: start.from,
        to,
        ours: [start.to + 1, (base ?? sep).from],
        base: base ? [base.to + 1, sep.from] : null,
        theirs: [sep.to + 1, from],
        oursLabel: start.label,
        theirsLabel: text.slice(7).trim(),
        startLine: start.line,
        baseLine: base?.line ?? null,
        sepLine: sep.line,
        endLine: n,
      });
      start = base = sep = null;
    }
  }
  return out;
}

export type Resolution = "ours" | "theirs" | "both";

/** The change that replaces `block` with the chosen side(s). */
export function resolveChange(
  doc: Text,
  block: ConflictBlock,
  pick: Resolution,
): { from: number; to: number; insert: string } {
  const ours = doc.sliceString(...block.ours);
  const theirs = doc.sliceString(...block.theirs);
  let insert = pick === "ours" ? ours : pick === "theirs" ? theirs : ours + theirs;
  // Take the `>>>>>>>` line's own break with it, so no blank line is left; at
  // the very end of the file there is none, and the kept text's last break
  // would add one.
  let to = block.to;
  if (to < doc.length) to += 1;
  else insert = insert.replace(/\n$/, "");
  return { from: block.from, to, insert };
}

class ConflictActions extends WidgetType {
  constructor(
    readonly from: number,
    readonly oursLabel: string,
    readonly theirsLabel: string,
  ) {
    super();
  }

  eq(other: ConflictActions): boolean {
    return (
      other.from === this.from &&
      other.oursLabel === this.oursLabel &&
      other.theirsLabel === this.theirsLabel
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-actions";
    const add = (label: string, title: string, pick: Resolution) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        // Re-find by position: the widget can outlive edits elsewhere.
        const block = findConflicts(view.state.doc).find((c) => c.from === this.from);
        if (!block || view.state.readOnly) return;
        view.dispatch({
          changes: resolveChange(view.state.doc, block, pick),
          userEvent: "input.conflict",
        });
        view.focus();
      });
      bar.append(b);
    };
    add("Accept Current", `Keep ${this.oursLabel || "the current side"}`, "ours");
    add("Accept Incoming", `Keep ${this.theirsLabel || "the incoming side"}`, "theirs");
    add("Accept Both", "Keep both sides, current first", "both");
    return bar;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const blocks = findConflicts(state.doc);
  if (blocks.length === 0) return Decoration.none;
  const doc = state.doc;
  const ranges = [];
  const tint = (fromLine: number, toLine: number, cls: string) => {
    for (let l = fromLine; l <= toLine; l++) {
      ranges.push(Decoration.line({ class: cls }).range(doc.line(l).from));
    }
  };
  for (const b of blocks) {
    ranges.push(
      Decoration.widget({
        widget: new ConflictActions(b.from, b.oursLabel, b.theirsLabel),
        block: true,
        side: -1,
      }).range(b.from),
    );
    tint(b.startLine, b.startLine, "cm-conflict-marker cm-conflict-marker-ours");
    tint(b.startLine + 1, (b.baseLine ?? b.sepLine) - 1, "cm-conflict-ours");
    if (b.baseLine !== null) {
      tint(b.baseLine, b.baseLine, "cm-conflict-marker");
      tint(b.baseLine + 1, b.sepLine - 1, "cm-conflict-base");
    }
    tint(b.sepLine, b.sepLine, "cm-conflict-marker");
    tint(b.sepLine + 1, b.endLine - 1, "cm-conflict-theirs");
    tint(b.endLine, b.endLine, "cm-conflict-marker cm-conflict-marker-theirs");
  }
  return Decoration.set(ranges, true);
}

const conflictField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update: (deco, tr) => (tr.docChanged ? buildDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const conflictTheme = EditorView.baseTheme({
  ".cm-conflict-ours": { backgroundColor: "rgba(63, 185, 80, 0.10)" },
  ".cm-conflict-theirs": { backgroundColor: "rgba(56, 139, 253, 0.10)" },
  ".cm-conflict-base": { backgroundColor: "rgba(150, 150, 150, 0.08)" },
  ".cm-conflict-marker": { backgroundColor: "rgba(150, 150, 150, 0.14)", opacity: "0.8" },
  ".cm-conflict-marker-ours": { backgroundColor: "rgba(63, 185, 80, 0.22)" },
  ".cm-conflict-marker-theirs": { backgroundColor: "rgba(56, 139, 253, 0.22)" },
  ".cm-conflict-actions": {
    display: "flex",
    gap: "10px",
    padding: "2px 0 2px 2px",
    fontFamily: "var(--font-sans, system-ui)",
    fontSize: "11px",
  },
  ".cm-conflict-actions button": {
    background: "none",
    border: "none",
    padding: "0",
    cursor: "pointer",
    color: "var(--muted-foreground)",
  },
  ".cm-conflict-actions button:hover": {
    color: "var(--foreground)",
    textDecoration: "underline",
  },
});

export function conflictMarkers(): Extension {
  return [conflictField, conflictTheme];
}
