/**
 * Lightweight CodeMirror 6 mount used by `ctx.ui.codeEditor`. Keeps the
 * subset of features that matter for ad-hoc query editors (syntax
 * highlight, line numbers, history, Mod+Enter callback, optional
 * extension-driven completions) while staying out of the bigger
 * EditorPane extension tower (vim, minimap, lint, full search) so an
 * extension can drop one of these into any container without taking on
 * the EditorPane shape.
 *
 * The theme intentionally pulls TEDI's CSS variables instead of
 * hard-coded colors so the editor visually matches whatever theme the
 * user has active.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import {
  HighlightStyle,
  StreamLanguage,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
} from "@codemirror/language";
import { http } from "@codemirror/legacy-modes/mode/http";
import { mySQL, pgSQL, sqlite, standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { makeFoldMarker } from "@/modules/editor/lib/foldMarker";
import { loadEditorTheme, tryEditorTheme } from "@/modules/editor/lib/themes";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { EditorThemeId } from "@/modules/settings/store";
import { MONO_FONT_CSS_FALLBACK } from "@/lib/fonts";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

export type CodeEditorLanguage =
  "sql" | "sql:mysql" | "sql:postgres" | "sql:sqlite" | "json" | "javascript" | "http" | "plain";

/** Single autocomplete suggestion. `type` controls the leading icon CM
 *  paints (keyword / variable / property / type / function / etc - see
 *  the @codemirror/autocomplete docs). `detail` and `info` are right-side
 *  metadata: `detail` is a short inline label (e.g. the parent table for
 *  a column), `info` is a longer hover description. */
export type CodeEditorCompletion = {
  label: string;
  detail?: string;
  info?: string;
  type?: string;
  /** Optional replacement text. Defaults to `label`. Useful when the
   *  inserted form differs from what the user sees in the menu. */
  apply?: string;
  /** Sort hint. Higher values float to the top of the menu. Default 0. */
  boost?: number;
};

export type CodeEditorOptions = {
  language?: CodeEditorLanguage;
  value?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Fires on Ctrl/Cmd+Enter. Returning `false` lets default handling run;
   *  by default the helper returns `true` so newlines are suppressed. */
  onCmdEnter?: () => void;
  /** Optional completion source. Receives the current prefix (the word
   *  before the caret, may be empty when the user explicitly asks for
   *  completions via Ctrl+Space) and returns matching suggestions
   *  synchronously. Returning `[]` shows no popup. Older TEDI hosts
   *  ignore this field so extensions can opt in without bumping engines. */
  completions?: (prefix: string) => CodeEditorCompletion[];
};

export type CodeEditorHandle = {
  setValue(value: string): void;
  getValue(): string;
  /** The selected text, or `""` when the selection is empty. Lets an
   *  extension implement "run only what I highlighted", which every SQL /
   *  script console offers and `getValue()` alone can't express. */
  getSelection(): string;
  /** Caret offset in the document. Pairs with `getValue()` so an extension
   *  can work out which statement the caret sits in. */
  getCursor(): number;
  focus(): void;
  setLanguage(language: CodeEditorLanguage): void;
  dispose(): void;
};

function pickLanguage(name?: CodeEditorLanguage): Extension {
  switch (name) {
    case "sql":
      return StreamLanguage.define(standardSQL);
    case "sql:mysql":
      return StreamLanguage.define(mySQL);
    case "sql:postgres":
      return StreamLanguage.define(pgSQL);
    case "sql:sqlite":
      return StreamLanguage.define(sqlite);
    case "json":
      return json();
    case "javascript":
      return javascript();
    // `.http` documents: a request line, headers, then a body. The API Client's
    // Code tab writes one, and it is the same grammar VS Code REST Client and
    // the JetBrains HTTP Client read.
    case "http":
      return StreamLanguage.define(http);
    case "plain":
    default:
      return [];
  }
}

/** Syntax-highlight palette tuned to TEDI's CSS vars. Comment / keyword /
 *  string / number / type tones match the same color cues the host editor
 *  uses for code panes. */
const tediHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword],
    color: "var(--tedi-tab-ai-diff, #8b5cf6)",
    fontWeight: "600",
  },
  { tag: t.string, color: "var(--tedi-tab-terminal, #10b981)" },
  { tag: t.number, color: "var(--tedi-tab-git-diff, #f59e0b)" },
  { tag: t.bool, color: "var(--tedi-tab-git-diff, #f59e0b)" },
  { tag: t.null, color: "var(--muted-foreground)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.typeName, color: "var(--tedi-tab-ssh, #0ea5e9)" },
  { tag: [t.variableName, t.propertyName], color: "var(--foreground)" },
  { tag: t.atom, color: "var(--tedi-tab-browser, #06b6d4)" },
  { tag: t.punctuation, color: "var(--muted-foreground)" },
]);

