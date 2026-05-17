import { type Extension, RangeSetBuilder, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// Hex (#rgb, #rgba, #rrggbb, #rrggbbaa) plus functional rgb/rgba/hsl/hsla.
// `\b` on the hex variant prevents matching the middle of an identifier
// like `#abc123def` past 8 chars; the functional forms are unambiguous.
const COLOR_RE =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgb|hsl)a?\([^)\n]*\)/g;

// Cache parsed colors so we don't hit the browser parser on every keystroke.
const colorCache = new Map<string, { css: string; fg: string } | null>();

const probe = typeof document !== "undefined" ? document.createElement("div") : null;

function rgbToFg(rgb: string): string {
  const m = rgb.match(/\(([^)]+)\)/);
  if (!m) return "#ffffff";
  const parts = m[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return "#ffffff";
  const r = parseFloat(parts[0]) / 255;
  const g = parseFloat(parts[1]) / 255;
  const b = parseFloat(parts[2]) / 255;
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return lum > 0.5 ? "#000000" : "#ffffff";
}

function parseColor(raw: string): { css: string; fg: string } | null {
  const cached = colorCache.get(raw);
  if (cached !== undefined) return cached;
  let result: { css: string; fg: string } | null = null;
  if (probe) {
    probe.style.color = "";
    probe.style.color = raw;
    const computed = probe.style.color;
    if (computed) {
      result = { css: computed, fg: rgbToFg(computed) };
    }
  }
  if (colorCache.size > 1024) colorCache.clear();
  colorCache.set(raw, result);
  return result;
}

// Scan limit so a 200k-line minified file doesn't stall the UI thread.
const MAX_LINES_FOR_GUTTER = 5000;

export type LineColorMap = Record<number, string>;

/**
 * Tracks the first color literal on each line of the document. Drives the
 * minimap gutter so colored regions are visible at a glance, even when the
 * lines themselves are outside the editor viewport.
 */
export const colorLinesField = StateField.define<LineColorMap>({
  create() {
    return {};
  },
  update(value, tr) {
    if (!tr.docChanged && Object.keys(value).length > 0) return value;
    const doc = tr.state.doc;
    const next: LineColorMap = {};
    const lineCount = Math.min(doc.lines, MAX_LINES_FOR_GUTTER);
    for (let i = 1; i <= lineCount; i++) {
      const line = doc.line(i);
      COLOR_RE.lastIndex = 0;
      const m = COLOR_RE.exec(line.text);
      if (!m) continue;
      const parsed = parseColor(m[0]);
      if (parsed) next[i] = parsed.css;
    }
    return next;
  },
});

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    COLOR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COLOR_RE.exec(text)) !== null) {
      const parsed = parseColor(m[0]);
      if (!parsed) continue;
      const start = from + m.index;
      const end = start + m[0].length;
      builder.add(
        start,
        end,
        Decoration.mark({
          attributes: {
            style: `background-color:${parsed.css};color:${parsed.fg};border-radius:2px;padding:0 1px;`,
          },
        }),
      );
    }
  }
  return builder.finish();
}

const colorMarkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Bundle: a state field tracking per-line colors (consumed by the minimap
 * gutter) plus a viewport-scoped ViewPlugin that paints the colored
 * background swatches behind the literals themselves.
 */
export function colorDecorations(): Extension {
  return [colorLinesField, colorMarkPlugin];
}
