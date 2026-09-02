import { Vim } from "@replit/codemirror-vim";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export type VimHandlers = { save: () => void; close: () => void };

const handlers = new WeakMap<EditorView, VimHandlers>();

/** CodeMirror extension binding :w / :q handlers to this view. */
export function vimHandlersExtension(getHandlers: () => VimHandlers): Extension {
  return ViewPlugin.define((view) => {
    handlers.set(view, getHandlers());
    return {
      update() {
        // Refresh handlers so closures don't hold stale refs.
        handlers.set(view, getHandlers());
      },
      destroy() {
        handlers.delete(view);
      },
    };
  });
}

let initialized = false;

export function initVimGlobals(): void {
  if (initialized) return;
  initialized = true;

  type CmAdapter = { cm6?: EditorView };
  const getView = (cm: CmAdapter) => cm.cm6;

  Vim.defineEx("write", "w", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) handlers.get(view)?.save();
  });

  Vim.defineEx("quit", "q", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) handlers.get(view)?.close();
  });

  Vim.defineEx("wq", "wq", (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = handlers.get(view);
    h?.save();
    h?.close();
  });

  Vim.defineEx("xit", "x", (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = handlers.get(view);
    h?.save();
    h?.close();
  });

  // Arrow keys would forward to editor-scope handlers, breaking
  // operator-pending (d<Up>) and counts (15<Up>). Remap to hjkl so
  // they stay inside the vim state machine.
  Vim.map("<Up>", "k", "normal");
  Vim.map("<Down>", "j", "normal");
  Vim.map("<Left>", "h", "normal");
  Vim.map("<Right>", "l", "normal");
  Vim.map("<Up>", "k", "visual");
  Vim.map("<Down>", "j", "visual");
  Vim.map("<Left>", "h", "visual");
  Vim.map("<Right>", "l", "visual");
}

/**
 * True when real keyboard focus sits inside an editor that has vim mode on.
 *
 * Keyed off REAL focus, not the active leaf: with an editor leaf active but
 * focus in the explorer, the AI composer or a dialog, the app chords must still
 * fire. `data-vim-mode` is set by `EditorPane`.
 */
export function isVimEditorFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest('[data-vim-mode="on"]');
}