const baseTheme = EditorView.theme({
  // Surfaces and typography are the editor pane's, so an extension's editor
  // reads as the same tool: same mono font + size from the user's picker, same
  // line height, and the app background rather than whatever the CodeMirror
  // theme paints. `!important` for the same reason the pane needs it - the
  // upstream theme's own background rule has equal specificity.
  "&": {
    backgroundColor: "var(--background) !important",
    color: "var(--foreground)",
    height: "100%",
    // Same geometry as the editor pane (`editor/lib/extensions.ts`), which is
    // the whole point of this theme: an extension's editor must not sit lower
    // in its panel than the editor pane does in its own. This one used to add
    // 8px above the first line, so SQL Explorer and API Client opened with a
    // visible gap under their toolbars that no other editor in the app had.
    padding: "0 0 0 8px",
  },
  ".cm-scroller": {
    fontFamily: `var(--tedi-mono-font, ${MONO_FONT_CSS_FALLBACK})`,
    // Same var the main editor reads, so an extension's editor can't disagree
    // with it about whether `=>` renders as an arrow.
    fontVariantLigatures: "var(--tedi-editor-ligatures, none)",
    fontSize: "calc(var(--tedi-editor-font-size, 13px) * var(--content-zoom, 1))",
    lineHeight: "1.55",
    backgroundColor: "transparent !important",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    backgroundColor: "transparent !important",
    paddingLeft: "0",
    marginLeft: "0",
  },
  ".cm-line": {
    paddingLeft: "4px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background) !important",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border) !important",
    marginRight: "0 !important",
    zIndex: "3",
  },
  ".cm-gutter": { backgroundColor: "transparent !important" },
  ".cm-lineNumbers": { minWidth: "32px" },
  ".cm-lineNumbers .cm-gutterElement": { opacity: "0.55", padding: "0 8px", textAlign: "right" },
  // Same chevron as the editor pane, but it stays visible instead of appearing
  // on hover: this editor is mostly a read-only JSON/response viewer, where a
  // collapsible object is only useful if you can see it is collapsible. A
  // COLLAPSED marker goes full strength, which is the editor pane's rule too.
  ".cm-foldGutter": { width: "14px" },
  ".cm-foldGutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    cursor: "pointer",
  },
  ".cm-foldGutter .cm-foldMarker": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    opacity: "0.55",
    transition: "opacity 120ms ease, color 120ms ease",
  },
  ".cm-foldGutter .cm-foldMarker:not(.cm-foldMarker-open)": {
    opacity: "1",
    color: "var(--foreground)",
  },
  ".cm-foldGutter .cm-gutterElement:hover .cm-foldMarker": {
    opacity: "1",
    color: "var(--foreground)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",
    color: "var(--muted-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0",
    padding: "0 4px",
    margin: "0 2px",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 6%, transparent)",
    color: "var(--foreground)",
  },
  // `!important` + both selectors on purpose: CodeMirror's own base theme
  // styles the drawn selection through a 5-class selector
  // (`&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`),
  // and this editor is not tagged dark, so its light default (#d7d4f0) used to
  // win and paint an opaque pale block over dark-theme text. Same rule the main
  // editor pane carries.
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 18%, transparent) !important",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--card, var(--background))",
    border: "1px solid var(--border)",
    color: "var(--foreground)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    borderRadius: "6px",
    overflow: "hidden",
    boxShadow: "0 8px 20px rgba(0,0,0,0.18)",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono, ui-monospace, 'JetBrains Mono', monospace)",
    fontSize: "12px",
    maxHeight: "240px",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    padding: "4px 10px",
    color: "var(--foreground)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent, rgba(127,127,127,0.18))",
    color: "var(--foreground)",
  },
  ".cm-tooltip-autocomplete .cm-completionLabel": {
    color: "var(--foreground)",
  },
  ".cm-tooltip-autocomplete .cm-completionDetail": {
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    marginLeft: "12px",
  },
  ".cm-tooltip-autocomplete .cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--primary, #3b82f6)",
    fontWeight: "600",
  },
  ".cm-tooltip-autocomplete .cm-completionIcon": {
    opacity: "0.7",
    width: "14px",
    paddingRight: "4px",
  },
});

/** The user's editor theme, or the token-derived palette until its chunk lands
 *  (themes are dynamic imports). Both are highlighters, so they live in ONE
 *  compartment: CodeMirror unions the classes of every active highlighter, and
 *  two of them fight over each tag. */
