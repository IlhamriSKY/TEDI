import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { type SshConnection } from "@/modules/ssh/connections";
import { MAX_PANES_PER_TAB, type PaneTab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import { type TabsApi } from "./tabsApi";

type Params = {
  activePaneTab: PaneTab | null;
  detectedBrowserUrl: string | null;
  openPreviewTab: (url: string) => number | null;
  handleClose: (id: number) => void;
  requestCloseLeaf: (leafId: number) => void;
  setNewEditorOpen: Dispatch<SetStateAction<boolean>>;
} & Pick<TabsApi, "setActiveId" | "focusPane" | "pinTab" | "newSshTab">;

/**
 * Stable handlers for the memoised `<Header/>`. Each was previously an inline
 * arrow in the JSX, so the memo wrapper saw a fresh prop identity on every App
 * re-render. Bundled here verbatim with identical dependency arrays;
 * `handleClose` / `openPreviewTab` / `detectedBrowserUrl` are threaded in from
 * App.
 */
export function useHeaderActions({
  activePaneTab,
  detectedBrowserUrl,
  openPreviewTab,
  handleClose,
  requestCloseLeaf,
  setNewEditorOpen,
  setActiveId,
  focusPane,
  pinTab,
  newSshTab,
}: Params): {
  handleOpenDetectedPreview: () => void;
  handleAddProviderKey: () => void;
  handleHeaderSelectEntry: (tabId: number, leafId: number | null) => void;
  handleHeaderCloseEntry: (tabId: number, leafId: number | null) => void;
  handleHeaderNewPreview: () => void;
  handleHeaderNewEditor: () => void;
  handleHeaderPinLeaf: (tabId: number, leafId: number) => void;
  handleHeaderOpenExtensions: () => void;
  handleHeaderOpenSettings: () => void;
  handleHeaderConnectSsh: (conn: SshConnection, opts?: { private?: boolean }) => void;
  headerCanSplit: boolean;
} {
  const handleOpenDetectedPreview = useCallback(() => {
    if (detectedBrowserUrl) openPreviewTab(detectedBrowserUrl);
  }, [detectedBrowserUrl, openPreviewTab]);
  const handleAddProviderKey = useCallback(() => void openSettingsWindow("models"), []);

  const handleHeaderSelectEntry = useCallback(
    (tabId: number, leafId: number | null) => {
      setActiveId(tabId);
      if (leafId !== null) focusPane(tabId, leafId);
    },
    [setActiveId, focusPane],
  );
  const handleHeaderCloseEntry = useCallback(
    (tabId: number, leafId: number | null) => {
      if (leafId !== null) {
        requestCloseLeaf(leafId);
      } else {
        handleClose(tabId);
      }
    },
    [requestCloseLeaf, handleClose],
  );
  const handleHeaderNewPreview = useCallback(() => openPreviewTab(""), [openPreviewTab]);
  const handleHeaderNewEditor = useCallback(() => setNewEditorOpen(true), []);
  const handleHeaderPinLeaf = useCallback(
    (tabId: number, leafId: number) => {
      focusPane(tabId, leafId);
      pinTab(tabId);
    },
    [focusPane, pinTab],
  );
  const handleHeaderOpenExtensions = useCallback(() => void openSettingsWindow("extensions"), []);
  const handleHeaderOpenSettings = useCallback(() => void openSettingsWindow(), []);
  const handleHeaderConnectSsh = useCallback(
    (conn: SshConnection, opts?: { private?: boolean }) => newSshTab(conn.id, conn.name, opts),
    [newSshTab],
  );
  const headerCanSplit = useMemo(
    () => activePaneTab !== null && leafIds(activePaneTab.paneTree).length < MAX_PANES_PER_TAB,
    [activePaneTab],
  );

  return {
    handleOpenDetectedPreview,
    handleAddProviderKey,
    handleHeaderSelectEntry,
    handleHeaderCloseEntry,
    handleHeaderNewPreview,
    handleHeaderNewEditor,
    handleHeaderPinLeaf,
    handleHeaderOpenExtensions,
    handleHeaderOpenSettings,
    handleHeaderConnectSsh,
    headerCanSplit,
  };
}
