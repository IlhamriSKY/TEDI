import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { EditorThemeId } from "@/modules/settings/store";

/** Per-theme dynamic loaders. Each `@uiw/codemirror-theme-*` is ~10-25 KB;
 *  eagerly importing all 9 added ~100 KB. Returns the CodeMirror Extension
 *  for `state.create({ extensions })`. */
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

/** Async theme loader. Result is cached so panes share one Extension. */
export async function loadEditorTheme(id: EditorThemeId): Promise<Extension> {
  const hit = themeCache.get(id);
  if (hit) return hit;
  const ext = await (LOADERS[id] ?? LOADERS.atomone)();
  themeCache.set(id, ext);
  return ext;
}

/** Sync accessor. Returns the loaded Extension or null. Callers fall back
 *  to `loadEditorTheme` when null. */
export function tryEditorTheme(id: EditorThemeId): Extension | null {
  return themeCache.get(id) ?? null;
}

/**
 * The current editor theme as a CodeMirror Extension, for a pane that renders
 * one. Returns the cached Extension immediately when there is one, so switching
 * back to a theme already loaded does not flash unstyled, and otherwise null
 * until the dynamic import lands.
 *
 * Every pane that shows an editor wants exactly this, so it lives beside the
 * loaders rather than being rebuilt per pane.
 */
export function useEditorTheme(): Extension | null {
  const id = usePreferencesStore((s) => s.editorTheme);
  const [themeExt, setThemeExt] = useState<Extension | null>(() => tryEditorTheme(id));

  useEffect(() => {
    const cached = tryEditorTheme(id);
    if (cached) {
      setThemeExt(cached);
      return;
    }
    let cancelled = false;
    void loadEditorTheme(id).then((ext) => {
      if (!cancelled) setThemeExt(ext);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return themeExt;
}
