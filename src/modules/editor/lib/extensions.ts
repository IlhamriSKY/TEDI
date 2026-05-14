import { detectMonoFontFamily } from "@/lib/fonts";
import { foldGutter, indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();

// VSCode-style fold gutter: chevrons stay hidden until the gutter is hovered;
// folded regions keep their marker visible so collapsed sections are obvious.
function makeFoldMarker(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-foldMarker" + (open ? " cm-foldMarker-open" : "");
  span.innerHTML = open
    ? '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 4 L10 8 L6 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return span;
}

export function buildSharedExtensions(): Extension[] {
  return [
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    search({ top: true }),
    lintGutter(),
    foldGutter({
      markerDOM: makeFoldMarker,
    }),
    EditorView.theme({
      "&, &.cm-editor, &.cm-editor.cm-focused": {
        backgroundColor: "transparent !important",
        color: "var(--foreground)",
        outline: "none",
        padding: "8px",
      },
      ".cm-scroller": {
        fontFamily: detectMonoFontFamily(),
        fontSize: "13px",
        lineHeight: "1.55",
        backgroundColor: "transparent !important",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        backgroundColor: "transparent !important",
        paddingLeft: "0",
        marginLeft: "0",
      },
      // Solid background + sticky/elevated z so horizontally scrolled code
      // never bleeds through the line-number column. CodeMirror already
      // pins .cm-gutters with `position: sticky; left: 0; z-index: 200`,
      // so the opaque bg is what was actually missing.
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
      // Folded marker (chevron right) stays visible so collapsed regions are obvious.
      ".cm-foldGutter .cm-foldMarker:not(.cm-foldMarker-open)": {
        opacity: "1",
        color: "var(--foreground)",
      },
      // Reveal the open chevrons when the gutter is hovered.
      "&:hover .cm-foldGutter .cm-foldMarker-open": {
        opacity: "0.55",
      },
      ".cm-foldGutter .cm-gutterElement:hover .cm-foldMarker": {
        opacity: "1",
        color: "var(--foreground)",
      },
      // Inline placeholder shown where a region is folded.
      ".cm-foldPlaceholder": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 10%, transparent)",
        color: "var(--muted-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "0",
        padding: "0 4px",
        margin: "0 2px",
        fontSize: "11px",
      },
      ".cm-activeLine": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 5%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 5%, transparent) !important",
        color: "var(--foreground)",
        userSelect: "none",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
      },
      // Vim normal-mode block cursor - translucent foreground, no rose hue.
      ".cm-fat-cursor": {
        background:
          "color-mix(in srgb, var(--foreground) 35%, transparent) !important",
        outline:
          "1px solid color-mix(in srgb, var(--foreground) 55%, transparent) !important",
        color: "var(--foreground) !important",
      },
      "&:not(.cm-focused) .cm-fat-cursor": {
        background: "transparent !important",
        outline:
          "1px solid color-mix(in srgb, var(--foreground) 35%, transparent) !important",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
        {
          backgroundColor:
            "color-mix(in srgb, var(--foreground) 18%, transparent) !important",
        },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        borderColor: "var(--border)",
      },
    }),
  ];
}
