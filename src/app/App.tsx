/**
 * App.tsx - the main-window top-level COORDINATOR (not a feature dump).
 *
 * App's job is to own the shared runtime state (the per-leaf handle maps, the
 * sidebar/right-aux hider latches, the workspace live-tab cache) and to compose
 * the domain hooks + layout components that implement each behavior. Features
 * themselves live in src/modules/<area>/; the wiring lives in the domain hooks
 * under src/app/hooks/ and the render tree in src/app/components/.
 *
 * Where behaviors are set up (each is its own hook unless noted):
 *   - useWorkspaceRoot         - home / picked root + `tedi <path>` CLI targets
 *   - useAiBootstrap           - API keys, model restore/persist, store hydration
 *   - useExtensionPanelDefaults- extension boot + right-panel defaults
 *   - useWorkspacePersistence  - hydrate + auto-snapshot workspaces
 *   - useQuitGuard             - pre-quit snapshot flush + busy-terminal prompt
 *   - useWorkspaceSwitching    - switch / create / close orchestration
 *   - useRightPanelExclusion   - SCM / AI / extension right-slot mutual exclusion
 *   - useExtensionSidebarBridges - tabs/sidebar host bridges + auto-restore
 *   - useEditorBridge / useAgentBridges - ctx.editor + AI live-context + scheduler
 *   - useActiveLeafSurface     - active leaf search addon / URL / editor handle
 *   - useSelectionAskAi        - the "Ask AI about selection" popup
 *   - useSessionDisposal       - PTY/xterm teardown by pane tree
 *   - useChromeDerivations     - Header/StatusBar derived values
 *   - useTabSideEffects        - ai-diff reload, open-file chips, tab counts
 * Layout: AppSidebar / WorkspaceArea / AppRightSlot / AppDialogs.
 *
 * See ARCHITECTURE.md for the two-process model and TEDI.md for full detail.
 */
