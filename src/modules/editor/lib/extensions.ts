import { MONO_FONT_CSS_FALLBACK } from "@/lib/fonts";
import {
  defaultHighlightStyle,
  foldGutter,
  indentUnit,
  language,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";
import { colorDecorations, colorLinesField } from "./colorDecorations";
// VS Code-style fold gutter: chevrons hide until hover, folded markers stay
// visible so collapsed sections are obvious. The glyph itself is shared with
// the extension host's editor, so the two never drift apart.
import { makeFoldMarker } from "./foldMarker";

// Compartments for runtime reconfigure without rebuilding state.
export const languageCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const minimapCompartment = new Compartment();

export function minimapExtension(): Extension {
  // Deps: "doc" re-parses on edits; "language" recomputes after async
  // `resolveLanguage` reconfigures the compartment, so the first paint
  // isn't stuck uncolored until the next keystroke.
  return showMinimap.compute(["doc", language], (state) => {
    const colorLines = state.field(colorLinesField, false) ?? {};
    return {
      create: () => {
        const dom = document.createElement("div");
        // Match editor surface so the minimap blends with the gutter.
        dom.style.background = "transparent";
        return { dom };
      },
      displayText: "characters",
      showOverlay: "always",
      gutters: Object.keys(colorLines).length > 0 ? [colorLines] : undefined,
    };
  });
}

export function buildSharedExtensions(opts?: {
  /** When false the minimap compartment starts empty. Default true. */
  showMinimap?: boolean;
}): Extension[] {
  const minimapOn = opts?.showMinimap !== false;
  return [
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    search({ top: true }),
    // Syntax highlighting fallback - ensures language extensions get highlighted
    // in both the main editor and the diff pane.
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    lintGutter(),
    foldGutter({
      markerDOM: makeFoldMarker,
    }),
    colorDecorations(),
    minimapCompartment.of(minimapOn ? minimapExtension() : []),
    EditorView.theme({
      "&, &.cm-editor, &.cm-editor.cm-focused": {
        backgroundColor: "transparent !important",
        color: "var(--foreground)",
        outline: "none",
        // Drop top, right, and bottom padding so the first line, scrollbars,
        // and minimap sit flush with the pane edges. Left keeps 8px so the
        // gutter doesn't crowd the edge.
        padding: "0 0 0 8px",
      },
      ".cm-scroller": {
        // Font family + base size come from the user's font picker via CSS vars
        // (set by `applyMonoFontVar` / `applyEditorFontSizeVar`). The inline
        // fallbacks keep the first paint sane before prefs hydrate.
        fontFamily: `var(--tedi-mono-font, ${MONO_FONT_CSS_FALLBACK})`,
        // `none` fallback, and the pref defaults to off, because a ligature
        // glyph paints outside its own cell and WebView2 repaints only the
        // cell you typed - see `editorLigatures` in `settings/store.ts`.
        // Settings > Code Editor > Font ligatures flips it to `normal`.
        fontVariantLigatures: "var(--tedi-editor-ligatures, none)",
        // Editor base size scales with `--content-zoom` (set by App.tsx).
        fontSize: "calc(var(--tedi-editor-font-size, 13px) * var(--content-zoom, 1))",
        lineHeight: "1.55",
        backgroundColor: "transparent !important",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        backgroundColor: "transparent !important",
        paddingLeft: "0",
        marginLeft: "0",
      },
      // Solid bg + elevated z so horizontally scrolled code doesn't bleed
      // through the line-number column.
      ".cm-gutters": {
        backgroundColor: "var(--background) !important",
        color: "var(--muted-foreground)",
        borderRight: "1px solid var(--border) !important",
        marginRight: "0 !important",
        zIndex: "3",
      },
      ".cm-line": {
        paddingLeft: "4px",
      },
      ".cm-gutter-lint": {
        width: "0px",
      },
      ".cm-gutter": { backgroundColor: "transparent !important" },
      ".cm-lineNumbers": {
        minWidth: "32px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        opacity: "0.55",
        padding: "0 8px 0 8px",
        textAlign: "right",
      },
      ".cm-foldGutter": {
        width: "14px",
      },
      ".cm-foldGutter .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted-foreground)",
        cursor: "pointer",
        padding: "0",
      },
      ".cm-foldGutter .cm-foldMarker": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        opacity: "0",
        transition: "opacity 120ms ease, color 120ms ease",
      },
      // Folded chevron stays visible so collapsed regions are obvious.
      ".cm-foldGutter .cm-foldMarker:not(.cm-foldMarker-open)": {
        opacity: "1",
        color: "var(--foreground)",
      },
      // Reveal open chevrons on gutter hover.
      "&:hover .cm-foldGutter .cm-foldMarker-open": {
        opacity: "0.55",
      },
      ".cm-foldGutter .cm-gutterElement:hover .cm-foldMarker": {
        opacity: "1",
        color: "var(--foreground)",
      },
      // Inline placeholder for folded regions.
      ".cm-foldPlaceholder": {
        backgroundColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",
        color: "var(--muted-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "0",
        padding: "0 4px",
        margin: "0 2px",
        fontSize: "calc(11px * var(--content-zoom, 1))",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--foreground) 5%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--foreground) 5%, transparent) !important",
        color: "var(--foreground)",
        userSelect: "none",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
      },
      // Vim normal-mode block cursor: translucent foreground, no rose hue.
      ".cm-fat-cursor": {
        background: "color-mix(in srgb, var(--foreground) 35%, transparent) !important",
        outline: "1px solid color-mix(in srgb, var(--foreground) 55%, transparent) !important",
        color: "var(--foreground) !important",
      },
      "&:not(.cm-focused) .cm-fat-cursor": {
        background: "transparent !important",
        outline: "1px solid color-mix(in srgb, var(--foreground) 35%, transparent) !important",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "color-mix(in srgb, var(--foreground) 18%, transparent) !important",
      },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        borderColor: "var(--border)",
      },
      // Minimap inherits `.cm-gutters`, but its right border lands against
      // the panel edge. Move the divider to the minimap's left edge.
      ".cm-minimap-gutter": {
        borderRight: "0 !important",
        borderLeft: "1px solid var(--border) !important",
      },
    }),
  ];
}
