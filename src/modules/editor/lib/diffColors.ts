/**
 * Editor-owned diff tint colors.
 *
 * The diff views (Git side-by-side + AI proposed-edit) belong to the EDITOR
 * theme domain, not the app chrome. Their inline added/removed tint follows the
 * selected `editorTheme` rather than the app's custom theme. CodeMirror's
 * `@uiw` themes don't expose a canonical diff green/red, so we map each editor
 * theme to a matched pair and write them to `--tedi-editor-diff-added` /
 * `--tedi-editor-diff-removed`, which the diff panes consume.
 *
 * globals.css defaults these vars to the app `--tedi-diff-*` so the first paint
 * (before this runs) is unchanged; `applyEditorDiffColors` then snaps them to
 * the editor theme's pair.
 */
import type { EditorThemeId } from "@/modules/settings/store";

type DiffPair = { added: string; removed: string };

/** Per-editor-theme inline diff tint. Used at low alpha so the exact hue is
 *  forgiving; values track each theme's syntax green/red. */
const EDITOR_DIFF_COLORS: Record<EditorThemeId, DiffPair> = {
  atomone: { added: "#98c379", removed: "#e06c75" },
  aura: { added: "#61ffca", removed: "#ff6767" },
  copilot: { added: "#57ab5a", removed: "#f47067" },
  "github-dark": { added: "#3fb950", removed: "#f85149" },
  "github-light": { added: "#1a7f37", removed: "#cf222e" },
  nord: { added: "#a3be8c", removed: "#bf616a" },
  "tokyo-night": { added: "#9ece6a", removed: "#f7768e" },
  "xcode-dark": { added: "#6cc644", removed: "#ff8170" },
  "xcode-light": { added: "#1c8c3c", removed: "#d12f1b" },
};

const VAR_ADDED = "--tedi-editor-diff-added";
const VAR_REMOVED = "--tedi-editor-diff-removed";

/** Write the editor theme's diff tint onto `:root`. Idempotent. */
export function applyEditorDiffColors(id: EditorThemeId): void {
  if (typeof document === "undefined") return;
  const pair = EDITOR_DIFF_COLORS[id] ?? EDITOR_DIFF_COLORS.atomone;
  const root = document.documentElement;
  root.style.setProperty(VAR_ADDED, pair.added);
  root.style.setProperty(VAR_REMOVED, pair.removed);
}