import { pathToFileUrl } from "@/lib/path";
import { ResizableHandle, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentRunBridge, hasAnyKey, useChatStore } from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { useRightPanelStore, useSidebarPlacementStore } from "@/modules/extensions";
import { type EditorPaneHandle } from "@/modules/editor";
import { Header, type SearchInlineHandle } from "@/modules/header";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import { useSshRightPanelStore } from "@/modules/ssh/sshRightPanelStore";
import {
  isTerminalControlChord,
  isTerminalMetaChord,
  useExtensionShortcuts,
  useGlobalShortcuts,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";
import { StatusBar } from "@/modules/statusbar";
import {
  activeLeaf,
  activeLeafKind,
  isEditorLikeTab,
  isTerminalLikeTab,
  useTabs,
  useWorkspaceCwd,
  type Tab,
} from "@/modules/tabs";
import {
  acknowledgeAiCli,
  ensureFsDragListener,
  focusedTerminalLeafId,
  leaves,
  useTerminalFileDrop,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { useCliAgentsStore } from "@/modules/terminal/lib/cliAgents";
import { ThemeProvider } from "@/modules/theme";
import { listConnections, type SshConnection } from "@/modules/ssh/connections";
import { setSshConnectionBridge } from "@/modules/extensions/sshBridge";
import { setWorkspaceMgmtBridge } from "@/modules/extensions/workspaceMgmtBridge";
import { useWorkspacesStore } from "@/modules/workspaces";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { buildShortcutHandlers } from "./lib/shortcutHandlers";
import { useApplyZoom } from "./hooks/useApplyZoom";
import { useRightPanelExclusion } from "./hooks/useRightPanelExclusion";
import { useDockedSectionAutoOpen } from "./hooks/useDockedSectionAutoOpen";
import { useExtensionSidebarBridges } from "./hooks/useExtensionSidebarBridges";
import { useWorkspaceSwitching } from "./hooks/useWorkspaceSwitching";
import { useSshLeafState } from "./hooks/useSshLeafState";
import { useAppContextBridge } from "./hooks/useAppContextBridge";
import { usePaneHandles } from "./hooks/usePaneHandles";
import { useEditorFileDrop } from "./hooks/useEditorFileDrop";
import { useTabActions } from "./hooks/useTabActions";
import { useFileActions } from "./hooks/useFileActions";
import { useHeaderActions } from "./hooks/useHeaderActions";
import { useWorkspaceRoot } from "./hooks/useWorkspaceRoot";
import { useAiBootstrap } from "./hooks/useAiBootstrap";
import { useExtensionPanelDefaults } from "./hooks/useExtensionPanelDefaults";
import { useQuitGuard } from "./hooks/useQuitGuard";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useEditorBridge } from "./hooks/useEditorBridge";
import { useAgentBridges } from "./hooks/useAgentBridges";
import { useSelectionAskAi } from "./hooks/useSelectionAskAi";
import { useSessionDisposal } from "./hooks/useSessionDisposal";
import { useAdoptDaemonSessions } from "./hooks/useAdoptDaemonSessions";
import { useActiveLeafSurface } from "./hooks/useActiveLeafSurface";
import { useProjectUrl } from "./hooks/useProjectUrl";
import { useChromeDerivations } from "./hooks/useChromeDerivations";
import { useTabSideEffects } from "./hooks/useTabSideEffects";
import { CommandPalette } from "@/modules/commandPalette";
import { AppDialogs } from "./components/AppDialogs";
import { AppSidebar } from "./components/AppSidebar";
import { WorkspaceArea } from "./components/WorkspaceArea";
import { AppRightSlot } from "./components/AppRightSlot";

export default function App() {
  const isDevSession = import.meta.env.DEV;
  const {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newPaneGroupTab,
    newSshTab,
    openFileTab,
    pinTab,
    newBrowserTab,
    openExtensionTab,
    openExtensionPane,
    setExtensionTabState,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    openBoardTab,
    closeTab,
    selectByIndex,
    setLeafCwd,
    setBrowserLeafUrl,
    setBrowserLeafTitle,
    setLeafPtyId,
    setLeafActiveTool,
    setSplitSizes,
    setEditorLeafDirty,
    setEditorLeafPath,
    focusPane,
    focusNextPaneInTab,
    closePaneByLeaf,
    splitActivePane,
    moveLeafToTab,
    moveLeafToNewTab,
    rotateLeafSplit,
    replaceAllTabs,
    allocId,
    reorderTabs,
    reorderLeafInGroup,
    movePaneLeafToEdge,
    moveExtTabToPane,
    togglePrivate,
    setTabPinned,
    renameLeaf,
    setLeafTerminalTheme,
  } = useTabs();

  // Drop a file from the OS file manager onto a terminal pane to paste its
  // shell-quoted path. Tauri captures OS drops globally, so one listener
  // at the app root hit-tests the cursor.
  useTerminalFileDrop();

  // HTML5 drags from `[data-fs-path]` elements (sidebar tree, extension
  // panels via `ctx.ui.mountFolderTree`, etc.) populate dataTransfer at a
  // document-level capture listener. Bypasses React's per-root delegation
  // so drag sources from separate `createRoot` trees still work. Module
  // guard prevents double-attach.
  useEffect(() => {
    ensureFsDragListener();
  }, []);

  // Mirror `tabs` into a ref so deferred callbacks (e.g. cdInNewTab) read
  // the latest state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId), [tabs, activeId]);
  const activePaneTab = activeTab?.kind === "pane" ? activeTab : null;
  const isTerminalLike = activeTab ? isTerminalLikeTab(activeTab) : false;
  const isEditorLike = activeTab ? isEditorLikeTab(activeTab) : false;

  // Lazy-mount the diff/scm/ext stacks. Each chunk only loads once a tab of
  // that kind exists.
  const hasAiDiffTab = useMemo(() => tabs.some((t) => t.kind === "ai-diff"), [tabs]);
  const hasGitDiffTab = useMemo(() => tabs.some((t) => t.kind === "git-diff"), [tabs]);
  const hasScmTab = useMemo(() => tabs.some((t) => t.kind === "scm"), [tabs]);
  const hasExtensionTab = useMemo(() => tabs.some((t) => t.kind === "ext"), [tabs]);

  // Active leaf says what's focused in the current tab. Drives Search,
  // AI selection, CWD wiring, etc.
  const activeLeafIdInTab = activePaneTab?.activeLeafId ?? null;
  const activeLeafCurrent = activeTab ? activeLeaf(activeTab) : null;
  const activeLeafKindCurrent = activeTab ? activeLeafKind(activeTab) : null;

  // -------- shared runtime handles & state owned by the coordinator --------
  // These are read/written by several domain hooks and the layout components,
  // so they stay here and are threaded in. Single-consumer state lives inside
  // its owning hook instead (e.g. pendingClose in useTabActions).
  const searchAddons = useRef<Map<number, SearchAddon>>(undefined!);
  if (!searchAddons.current) searchAddons.current = new Map();
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(undefined!);
  if (!terminalRefs.current) terminalRefs.current = new Map();
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(undefined!);
  if (!editorRefs.current) editorRefs.current = new Map();
  const detectedUrls = useRef<Map<number, string>>(undefined!);
  if (!detectedUrls.current) detectedUrls.current = new Map();
  const [activeSearchAddon, setActiveSearchAddon] = useState<SearchAddon | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] = useState<EditorPaneHandle | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const [editingSshConn, setEditingSshConn] = useState<SshConnection | null>(null);
  const [sshEditorOpen, setSshEditorOpen] = useState(false);
  // Latches the first time each lazy dialog opens. Stays true; see the
  // dialog mount sites for why.
  const [sshEditorMounted, setSshEditorMounted] = useState(false);
  useEffect(() => {
    if (sshEditorOpen) setSshEditorMounted(true);
  }, [sshEditorOpen]);

  // `+` -> Agent...: the CLI-agent picker. Mount-once like the editor dialog so
  // the chunk loads on first open and Radix's exit animation still plays.
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentDialogMounted, setAgentDialogMounted] = useState(false);
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [newEditorMounted, setNewEditorMounted] = useState(false);
  useEffect(() => {
    if (agentDialogOpen) setAgentDialogMounted(true);
  }, [agentDialogOpen]);
  useEffect(() => {
    if (newEditorOpen) setNewEditorMounted(true);
  }, [newEditorOpen]);

  /**
   * Editor leaves currently shown as markdown preview instead of source.
   * Keyed by leaf id so split panes toggle independently. Stale entries
   * for closed leaves are harmless.
   */
  const [mdPreviewLeafIds, setMdPreviewLeafIds] = useState<ReadonlySet<number>>(() => new Set());
  const toggleMdPreviewForLeaf = useCallback((leafId: number) => {
    setMdPreviewLeafIds((curr) => {
      const next = new Set(curr);
      if (next.has(leafId)) next.delete(leafId);
      else next.add(leafId);
      return next;
    });
  }, []);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  // Tracks an ext-requested sidebar hide so we can auto-restore the user's
  // prior visibility when they switch off that extension's tab, and re-hide
  // when they switch back. Cleared on any manual toggle or when the
  // owning extension no longer has an open ext tab. Ref (not state) so the
  // bridge callback can mutate it without re-binding via setSidebarSetter.
  const sidebarHiderRef = useRef<{ extensionId: string; prior: boolean } | null>(null);
  // Exact twin of `sidebarHiderRef`, for the right column. It used to hold a
  // snapshot of WHICH surfaces were open, because hiding that column meant
  // closing them; the column collapses in its own right now, so all this has to
  // remember is the visibility to come back to.
  const rightSidebarHiderRef = useRef<{ extensionId: string; prior: boolean } | null>(null);
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    sidebarHiderRef.current = null;
    if (p.getSize().asPercentage <= 0) p.expand();
    else p.collapse();
  }, []);
  // Twin of `sidebarRef` for the right column, so it minimizes shut and back the
  // same way. Only the panel's own width moves: what is docked there, and each
  // section's own minimized state, are untouched, so a re-expand is exactly what
  // was hidden. Null while the column is empty - it renders no panel then, and
  // there is nothing to minimize.
  const rightSlotRef = useRef<PanelImperativeHandle | null>(null);
  const toggleRightSlot = useCallback(() => {
    const p = rightSlotRef.current;
    if (p) {
      if (p.getSize().asPercentage <= 0) p.expand();
      else p.collapse();
      return;
    }
    // Null means NOTHING is docked right, so the column renders no panel and
    // there is nothing to collapse. The sidebar always has content, so its
    // toggle never hits this; leaving the key dead here would be the asymmetry.
    // Read it as "show me the right column" and open the surface whose home it
    // is - unless the user has docked the AI panel to the left, in which case
    // opening it would put it on the wrong side and there is genuinely nothing
    // for this key to show.
    if (useSidebarPlacementStore.getState().placement.ai !== "left") {
      useChatStore.getState().openPanel();
    }
  }, []);

  // When the active workspace is closed, activeId is reassigned to a
  // neighbor. Skip the auto-snapshot for that transition so it doesn't
  // overwrite the neighbor's saved tabs with the closing workspace's
  // live tabs (still in `useTabs` until we rehydrate below). Shared by
  // useWorkspacePersistence (sets the skip) and useWorkspaceSwitching.
  const skipNextSnapshotRef = useRef(false);
  // In-memory cache of each workspace's live Tab[] (with leaf ids) so a
  // switch back restores the same terminal leaf ids and keeps PTY/xterm
  // sessions alive. `serializeTabs` still writes to disk for crash
  // recovery, but live state wins on switch. Shared by useWorkspaceSwitching
  // (writes) and useSessionDisposal (reads to keep cached leaves alive).
  const liveTabsByWorkspace = useRef<Map<string, { tabs: Tab[]; activeId: number | null }>>(
    undefined!,
  );
  if (!liveTabsByWorkspace.current) liveTabsByWorkspace.current = new Map();

  // -------- home / picked root + CLI targets --------
  const { home, pickedRoot, setPickedRoot, openWorkspaceFolder } = useWorkspaceRoot({
    tabs,
    activePaneTab,
    newTab,
    openFileTab,
  });

  // -------- AI / model boot + extension panel defaults --------
  // useAiBootstrap runs initPrefs; useExtensionPanelDefaults boots the
  // extension host, which must follow prefs - so it is called second.
  const { keysLoaded } = useAiBootstrap();
  useExtensionPanelDefaults();

  // Chat-store slices App still needs for render / mutual exclusion.
  const openMini = useChatStore((s) => s.openMini);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const hasComposer = hasAnyKey(apiKeys);

  // Preferences used by the chrome / layout.
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  const sourceControlInRightPanel = usePreferencesStore((s) => s.sourceControlInRightPanel);
  const sshInRightPanel = usePreferencesStore((s) => s.sshInRightPanel);
  const contentZoom = usePreferencesStore((s) => s.contentZoom);
  // UI zoom scales the chrome only (header / tabs, sidebar, side panels, status
  // bar) plus portaled overlays, which mount on `document.body` outside `#root`.
  // The workspace pane counter-zooms back to 1 (see WorkspaceArea) so terminal /
  // editor / preview keep native resolution and their own `--content-zoom`.
  const uiZoom = usePreferencesStore((s) => s.uiZoom);
  const autoOpenProjectUrl = usePreferencesStore((s) => s.autoOpenProjectUrl);
  // Apply --content-zoom (CSS var) and body.zoom from the prefs values.
  useApplyZoom(contentZoom, uiZoom);

  const scmRightOpen = useScmRightPanelStore((s) => s.open);
  const closeScmRight = useScmRightPanelStore((s) => s.closePanel);
  const sshRightOpen = useSshRightPanelStore((s) => s.open);
  const closeSshRight = useSshRightPanelStore((s) => s.closePanel);

  // Extension right-panels, SCM/SSH right panels and the AI sidebar all live in
  // the right column TOGETHER, stacked like the left sidebar's sections (see
  // AppRightSlot). This is the list of extension-owned ones.
  const rightPanels = useRightPanelStore((s) => s.panels);
  // Re-open a sidebar section docked to the right slot on boot (else it would
  // vanish: gone from the left sidebar, closed in the right).
  useDockedSectionAutoOpen();

  // CLI-agent roster for the `+` -> Agent submenu. Hydrated here (not in the
  // menu) so a Settings edit broadcast arrives even while the menu is closed.
  const hydrateCliAgents = useCliAgentsStore((s) => s.hydrate);
  useEffect(() => {
    void hydrateCliAgents();
  }, [hydrateCliAgents]);

  // -------- workspaces wiring --------
  const wsHydrate = useWorkspacesStore((s) => s.hydrate);
  const wsHydrated = useWorkspacesStore((s) => s.hydrated);
  const wsList = useWorkspacesStore((s) => s.workspaces);
  const wsActiveId = useWorkspacesStore((s) => s.activeId);
  const wsSetActive = useWorkspacesStore((s) => s.setActiveId);
  const wsCreate = useWorkspacesStore((s) => s.createWorkspace);
  const wsRemove = useWorkspacesStore((s) => s.removeWorkspace);
  const wsSaveTabs = useWorkspacesStore((s) => s.saveWorkspaceTabs);
  const wsFlush = useWorkspacesStore((s) => s.flush);

  useWorkspacePersistence({
    wsHydrate,
    wsHydrated,
    restoreTabsOnHydrate: !isDevSession,
    persistTabsSnapshot: !isDevSession,
    wsList,
    wsActiveId,
    wsSaveTabs,
    tabs,
    activeId,
    allocId,
    replaceAllTabs,
    skipNextSnapshotRef,
  });

  // Flushes the workspace snapshot before the window goes away, and prompts
  // (keep terminals running / close them all) when a terminal is still busy.
  const quitGuard = useQuitGuard(wsFlush, !isDevSession);

  const { switchToWorkspace, createNewWorkspace, closeWorkspace } = useWorkspaceSwitching({
    wsActiveId,
    wsList,
    tabs,
    activeId,
    wsSaveTabs,
    wsSetActive,
    wsCreate,
    wsRemove,
    allocId,
    home,
    replaceAllTabs,
    liveTabsByWorkspace,
    skipNextSnapshotRef,
  });

  const { liveTabCounts } = useTabSideEffects({ tabs, editorRefs, wsActiveId });

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    home,
    pickedRoot,
  );

  // Persist the live workspace root so the Settings window (separate webview,
  // shared localStorage) can target/scan the open project for AI skills. This
  // mirrors exactly what the agent scans (explorerRoot ?? home), so a skill
  // installed "to this project" lands where the agent actually looks.
  useEffect(() => {
    try {
      localStorage.setItem("tedi.liveWorkspaceRoot", explorerRoot ?? home ?? "");
    } catch {
      /* storage unavailable */
    }
  }, [explorerRoot, home]);

  // Register the extension-host tabs/sidebar bridge setters and run the
  // sidebar / right-aux auto-restore effects. The shared refs (sidebar
  // handle + the two hider latches) stay in App; other effects read them.
  useExtensionSidebarBridges({
    openExtensionTab,
    openExtensionPane,
    setExtensionTabState,
    sidebarRef,
    sidebarHiderRef,
    rightSlotRef,
    rightSidebarHiderRef,
    activeTab,
    tabs,
  });

  // Wire `ctx.editor.{getActive,setActiveContent}` to the active editor pane.
  useEditorBridge({ activeEditorHandle, activePaneTab });

  const {
    sshStatuses,
    setSshStatuses,
    aiCliStatuses,
    setAiCliStatuses,
    handleSshStatus,
    handleAiCliStatus,
    activeSshContext,
    sshBindingByConnection,
    hasAnySshLeaf,
  } = useSshLeafState({ activePaneTab, tabs });

  // "Reconnect" on a remote editor pane with no live session (typically a
  // restored workspace whose SSH terminal was closed). Opens a normal SSH tab
  // for the saved profile, so host-key prompts and jump hosts run through the
  // usual terminal flow; the editor pane rebinds itself once the session lands,
  // since it resolves by connection id rather than holding a session number.
  const handleReconnectSshForEditor = useCallback(
    (connectionId: string, title: string) => {
      newSshTab(connectionId, title);
    },
    [newSshTab],
  );

  // Besides the live toast/beep + status map that `handleAiCliStatus` drives,
  // stamp the detected agent kind onto the leaf so the serializer persists it.
  // On the next launch a still-running (reattached) agent resumes its badge
  // instead of going dark until the user types a command. Only the tool
  // identity is written; the frequent working<->idle flips are no-op-guarded
  // inside `setLeafActiveTool`.
  const handleAiCliStatusAndPersist: typeof handleAiCliStatus = useCallback(
    (leafId, status) => {
      handleAiCliStatus(leafId, status);
      setLeafActiveTool(leafId, status?.tool ?? null);
    },
    [handleAiCliStatus, setLeafActiveTool],
  );

  // Hide the local-OS status badge while the active pane IS a live SSH session:
  // the status bar's cwd breadcrumb shows the REMOTE path, so "Windows" would
  // misrepresent the shell the user is actually in. Keyed off the active leaf's
  // own connected status (not hasAnySshLeaf), so a background SSH session while
  // you're in a local tab still shows the correct local badge.
  const activeLeafIsSsh =
    activeLeafIdInTab != null && sshStatuses.get(activeLeafIdInTab)?.kind === "connected";

  // The focused terminal's "done" badge decays back to idle: done is an
  // attention glance for panes you're NOT looking at. `aiCliStatuses` is in the
  // deps so this also fires when the ACTIVE pane transitions into done while
  // already focused (a single pane you're watching finish) - not only when you
  // switch TO a done pane. acknowledgeAiCli is a no-op unless the leaf is done,
  // so the extra runs are cheap. Typing clears it too (detector pushInput). The
  // "<tool> finished" toast still fires first (working->done edge in
  // useSshLeafState), so you don't miss the completion signal.
  useEffect(() => {
    if (activeLeafIdInTab != null) acknowledgeAiCli(activeLeafIdInTab);
  }, [activeLeafIdInTab, aiCliStatuses]);

  // Right-column housekeeping (close a docked panel when its enabling pref flips
  // off). Declared here (not up with the other store reads) because it needs
  // hasAnySshLeaf from useSshLeafState.
  useRightPanelExclusion(
    scmRightOpen,
    sourceControlInRightPanel,
    showSourceControl,
    closeScmRight,
    sshRightOpen,
    sshInRightPanel,
    hasAnySshLeaf,
    closeSshRight,
  );

  // Publish the live-state snapshot to extensions. Placed AFTER useSshLeafState
  // so it can include SSH tab numbers (keyed by the live SSH session id), which
  // a mirror like Remote Access needs to label SSH tabs the same as the desktop.
  useAppContextBridge({
    activePaneTab,
    activeTab,
    tabs,
    wsList,
    wsActiveId,
    explorerRoot,
    sshStatuses,
    liveTabsByWorkspace,
  });

  const disposeTab = useCallback(
    (id: number) => {
      // Per-leaf maps are pruned by useSessionDisposal's [tabs] effect.
      closeTab(id);
    },
    [closeTab],
  );

  // Disposes sessions by pane tree, not React lifecycle, and prunes the
  // per-leaf handle maps + ssh/ai-cli status state for dead leaves.
  useSessionDisposal({
    tabs,
    liveTabsByWorkspace,
    terminalRefs,
    searchAddons,
    detectedUrls,
    editorRefs,
    setSshStatuses,
    setAiCliStatuses,
  });

  // Adopt daemon PTY sessions created by another client (the remote-access
  // agent, when the browser hits "+") as real terminal tabs, and let the
  // daemon's Exit event (e.g. a browser-initiated close) tear the tab down.
  // Reuses the workspace-restore reattach machinery via newTab({ savedPtyId }).
  // Safe to re-enable: the launch hang was git commands on the UI thread (fixed
  // in 0.3.50), not this hook, and the adopt poll's pty_list_sessions is now
  // async so a slow daemon can't freeze the UI.
  useAdoptDaemonSessions({
    tabsRef,
    liveTabsByWorkspace,
    newTab,
    restoreDone: wsHydrated,
    enabled: !isDevSession,
  });

  // Wire the SSH-connection bridge so a permitted extension (the Remote Access
  // browser "+ New SSH") can list saved hosts and open one BY ID. Secrets never
  // cross: the keychain read + `ssh_open` happen later in the normal newSshTab
  // flow (openSshForSession). Only PINNED connections are listed/openable - a
  // first connect needs human host-key verification on the desktop, which a web
  // user can't safely do, so unpinned hosts are withheld and refused here too.
  useEffect(() => {
    setSshConnectionBridge(
      async () => {
        const list = await listConnections();
        const pinnedConnections: Array<{
          id: string;
          name: string;
          host: string;
          port: number;
          user: string;
          pinned: true;
        }> = [];
        for (const c of list) {
          if (!c.lastFingerprint) continue;
          pinnedConnections.push({
            id: c.id,
            name: c.name,
            host: c.host,
            port: c.port,
            user: c.user,
            pinned: true,
          });
        }
        return pinnedConnections;
      },
      async (id) => {
        const conn = (await listConnections()).find((c) => c.id === id);
        if (!conn) return { ok: false, error: "connection not found" };
        if (!conn.lastFingerprint) {
          return { ok: false, error: "host key not pinned; connect once on the desktop first" };
        }
        newSshTab(conn.id, conn.name);
        return { ok: true };
      },
      (sessionId) => {
        // Close the desktop tab whose live SSH session id matches, so a remote
        // "close tab" closes BOTH sides (not just the underlying SSH session).
        let leafId: number | null = null;
        for (const [lid, st] of sshStatuses) {
          if (st.kind === "connected" && st.sessionId === sessionId) {
            leafId = lid;
            break;
          }
        }
        if (leafId === null) return false;
        const tab = tabs.find(
          (t) => t.kind === "pane" && leaves(t.paneTree).some((l) => l.id === leafId),
        );
        if (!tab) return false;
        closeTab(tab.id);
        return true;
      },
    );
    return () => setSshConnectionBridge(null, null, null);
  }, [newSshTab, sshStatuses, tabs, closeTab]);

  // Wire the workspace-management bridge so the Remote Access extension can let
  // the browser SWITCH to a target workspace or CREATE a new one. Only a
  // workspace id / name ever crosses; the shell spawn stays on the existing,
  // separately-gated open path (the terminal the browser then opens is adopted
  // into the now-active workspace). Creating switches to the fresh workspace,
  // which auto-seeds a default terminal so it shows up in the mirror.
  useEffect(() => {
    setWorkspaceMgmtBridge(
      async (name) => {
        const trimmed = (name || "").trim().slice(0, 60);
        const finalName =
          trimmed || `Workspace ${useWorkspacesStore.getState().workspaces.length + 1}`;
        const ws = wsCreate(finalName);
        switchToWorkspace(ws.id);
        return { ok: true, wsId: ws.id };
      },
      async (wsId) => {
        if (!useWorkspacesStore.getState().workspaces.some((w) => w.id === wsId)) {
          return { ok: false, error: "workspace not found" };
        }
        switchToWorkspace(wsId);
        return { ok: true };
      },
    );
    return () => setWorkspaceMgmtBridge(null, null);
  }, [wsCreate, switchToWorkspace]);

  const {
    pendingClose,
    handleClose,
    requestCloseLeaf,
    confirmClose,
    cancelClose,
    cycleTab,
    openNewTab,
    openNewPrivateTab,
    sendCd,
    cdInNewTab,
    spawnAgents,
    openPreviewTab,
    splitActivePaneInActiveTab,
    moveLeafToGroup,
    handleCloseTabOrPane,
  } = useTabActions({
    tabs,
    activeId,
    tabsRef,
    terminalRefs,
    activeLeafIdInTab,
    activeLeafKindCurrent,
    activeLeafIsSsh,
    explorerRoot,
    inheritedCwdForNewTab,
    setPickedRoot,
    disposeTab,
    setActiveId,
    newTab,
    newPaneGroupTab,
    newBrowserTab,
    setLeafCwd,
    splitActivePane,
    moveLeafToTab,
    closePaneByLeaf,
  });

  // On active leaf/tab change, surface the focused leaf's search addon,
  // editor handle, and detected URL to the chrome; track browser-pane titles.
  const { handleSearchReady, handleDetectedLocalUrl, handleProjectUrl, detectedBrowserUrl } =
    useActiveLeafSurface({
      searchAddons,
      editorRefs,
      detectedUrls,
      activeId,
      activeLeafIdInTab,
      activeLeafKindCurrent,
      tabs,
      setActiveSearchAddon,
      setActiveEditorHandle,
      setBrowserLeafTitle,
      autoOpenProjectUrl,
      openPreviewTab,
    });

  // The other half of the open-in-browser pill: finds a server the terminal
  // never saw start by reading the url the project declares for itself.
  useProjectUrl(explorerRoot, handleProjectUrl);

  const {
    askPopup,
    setAskPopup,
    onAskFromSelection,
    askFromSelection,
    handleAttachFileToAgent,
    togglePanelAndFocus,
  } = useSelectionAskAi({
    tabs,
    activeId,
    terminalRefs,
    editorRefs,
    hasComposer,
    activeLeafKindCurrent,
  });

  const { handleOpenFile, handleOpenRemoteFile, handlePathRenamed, handlePathDeleted } =
    useFileActions({
      tabs,
      disposeTab,
      openFileTab,
      setEditorLeafPath,
      openPreviewTab,
      sshBindingByConnection,
    });

  // Drop a file onto an editor pane or the tab strip to open it, VSCode-style —
  // works for any absolute path, even outside the current workspace root. A
  // dropped folder opens a terminal tab rooted there instead. Routed through
  // `handleOpenFile` (not `openFileTab`) so a dropped PDF lands in a browser
  // pane exactly like one clicked in the explorer. Declared here rather than
  // beside the other drop listeners because it needs `handleOpenFile`.
  useEditorFileDrop({ openFile: handleOpenFile, newTerminalTab: newTab });

  // Explorer "Preview in Browser" (HTML files): open the local file in a new
  // in-app browser preview tab via its file:// URL.
  const handlePreviewFileInBrowser = useCallback(
    (path: string) => {
      const url = pathToFileUrl(path);
      if (url) openPreviewTab(url, true);
    },
    [openPreviewTab],
  );

  const { searchTarget, activeCwd, activeFilePath } = useChromeDerivations({
    isTerminalLike,
    isEditorLike,
    activeSearchAddon,
    activeEditorHandle,
    activeLeafIdInTab,
    activePaneTab,
    activeTab,
    terminalRefs,
    explorerRoot: explorerRoot ?? null,
  });

  const commandPaletteHandler = useCallback(() => {
    setCommandPaletteOpen((prev) => !prev);
  }, []);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () =>
      buildShortcutHandlers({
        openNewTab,
        openNewPrivateTab,
        openPreviewTab,
        handleCloseTabOrPane,
        cycleTab,
        selectByIndex,
        splitActivePaneInActiveTab,
        focusNextPaneInTab,
        togglePanelAndFocus,
        askFromSelection,
        openScmTab,
        toggleSidebar,
        toggleRightSlot,
        requestCloseLeaf,
        setNewEditorOpen,
        setAgentDialogOpen,
        searchInlineRef,
        editorRefs,
        terminalRefs,
        tabsRef,
        activeId,
        activeLeafIdInTab,
        activeLeafKindCurrent,
        commandPaletteOpen: commandPaletteHandler,
      }),
    [
      activeId,
      activeLeafIdInTab,
      activeLeafKindCurrent,
      requestCloseLeaf,
      cycleTab,
      handleCloseTabOrPane,
      openNewTab,
      openNewPrivateTab,
      openPreviewTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      togglePanelAndFocus,
      askFromSelection,
      toggleSidebar,
      toggleRightSlot,
      openScmTab,
      commandPaletteHandler,
    ],
  );

  // Gate the browser.* shortcuts to a focused browser pane so they fall through
  // to the shell/editor everywhere else - the terminal keeps Ctrl+Shift+R,
  // Alt+Left/Right, etc. on Windows, Linux, and macOS. pane.splitBrowser is
  // intentionally not gated: like the other splits it acts on whatever pane is
  // focused. The options object is read fresh each keydown (see useGlobalShortcuts),
  // so closing over activeLeafKindCurrent without a dep array is fine.
  useGlobalShortcuts(shortcutHandlers, {
    isDisabled: (id: ShortcutId, e) => {
      if (id.startsWith("browser.")) return activeLeafKindCurrent !== "browser";

      // Copy/paste is decided here in full, off REAL keyboard focus rather than
      // the active leaf - see `focusedTerminalLeafId`. Both carry a bare chord
      // (Ctrl+C / Ctrl+V, the pair Termius and Windows Terminal bind, and what
      // makes the PC clipboard usable inside an SSH session), and
      // `useGlobalShortcuts` preventDefaults the moment one matches, so the
      // wrong answer here either kills native paste in the AI composer or eats
      // a keystroke a shell needed.
      if (id === "terminal.copy" || id === "terminal.paste") {
        const leafId = focusedTerminalLeafId();
        if (leafId === null) return true;
        // Bare Ctrl+C is the shell's SIGINT unless there is something to copy;
        // the handler then clears the selection so the NEXT press interrupts.
        // Ctrl+Shift+C / Cmd+C carry a second modifier, are no control code,
        // and always copy.
        if (id === "terminal.copy" && isTerminalControlChord(e)) {
          return !terminalRefs.current.get(leafId)?.getSelection()?.trim();
        }
        return false;
      }

      // A focused terminal owns every bare-Ctrl control code (Ctrl+E, Ctrl+W,
      // Ctrl+K, Ctrl+L, Ctrl+[ Esc, Ctrl+I Tab, the tmux/screen prefix, …) and
      // every bare-Alt meta sequence (readline M-b / M-f / M-d / M-1..9). On
      // Win/Linux `Mod`=Ctrl, so those chords otherwise fire app actions (close
      // tab, ask AI, word-wrap, …) and the byte never reaches the shell. Let
      // them fall through. Exceptions: pane.splitRight (Ctrl+D) always fires,
      // while ai.askSelection (Ctrl+L) fires only when the focused local or SSH
      // terminal has selected text. With no selection Ctrl+L still reaches the
      // shell as clear-screen. pane.splitDown already passes because it carries
      // Shift. Terminal-safe app chords keep Shift/Meta or add a second modifier
      // (Ctrl+Shift+C copy, Ctrl+Shift+X close, Ctrl+Alt+P, Shift+Alt+F) and stay
      // active; Ctrl+Tab / Ctrl+digit / zoom are not control codes either.
      return (
        id !== "pane.splitRight" &&
        !(
          id === "ai.askSelection" &&
          activeLeafIdInTab !== null &&
          !activeLeafCurrent?.private &&
          !!terminalRefs.current.get(activeLeafIdInTab)?.getSelection()?.trim()
        ) &&
        activeLeafKindCurrent === "terminal" &&
        (isTerminalControlChord(e) || isTerminalMetaChord(e))
      );
    },
  });

  // Generic dispatcher for extension-contributed keybindings. Walks
  // `keybindingsRegistry` and `commandsRegistry` on each keydown and
  // fires the matching command. No per-extension wiring here.
  useExtensionShortcuts();

  const paneHandles = usePaneHandles({
    terminalRefs,
    editorRefs,
    tabsRef,
    activeLeafIdInTab,
    setActiveEditorHandle,
    handleClose,
    requestCloseLeaf,
    setLeafCwd,
    setLeafPtyId,
    focusPane,
    closePaneByLeaf,
    openFileTab,
    splitActivePane,
    newTab,
    setEditorLeafDirty,
  });

  // AI live-context (`setLive`) + schedule-trigger engine bridges. Both read
  // live workspace state through a stable ref so the closures don't churn.
  useAgentBridges({
    tabs,
    activeId,
    explorerRoot,
    home,
    openPreviewTab,
    setBrowserLeafUrl,
    newTab,
    inheritedCwdForNewTab,
    splitActivePane,
    setActiveId,
    focusPane,
    moveLeafToTab,
    rotateLeafSplit,
    closePaneByLeaf,
    terminalRefs,
  });

  const {
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
  } = useHeaderActions({
    activePaneTab,
    detectedBrowserUrl,
    openPreviewTab,
    handleClose,
    requestCloseLeaf,
    setActiveId,
    focusPane,
    pinTab,
    newSshTab,
  });

  // Activate a tab and focus a specific leaf inside it. Backs the Workspaces
  // panel's terminal list (jump straight to a running terminal).
  const focusLeafInTab = useCallback(
    (tabId: number, leafId: number) => {
      setActiveId(tabId);
      focusPane(tabId, leafId);
    },
    [setActiveId, focusPane],
  );

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="bg-background text-foreground relative flex h-screen flex-col overflow-hidden">
          <Header
            tabs={tabs}
            activeId={activeId}
            onSelectEntry={handleHeaderSelectEntry}
            onCloseEntry={handleHeaderCloseEntry}
            onNewTerminal={openNewTab}
            onNewPrivateTerminal={openNewPrivateTab}
            onTogglePrivate={togglePrivate}
            onSetTabPinned={setTabPinned}
            onRenameLeaf={renameLeaf}
            onNewPreview={handleHeaderNewPreview}
            onOpenAgents={() => setAgentDialogOpen(true)}
            onPinLeaf={handleHeaderPinLeaf}
            onReorderTabs={reorderTabs}
            onReorderLeafInGroup={reorderLeafInGroup}
            onToggleSidebar={toggleSidebar}
            onToggleRightPanel={toggleRightSlot}
            onOpenFolder={openWorkspaceFolder}
            onSplit={splitActivePaneInActiveTab}
            canSplit={headerCanSplit}
            onOpenExtensions={handleHeaderOpenExtensions}
            onOpenSettings={handleHeaderOpenSettings}
            onConnectSsh={handleHeaderConnectSsh}
            onMoveLeafToGroup={moveLeafToGroup}
            onMoveLeafToNewTab={moveLeafToNewTab}
            onRotateLeafSplit={rotateLeafSplit}
            sshStatuses={sshStatuses}
            aiCliStatuses={aiCliStatuses}
            searchTarget={searchTarget}
            searchRef={searchInlineRef}
          />

          {/* Bento tray: the deep `bg-sidebar` well holds the three body columns
              as separate 1px-bordered cards, inset from the header/status bar and
              gapped from each other (`p-1.5` + `gap-1.5`). Under glass the gaps
              reveal the wallpaper, matching the floating-panels look. */}
          <main className="bg-sidebar flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1 gap-1.5 p-1.5">
              <AppSidebar
                sidebarRef={sidebarRef}
                explorerRoot={explorerRoot}
                hasAnySshLeaf={hasAnySshLeaf}
                onOpenFile={handleOpenFile}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
                onRevealInTerminal={cdInNewTab}
                onAttachToAgent={handleAttachFileToAgent}
                onPreviewInBrowser={handlePreviewFileInBrowser}
                activeFilePath={activeFilePath}
                activeSshContext={activeSshContext}
                onOpenRemoteFile={handleOpenRemoteFile}
                showSourceControl={showSourceControl}
                sourceControlInRightPanel={sourceControlInRightPanel}
                sshInRightPanel={sshInRightPanel}
                onSwitchWorkspace={switchToWorkspace}
                onCreateWorkspace={createNewWorkspace}
                onCloseWorkspace={closeWorkspace}
                tabCounts={liveTabCounts}
                liveTabs={tabs}
                cachedTabsByWorkspace={liveTabsByWorkspace}
                onFocusLeaf={focusLeafInTab}
                onRenameLeaf={renameLeaf}
                onCloseEntry={handleHeaderCloseEntry}
                activeLeafId={activePaneTab?.activeLeafId ?? null}
                sshStatuses={sshStatuses}
                aiPanelOpen={panelOpen}
                aiKeysLoaded={keysLoaded}
                hasComposer={hasComposer}
                onAddProviderKey={handleAddProviderKey}
                openGitDiffTab={openGitDiffTab}
                openScmTab={openScmTab}
                openBoardTab={openBoardTab}
              />
              <ResizableHandle withHandle />
              <WorkspaceArea
                tabs={tabs}
                activeId={activeId}
                activeTab={activeTab}
                activePaneTab={activePaneTab}
                uiZoom={uiZoom}
                explorerRoot={explorerRoot}
                paneHandles={paneHandles}
                onSearchReady={handleSearchReady}
                onDetectedLocalUrl={handleDetectedLocalUrl}
                onSshStatus={handleSshStatus}
                onAiCliStatus={handleAiCliStatusAndPersist}
                sshStatuses={sshStatuses}
                aiCliStatuses={aiCliStatuses}
                sshBindingByConnection={sshBindingByConnection}
                onReconnectSsh={handleReconnectSshForEditor}
                mdPreviewLeafIds={mdPreviewLeafIds}
                onToggleMdPreview={toggleMdPreviewForLeaf}
                hasAiDiffTab={hasAiDiffTab}
                hasGitDiffTab={hasGitDiffTab}
                hasScmTab={hasScmTab}
                hasExtensionTab={hasExtensionTab}
                respondToApproval={respondToApproval}
                onPathDeleted={handlePathDeleted}
                setBrowserLeafUrl={setBrowserLeafUrl}
                movePaneLeafToEdge={movePaneLeafToEdge}
                moveExtTabToPane={moveExtTabToPane}
                openGitDiffTab={openGitDiffTab}
                setLeafTerminalTheme={setLeafTerminalTheme}
                onSplitSizes={setSplitSizes}
              />
              <AppRightSlot
                rightSlotRef={rightSlotRef}
                rightPanels={rightPanels}
                scmRightOpen={scmRightOpen}
                sshRightOpen={sshRightOpen}
                keysLoaded={keysLoaded}
                panelOpen={panelOpen}
                hasComposer={hasComposer}
                explorerRoot={explorerRoot}
                onPathDeleted={handlePathDeleted}
                closeScmRight={closeScmRight}
                closeSshRight={closeSshRight}
                activeSshContext={activeSshContext}
                onOpenRemoteFile={handleOpenRemoteFile}
                onAddProviderKey={handleAddProviderKey}
                filesSection={{
                  onOpenFile: handleOpenFile,
                  onPathRenamed: handlePathRenamed,
                  onRevealInTerminal: cdInNewTab,
                  onAttachToAgent: handleAttachFileToAgent,
                  onPreviewInBrowser: handlePreviewFileInBrowser,
                  activeFilePath,
                }}
                workspacesSection={{
                  onSwitch: switchToWorkspace,
                  onCreate: createNewWorkspace,
                  onCloseWorkspace: closeWorkspace,
                  tabCounts: liveTabCounts,
                  liveTabs: tabs,
                  cachedTabsByWorkspace: liveTabsByWorkspace,
                  onFocusLeaf: focusLeafInTab,
                  onRenameLeaf: renameLeaf,
                  onCloseEntry: handleHeaderCloseEntry,
                  activeLeafId: activePaneTab?.activeLeafId ?? null,
                  sshStatuses,
                }}
                openGitDiffTab={openGitDiffTab}
                openScmTab={openScmTab}
                openBoardTab={openBoardTab}
              />
            </ResizablePanelGroup>
          </main>

          <StatusBar
            cwd={activeCwd}
            filePath={activeFilePath}
            home={home}
            onCd={sendCd}
            onOpenMini={openMini}
            hasAnySshLeaf={hasAnySshLeaf}
            activeIsSsh={activeLeafIsSsh}
            sshSessionId={activeLeafIsSsh ? activeSshContext.sessionId : null}
            sshRoute={
              activeLeafIdInTab != null ? sshStatuses.get(activeLeafIdInTab)?.route : undefined
            }
            previewUrl={detectedBrowserUrl}
            onOpenPreview={handleOpenDetectedPreview}
          />

          {hasComposer ? (
            <AgentRunBridge openAiDiffTab={openAiDiffTab} setAiDiffStatus={setAiDiffStatus} />
          ) : null}

          <Toaster />

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            explorerRoot={explorerRoot ?? null}
            onOpenFile={handleOpenFile}
          />

          <AppDialogs
            askPopup={askPopup}
            onAskFromSelection={onAskFromSelection}
            setAskPopup={setAskPopup}
            agentDialogMounted={agentDialogMounted}
            agentDialogOpen={agentDialogOpen}
            setAgentDialogOpen={setAgentDialogOpen}
            onSpawnAgents={spawnAgents}
            newEditorMounted={newEditorMounted}
            newEditorOpen={newEditorOpen}
            setNewEditorOpen={setNewEditorOpen}
            explorerRoot={explorerRoot}
            home={home}
            openFileTab={openFileTab}
            sshEditorMounted={sshEditorMounted}
            sshEditorOpen={sshEditorOpen}
            setSshEditorOpen={setSshEditorOpen}
            editingSshConn={editingSshConn}
            setEditingSshConn={setEditingSshConn}
            pendingClose={pendingClose}
            cancelClose={cancelClose}
            confirmClose={confirmClose}
            quitGuard={quitGuard}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
