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
import {
  HighlightStyle,
  StreamLanguage,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { mySQL, pgSQL, sqlite, standardSQL } from "@codemirror/legacy-modes/mode/sql";
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
  | "sql"
  | "sql:mysql"
  | "sql:postgres"
  | "sql:sqlite"
  | "json"
  | "plain";

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
      // JSON via legacy JS mode keeps the dependency footprint tiny.
      // Callers wanting strict JSON parsing should switch to lang-json.
      return [];
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
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "12px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, 'JetBrains Mono', monospace)",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    padding: "8px 0",
  },
  ".cm-gutters": {
    backgroundColor: "var(--card, var(--background))",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 6%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary, #3b82f6) 25%, transparent)",
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

export function mountCodeEditor(container: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle {
  const langCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

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
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      cmdEnterKeymap,
      completionExtension,
      syntaxHighlighting(tediHighlightStyle),
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

  return {
    setValue(value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    },
    getValue() {
      return view.state.doc.toString();
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
      try {
        view.destroy();
      } catch {
        // ignore
      }
    },
  };
}
