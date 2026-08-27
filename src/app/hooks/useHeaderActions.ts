import { registerBridge } from "@/modules/automation/bridge";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { listConnections, type SshConnection } from "@/modules/ssh/connections";
import { MAX_PANES_PER_TAB, type PaneTab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
import { useCallback, useEffect, useMemo } from "react";
import { type TabsApi } from "./tabsApi";

type Params = {
  activePaneTab: PaneTab | null;
  detectedBrowserUrl: string | null;
  openPreviewTab: (url: string) => number | null;
  handleClose: (id: number) => void;
  requestCloseLeaf: (leafId: number) => void;
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
  // SSH, for a driving agent. Saved connections are the one main feature with
  // NO command id - the 38 registered ids have no `ssh.*` at all - so
  // `run_command` could never reach them and an outside CLI could see an SSH
  // pane in `state` without being able to open one. Opening a connection needs
  // `newSshTab`, which is App-level and not importable, so the registration
  // lives here beside it. Gated on `TEDI_DEBUG_PORT` and MERGED into
  // `window.__tedi`, never assigned (see `shortcuts/lib/commandRegistry.ts`).
  //
  // Secrets never pass through: `listConnections` returns the saved profiles,
  // whose keys and passphrases live in the keyring behind `getConnectionSecrets`,
  // which is deliberately NOT exposed here.
  useEffect(() => {
    registerBridge({
      sshConnections: async () =>
        (await listConnections()).map((c) => ({
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          user: c.user,
          authMode: c.authMode,
        })),
      sshConnect: async (id: string, isPrivate = false) => {
        const conn = (await listConnections()).find((c) => c.id === id);
        if (!conn) return `No saved SSH connection "${id}"`;
        newSshTab(conn.id, conn.name, isPrivate ? { private: true } : undefined);
        return true;
      },
    });
  }, [newSshTab]);

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
    handleHeaderPinLeaf,
    handleHeaderOpenExtensions,
    handleHeaderOpenSettings,
    handleHeaderConnectSsh,
    headerCanSplit,
  };
}
