import { EditorView } from "@codemirror/view";
import { VAR_ADDED } from "./diffColors";

/**
 * Shared by both diff panes (AI proposed-edit and Git side-by-side), so they
 * cannot drift apart.
 *
 * Replaces `@codemirror/merge`'s default 2px gradient underline with a block
 * background: on a pure insertion the underline read as decoration rather than
 * as changed text. The tint comes from the EDITOR-owned var (`diffColors.ts`), not an app
 * theme token, so it follows the code theme. MergeView's outer scroll wiring
 * stays in `globals.css` (`.cm-mergeView`), which `EditorView.theme` cannot
 * reach.
 */
export const DIFF_THEME = EditorView.theme({
  ".cm-changedText": {
    background: `color-mix(in srgb, var(${VAR_ADDED}) 18%, transparent) !important`,
  },
});
