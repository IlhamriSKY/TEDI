import { type EditorPaneHandle } from "@/modules/editor";
import { type SearchTarget } from "@/modules/header";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setLineWrap } from "@/modules/settings/store";
import { activeLeaf, type PaneTab, type Tab } from "@/modules/tabs";
import { isRemoteEditorLeaf, type TerminalPaneHandle } from "@/modules/terminal";
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
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  /** Local workspace root. The StatusBar breadcrumb falls back to it for local
   *  terminals before OSC 7 lands, but never for an SSH leaf (a local path
   *  under a remote shell would be misleading). */
  explorerRoot: string | null;
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
  terminalRefs,
  explorerRoot,
}: Params): {
  searchTarget: SearchTarget;
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

  /** Word-wrap toggle for the Header. Non-null when the active leaf is an editor and not in markdown preview.
   *  (The markdown source/preview toggle used to live here too; it now sits in
   *  the pane's own header, next to the float button, in `PaneTreeView`.) */
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
    if (!activePaneTab) return explorerRoot;
    const leaf = activeLeaf(activePaneTab);
    if (leaf?.leafKind !== "terminal") return explorerRoot;
    // SSH terminal: follow the remote shell's cwd (reported via OSC 7). Never
    // fall back to the local explorer root - a Windows path under a remote
    // shell is wrong. Null (-> "no directory") until the remote reports one.
    // Note: keys off the saved-profile id; a rare ad-hoc SSH leaf (no
    // profile) would still show the local root. Widen to live session state if
    // that case matters.
    if (leaf.sshConnectionId) return leaf.cwd ?? null;
    // Local terminal: its own cwd, or the workspace root before OSC 7 lands.
    return leaf.cwd ?? explorerRoot;
  }, [activePaneTab, explorerRoot]);

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
      if (leaf?.leafKind === "editor" && !isRemoteEditorLeaf(leaf)) return leaf.path;
    }
    return null;
  }, [activeTab]);

  return { searchTarget, lineWrapToggle, activeCwd, activeFilePath };
}