function highlightExtFor(id: EditorThemeId): Extension {
  return tryEditorTheme(id) ?? syntaxHighlighting(tediHighlightStyle);
}

export function mountCodeEditor(container: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle {
  const langCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const themeId = usePreferencesStore.getState().editorTheme;

  const onCmdEnter = opts.onCmdEnter;
  const cmdEnterKeymap: Extension = onCmdEnter
    ? keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            try {
              onCmdEnter();
            } catch (err) {
              console.error("[extensions] codeEditor onCmdEnter threw", err);
            }
            return true;
          },
        },
      ])
    : [];

  // Optional extension-driven completions. Source returns suggestions
  // synchronously based on the current word prefix; the closure is held
  // for the lifetime of the editor so the extension can mutate its own
  // backing data (e.g. populate a schema cache) and the next keystroke
  // sees the new state. `explicit` (Ctrl+Space) bypasses the empty-word
  // guard so the user can probe completions on a fresh line.
  const completionsCb = opts.completions;
  const completionExtension: Extension = completionsCb
    ? autocompletion({
        override: [
          (context: CompletionContext): CompletionResult | null => {
            const word = context.matchBefore(/[\w]+/);
            if (!word || (word.from === word.to && !context.explicit)) return null;
            let items: CodeEditorCompletion[] = [];
            try {
              items = completionsCb(word.text) ?? [];
            } catch (err) {
              console.error("[extensions] codeEditor completions threw", err);
              return null;
            }
            if (items.length === 0) return null;
            const options: Completion[] = items.map((it) => ({
              label: it.label,
              detail: it.detail,
              info: it.info,
              type: it.type,
              apply: it.apply,
              boost: it.boost,
            }));
            return { from: word.from, options, validFor: /^[\w]*$/ };
          },
        ],
        // No icons by default; we already get type-based glyph from CM.
        // `closeOnBlur` keeps the popup visible when the user clicks the
        // results pane, matching IDE expectations.
        closeOnBlur: true,
        maxRenderedOptions: 50,
      })
    : [];

  const state = EditorState.create({
    doc: opts.value ?? "",
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      // Collapsible objects/arrays for the languages whose parser reports fold
      // ranges (json, javascript). `plain` and the SQL stream modes report none,
      // so their gutter column simply stays empty. Works in readOnly editors:
      // a fold is state, not a document change. The marker is the editor pane's
      // own chevron, not CodeMirror's default text glyphs, so a fold arrow looks
      // the same wherever it appears.
      foldGutter({ markerDOM: makeFoldMarker }),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
      cmdEnterKeymap,
      completionExtension,
      themeCompartment.of(highlightExtFor(themeId)),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      langCompartment.of(pickLanguage(opts.language)),
      readOnlyCompartment.of(EditorState.readOnly.of(opts.readOnly ?? false)),
      baseTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && opts.onChange) {
          try {
            opts.onChange(update.state.doc.toString());
          } catch (err) {
            console.error("[extensions] codeEditor onChange threw", err);
          }
        }
      }),
    ],
  });

  const view = new EditorView({ state, parent: container });

  // Follow the editor pane: load the chosen theme if its chunk is not in yet,
  // and swap when the user picks another one in Settings. Guarded against a
  // late load landing on a disposed view.
  let alive = true;
  const applyTheme = (id: EditorThemeId) => {
    view.dispatch({ effects: themeCompartment.reconfigure(highlightExtFor(id)) });
    if (tryEditorTheme(id)) return;
    void loadEditorTheme(id).then((ext) => {
      if (!alive || usePreferencesStore.getState().editorTheme !== id) return;
      view.dispatch({ effects: themeCompartment.reconfigure(ext) });
    });
  };
  if (!tryEditorTheme(themeId)) applyTheme(themeId);
  const unsubTheme = usePreferencesStore.subscribe((s, prev) => {
    if (s.editorTheme !== prev.editorTheme) applyTheme(s.editorTheme);
  });

  return {
    setValue(value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    },
    getValue() {
      return view.state.doc.toString();
    },
    getSelection() {
      const { from, to } = view.state.selection.main;
      return from === to ? "" : view.state.sliceDoc(from, to);
    },
    getCursor() {
      return view.state.selection.main.head;
    },
    focus() {
      view.focus();
    },
    setLanguage(language) {
      view.dispatch({
        effects: langCompartment.reconfigure(pickLanguage(language)),
      });
    },
    dispose() {
      alive = false;
      unsubTheme();
      try {
        view.destroy();
      } catch {
        // ignore
      }
    },
  };
}
