import type { Extension } from "@codemirror/state";
import type { EditorThemeId } from "@/modules/settings/store";

/** Per-theme dynamic loaders. Each `@uiw/codemirror-theme-*` package is
 *  ~10–25 KB minified; eagerly importing all 9 added ~100 KB to the editor
 *  bundle for code paths that only ever use one. The loader returns the
 *  CodeMirror `Extension` that we feed into `state.create({ extensions })`. */
const LOADERS: Record<EditorThemeId, () => Promise<Extension>> = {
  atomone: () => import("@uiw/codemirror-theme-atomone").then((m) => m.atomone),
  aura: () => import("@uiw/codemirror-theme-aura").then((m) => m.aura),
  copilot: () => import("@uiw/codemirror-theme-copilot").then((m) => m.copilot),
  "github-dark": () => import("@uiw/codemirror-theme-github").then((m) => m.githubDark),
  "github-light": () => import("@uiw/codemirror-theme-github").then((m) => m.githubLight),
  nord: () => import("@uiw/codemirror-theme-nord").then((m) => m.nord),
  "tokyo-night": () => import("@uiw/codemirror-theme-tokyo-night").then((m) => m.tokyoNight),
  "xcode-dark": () => import("@uiw/codemirror-theme-xcode").then((m) => m.xcodeDark),
  "xcode-light": () => import("@uiw/codemirror-theme-xcode").then((m) => m.xcodeLight),
};

const themeCache = new Map<EditorThemeId, Extension>();

/** Async theme loader. Result is cached so theme switches re-use the same
 *  Extension instance across editor panes. */
export async function loadEditorTheme(id: EditorThemeId): Promise<Extension> {
  const hit = themeCache.get(id);
  if (hit) return hit;
  const ext = await (LOADERS[id] ?? LOADERS.atomone)();
  themeCache.set(id, ext);
  return ext;
}

/** Synchronous accessor - returns the loaded Extension if available, else
 *  null. Callers (e.g. EditorPane) use this for the cheap fast path on
 *  re-renders and fall back to `loadEditorTheme` when null. */
export function tryEditorTheme(id: EditorThemeId): Extension | null {
  return themeCache.get(id) ?? null;
}
