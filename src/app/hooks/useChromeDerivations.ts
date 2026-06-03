import { type EditorPaneHandle } from "@/modules/editor";
import { type SearchTarget } from "@/modules/header";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setLineWrap } from "@/modules/settings/store";
import { activeLeaf, type PaneTab, type Tab } from "@/modules/tabs";
import { type TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import { useMemo, type RefObject } from "react";

/** Toggle descriptor for the Header's markdown-preview / word-wrap buttons. */
type HeaderToggle = { active: boolean; toggle: () => void } | null;

type Params = {
  isTerminalLike: boolean;
  isEditorLike: boolean;
  activeSearchAddon: SearchAddon | null;
  activeEditorHandle: EditorPaneHandle | null;
  activeLeafIdInTab: number | null;
  activePaneTab: PaneTab | null;
  activeTab: Tab | undefined;
  mdPreviewLeafIds: ReadonlySet<number>;
  toggleMdPreviewForLeaf: (leafId: number) => void;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * Derived values for the chrome (Header search box, md-preview/word-wrap
 * toggles, StatusBar cwd + breadcrumb). All are pure memos over the active
 * leaf/tab; moved verbatim from App with identical dependency arrays. `lineWrap`
 * is read from preferences here since only these toggles use it.
 */
export function useChromeDerivations({
  isTerminalLike,
  isEditorLike,
  activeSearchAddon,
  activeEditorHandle,
  activeLeafIdInTab,
  activePaneTab,
  activeTab,
  mdPreviewLeafIds,
  toggleMdPreviewForLeaf,
  terminalRefs,
}: Params): {
  searchTarget: SearchTarget;
  mdPreviewToggle: HeaderToggle;
  lineWrapToggle: HeaderToggle;
  activeCwd: string | null;
  activeFilePath: string | null;
} {
  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalLike && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => {
          if (activeLeafIdInTab !== null) terminalRefs.current.get(activeLeafIdInTab)?.focus();
        },
      };
    if (isEditorLike && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    return null;
  }, [isTerminalLike, isEditorLike, activeLeafIdInTab, activeSearchAddon, activeEditorHandle]);

  /** Markdown-preview toggle for the Header. Non-null only when the active leaf is an editor on a `.md`/`.markdown`/`.mdx` file. */
  const mdPreviewToggle = useMemo<HeaderToggle>(() => {
    if (!isEditorLike || activeLeafIdInTab === null || !activePaneTab) {
      return null;
    }
    const leaf = activeLeaf(activePaneTab);
    if (!leaf || leaf.leafKind !== "editor") return null;
    if (!/\.(md|markdown|mdx)$/i.test(leaf.path)) return null;
    const leafId = activeLeafIdInTab;
    return {
      active: mdPreviewLeafIds.has(leafId),
      toggle: () => toggleMdPreviewForLeaf(leafId),
    };
  }, [isEditorLike, activeLeafIdInTab, activePaneTab, mdPreviewLeafIds, toggleMdPreviewForLeaf]);

  /** Word-wrap toggle for the Header. Non-null when the active leaf is an editor and not in markdown preview. */
  const lineWrap = usePreferencesStore((s) => s.lineWrap);
  const lineWrapToggle = useMemo<HeaderToggle>(() => {
    if (!isEditorLike || activeLeafIdInTab === null || !activePaneTab) {
      return null;
    }
    const leaf = activeLeaf(activePaneTab);
    if (!leaf || leaf.leafKind !== "editor") return null;
    if (mdPreviewLeafIds.has(activeLeafIdInTab)) return null;
    return {
      active: lineWrap,
      toggle: () => void setLineWrap(!lineWrap),
    };
  }, [isEditorLike, activeLeafIdInTab, activePaneTab, mdPreviewLeafIds, lineWrap]);

  const activeCwd = useMemo(() => {
    if (!activePaneTab) return null;
    const leaf = activeLeaf(activePaneTab);
    return leaf?.leafKind === "terminal" ? (leaf.cwd ?? null) : null;
  }, [activePaneTab]);

  // Absolute local path of the file currently being viewed. Drives the
  // status-bar breadcrumb and the file-explorer "reveal" behavior, so it
  // must cover every tab kind that has a workspace file backing it:
  // editor leaf, AI-proposed diff, and git diff. SSH editor leaves are
  // excluded - their `path` is remote and would never match the local
  // explorer root.
  const activeFilePath = useMemo<string | null>(() => {
    if (!activeTab) return null;
    if (activeTab.kind === "ai-diff" || activeTab.kind === "git-diff") {
      return activeTab.path;
    }
    if (activeTab.kind === "pane") {
      const leaf = activeLeaf(activeTab);
      if (leaf?.leafKind === "editor" && !leaf.sshSessionId) return leaf.path;
    }
    return null;
  }, [activeTab]);

  return { searchTarget, mdPreviewToggle, lineWrapToggle, activeCwd, activeFilePath };
}
