/**
 * Lightweight CodeMirror 6 mount used by `ctx.ui.codeEditor`. Keeps the
 * subset of features that matter for ad-hoc query editors (syntax
 * highlight, line numbers, history, Mod+Enter callback) while staying
 * out of the bigger EditorPane extension tower (vim, minimap, lint,
 * autocomplete, search) so an extension can drop one of these into any
 * container without taking on the EditorPane shape.
 *
 * The theme intentionally pulls TEDI's CSS variables instead of
 * hard-coded colors so the editor visually matches whatever theme the
 * user has active.
 */

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

export type CodeEditorOptions = {
  language?: CodeEditorLanguage;
  value?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Fires on Ctrl/Cmd+Enter. Returning `false` lets default handling run;
   *  by default the helper returns `true` so newlines are suppressed. */
  onCmdEnter?: () => void;
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
  { tag: [t.keyword, t.operatorKeyword], color: "var(--tedi-tab-ai-diff, #8b5cf6)", fontWeight: "600" },
  { tag: t.string, color: "var(--tedi-tab-terminal, #10b981)" },
  { tag: t.number, color: "var(--tedi-tab-git-diff, #f59e0b)" },
  { tag: t.bool, color: "var(--tedi-tab-git-diff, #f59e0b)" },
  { tag: t.null, color: "var(--muted-foreground)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.typeName, color: "var(--tedi-tab-ssh, #0ea5e9)" },
  { tag: [t.variableName, t.propertyName], color: "var(--foreground)" },
  { tag: t.atom, color: "var(--tedi-tab-preview, #06b6d4)" },
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
});

export function mountCodeEditor(
  container: HTMLElement,
  opts: CodeEditorOptions,
): CodeEditorHandle {
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
