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
import { ResizableHandle, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentRunBridge, hasAnyKey, useChatStore } from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { useRightPanelStore } from "@/modules/extensions";
import { type EditorPaneHandle } from "@/modules/editor";
import { Header, type SearchInlineHandle } from "@/modules/header";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import {
  useExtensionShortcuts,
  useGlobalShortcuts,
  type ShortcutHandlers,
} from "@/modules/shortcuts";
import { StatusBar } from "@/modules/statusbar";
import {
  activeLeafKind,
  isEditorLikeTab,
  isTerminalLikeTab,
  useTabs,
  useWorkspaceCwd,
  type Tab,
} from "@/modules/tabs";
import {
  ensureFsDragListener,
  useTerminalFileDrop,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { type SshConnection } from "@/modules/ssh/connections";
import { useWorkspacesStore } from "@/modules/workspaces";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { buildShortcutHandlers } from "./lib/shortcutHandlers";
import { useApplyZoom } from "./hooks/useApplyZoom";
import { useRightPanelExclusion } from "./hooks/useRightPanelExclusion";
import {
  useExtensionSidebarBridges,
  type RightAuxSnapshot,
} from "./hooks/useExtensionSidebarBridges";
import { useWorkspaceSwitching } from "./hooks/useWorkspaceSwitching";
import { useSshLeafState } from "./hooks/useSshLeafState";
import { useAppContextBridge } from "./hooks/useAppContextBridge";
import { usePaneHandles } from "./hooks/usePaneHandles";
import { useTabActions } from "./hooks/useTabActions";
import { useFileActions } from "./hooks/useFileActions";
import { useHeaderActions } from "./hooks/useHeaderActions";
import { useWorkspaceRoot } from "./hooks/useWorkspaceRoot";
import { useAiBootstrap } from "./hooks/useAiBootstrap";
import { useExtensionPanelDefaults } from "./hooks/useExtensionPanelDefaults";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useEditorBridge } from "./hooks/useEditorBridge";
import { useAgentBridges } from "./hooks/useAgentBridges";
import { useSelectionAskAi } from "./hooks/useSelectionAskAi";
import { useSessionDisposal } from "./hooks/useSessionDisposal";
import { useActiveLeafSurface } from "./hooks/useActiveLeafSurface";
import { useChromeDerivations } from "./hooks/useChromeDerivations";
import { useTabSideEffects } from "./hooks/useTabSideEffects";
import { AppDialogs } from "./components/AppDialogs";
import { AppSidebar } from "./components/AppSidebar";
import { WorkspaceArea } from "./components/WorkspaceArea";
import { AppRightSlot } from "./components/AppRightSlot";

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newSshTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    openExtensionTab,
    setExtensionTabState,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    closeTab,
    selectByIndex,
    setLeafCwd,
    setPreviewLeafUrl,
    setPreviewLeafTitle,
    setLeafPtyId,
    setEditorLeafDirty,
    setEditorLeafPath,
    focusPane,
    focusNextPaneInTab,
    closePaneByLeaf,
    splitActivePane,
    closeActivePane,
    moveLeafToTab,
    moveLeafToNewTab,
    rotateLeafSplit,
    replaceAllTabs,
    allocId,
    reorderTabs,
    reorderLeafInGroup,
    movePaneLeafToEdge,
    togglePrivate,
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
  const activeLeafKindCurrent = activeTab ? activeLeafKind(activeTab) : null;

  // -------- shared runtime handles & state owned by the coordinator --------
  // These are read/written by several domain hooks and the layout components,
  // so they stay here and are threaded in. Single-consumer state lives inside
  // its owning hook instead (e.g. pendingCloseTab in useTabActions).
  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const detectedUrls = useRef<Map<number, string>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] = useState<SearchAddon | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] = useState<EditorPaneHandle | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);

  const [editingSshConn, setEditingSshConn] = useState<SshConnection | null>(null);
  const [sshEditorOpen, setSshEditorOpen] = useState(false);
  // Latches the first time each lazy dialog opens. Stays true; see the
  // dialog mount sites for why.
  const [sshEditorMounted, setSshEditorMounted] = useState(false);
  useEffect(() => {
    if (sshEditorOpen) setSshEditorMounted(true);
  }, [sshEditorOpen]);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [newEditorMounted, setNewEditorMounted] = useState(false);
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
  // Twin of `sidebarHiderRef` for the right-side aux column (AI chat / ext
  // right panel / SCM right panel). Tracks which (if any) of the three was
  // open when an extension asked the right slot to close, so we can restore
  // it once the user leaves that extension's tab. Snapshot is a tag, not a
  // re-open call: we never reopen a panel the user has since dismissed
  // explicitly.
  const rightSidebarHiderRef = useRef<{
    extensionId: string;
    prior: RightAuxSnapshot;
  } | null>(null);
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    sidebarHiderRef.current = null;
    if (p.getSize().asPercentage <= 0) p.expand();
    else p.collapse();
  }, []);

  // Accordion sub-panels inside the merged Files section. Each section
  // collapses to its h-8 header via flex layout, not react-resizable-panels'
  // collapse. The library redistributes freed space by `defaultSize`
  // weight, which would force one section back open if both collapsed.
  // Plain flex avoids that: `flex-1` when open, `h-8 shrink-0` when
  // collapsed. The parent stays a single ResizablePanel so the whole Files
  // section can still resize against SCM / Workspaces below.
  const [localFilesCollapsed, setLocalFilesCollapsed] = useState(false);
  const [sshFilesCollapsed, setSshFilesCollapsed] = useState(false);
  const toggleLocalFiles = useCallback(() => {
    setLocalFilesCollapsed((v) => !v);
  }, []);
  const toggleSshFiles = useCallback(() => {
    setSshFilesCollapsed((v) => !v);
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
    new Map(),
  );

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
  const contentZoom = usePreferencesStore((s) => s.contentZoom);
  // UI zoom scales the chrome only (header / tabs, sidebar, side panels, status
  // bar) plus portaled overlays, which mount on `document.body` outside `#root`.
  // The workspace pane counter-zooms back to 1 (see WorkspaceArea) so terminal /
  // editor / preview keep native resolution and their own `--content-zoom`.
  const uiZoom = usePreferencesStore((s) => s.uiZoom);
  // Apply --content-zoom (CSS var) and body.zoom from the prefs values.
  useApplyZoom(contentZoom, uiZoom);

  const scmRightOpen = useScmRightPanelStore((s) => s.open);
  const closeScmRight = useScmRightPanelStore((s) => s.closePanel);

  // Right-panel, SCM right panel, and AI sidebar are mutually exclusive
  // (all three want the same ~22% slot). Opening one closes the others.
  const rightPanelActive = useRightPanelStore((s) => s.active);
  useRightPanelExclusion(
    rightPanelActive,
    panelOpen,
    scmRightOpen,
    sourceControlInRightPanel,
    showSourceControl,
    closeScmRight,
  );

  // -------- workspaces wiring --------
  const wsHydrate = useWorkspacesStore((s) => s.hydrate);
  const wsHydrated = useWorkspacesStore((s) => s.hydrated);
  const wsList = useWorkspacesStore((s) => s.workspaces);
  const wsActiveId = useWorkspacesStore((s) => s.activeId);
  const wsSetActive = useWorkspacesStore((s) => s.setActiveId);
  const wsCreate = useWorkspacesStore((s) => s.createWorkspace);
  const wsRemove = useWorkspacesStore((s) => s.removeWorkspace);
  const wsSaveTabs = useWorkspacesStore((s) => s.saveWorkspaceTabs);

  useWorkspacePersistence({
    wsHydrate,
    wsHydrated,
    wsList,
    wsActiveId,
    wsSaveTabs,
    tabs,
    activeId,
    allocId,
    replaceAllTabs,
    skipNextSnapshotRef,
  });

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

  useAppContextBridge({
    activePaneTab,
    activeTab,
    tabs,
    wsList,
    wsActiveId,
    explorerRoot,
  });

  // Register the extension-host tabs/sidebar bridge setters and run the
  // sidebar / right-aux auto-restore effects. The shared refs (sidebar
  // handle + the two hider latches) stay in App; other effects read them.
  useExtensionSidebarBridges({
    openExtensionTab,
    setExtensionTabState,
    sidebarRef,
    sidebarHiderRef,
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
    hasAnySshLeaf,
  } = useSshLeafState({ activePaneTab, tabs });

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

  const {
    pendingCloseTab,
    handleClose,
    confirmClose,
    cancelClose,
    cycleTab,
    openNewTab,
    openNewPrivateTab,
    sendCd,
    cdInNewTab,
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
    explorerRoot,
    inheritedCwdForNewTab,
    setPickedRoot,
    disposeTab,
    setActiveId,
    newTab,
    newPreviewTab,
    setLeafCwd,
    splitActivePane,
    moveLeafToTab,
    closeActivePane,
  });

  // On active leaf/tab change, surface the focused leaf's search addon,
  // editor handle, and detected URL to the chrome; track browser-pane titles.
  const { handleSearchReady, handleDetectedLocalUrl, detectedPreviewUrl } = useActiveLeafSurface({
    searchAddons,
    editorRefs,
    detectedUrls,
    activeId,
    activeLeafIdInTab,
    activeLeafKindCurrent,
    isTerminalLike,
    tabs,
    setActiveSearchAddon,
    setActiveEditorHandle,
    setPreviewLeafTitle,
  });

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
    });

  const { searchTarget, mdPreviewToggle, lineWrapToggle, activeCwd, activeFilePath } =
    useChromeDerivations({
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
    });

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
        closePaneByLeaf,
        setNewEditorOpen,
        searchInlineRef,
        editorRefs,
        terminalRefs,
        tabsRef,
        activeId,
        activeLeafIdInTab,
        activeLeafKindCurrent,
      }),
    [
      activeId,
      activeLeafIdInTab,
      activeLeafKindCurrent,
      closePaneByLeaf,
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
      openScmTab,
    ],
  );

  useGlobalShortcuts(shortcutHandlers);

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
    setPreviewLeafUrl,
    newTab,
    inheritedCwdForNewTab,
    splitActivePane,
    setActiveId,
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
    handleHeaderNewEditor,
    handleHeaderPinLeaf,
    handleHeaderOpenExtensions,
    handleHeaderOpenSettings,
    handleHeaderConnectSsh,
    headerCanSplit,
  } = useHeaderActions({
    activePaneTab,
    detectedPreviewUrl,
    openPreviewTab,
    handleClose,
    setNewEditorOpen,
    setActiveId,
    focusPane,
    closePaneByLeaf,
    pinTab,
    newSshTab,
  });

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
            onNewPreview={handleHeaderNewPreview}
            onNewEditor={handleHeaderNewEditor}
            onPinLeaf={handleHeaderPinLeaf}
            onReorderTabs={reorderTabs}
            onReorderLeafInGroup={reorderLeafInGroup}
            onToggleSidebar={toggleSidebar}
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
            mdPreviewToggle={mdPreviewToggle}
            lineWrapToggle={lineWrapToggle}
          />

          <main className="flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
              <AppSidebar
                sidebarRef={sidebarRef}
                explorerRoot={explorerRoot}
                hasAnySshLeaf={hasAnySshLeaf}
                localFilesCollapsed={localFilesCollapsed}
                sshFilesCollapsed={sshFilesCollapsed}
                toggleLocalFiles={toggleLocalFiles}
                toggleSshFiles={toggleSshFiles}
                onOpenFile={handleOpenFile}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
                onRevealInTerminal={cdInNewTab}
                onAttachToAgent={handleAttachFileToAgent}
                activeFilePath={activeFilePath}
                activeSshContext={activeSshContext}
                onOpenRemoteFile={handleOpenRemoteFile}
                showSourceControl={showSourceControl}
                sourceControlInRightPanel={sourceControlInRightPanel}
                onSwitchWorkspace={switchToWorkspace}
                onCreateWorkspace={createNewWorkspace}
                onCloseWorkspace={closeWorkspace}
                tabCounts={liveTabCounts}
                openGitDiffTab={openGitDiffTab}
                openScmTab={openScmTab}
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
                onAiCliStatus={handleAiCliStatus}
                sshStatuses={sshStatuses}
                aiCliStatuses={aiCliStatuses}
                mdPreviewLeafIds={mdPreviewLeafIds}
                hasAiDiffTab={hasAiDiffTab}
                hasGitDiffTab={hasGitDiffTab}
                hasScmTab={hasScmTab}
                hasExtensionTab={hasExtensionTab}
                respondToApproval={respondToApproval}
                onPathDeleted={handlePathDeleted}
                setPreviewLeafUrl={setPreviewLeafUrl}
                movePaneLeafToEdge={movePaneLeafToEdge}
                openGitDiffTab={openGitDiffTab}
              />
              <AppRightSlot
                rightPanelActive={rightPanelActive}
                scmRightOpen={scmRightOpen}
                keysLoaded={keysLoaded}
                panelOpen={panelOpen}
                hasComposer={hasComposer}
                explorerRoot={explorerRoot}
                onPathDeleted={handlePathDeleted}
                closeScmRight={closeScmRight}
                onAddProviderKey={handleAddProviderKey}
                openGitDiffTab={openGitDiffTab}
                openScmTab={openScmTab}
              />
            </ResizablePanelGroup>
          </main>

          <StatusBar
            cwd={activeCwd ?? explorerRoot}
            filePath={activeFilePath}
            home={home}
            onCd={sendCd}
            onOpenMini={openMini}
            hasComposer={hasComposer}
            detectedPreviewUrl={detectedPreviewUrl}
            onOpenPreview={handleOpenDetectedPreview}
          />

          {hasComposer ? (
            <AgentRunBridge openAiDiffTab={openAiDiffTab} setAiDiffStatus={setAiDiffStatus} />
          ) : null}

          <Toaster />

          <AppDialogs
            askPopup={askPopup}
            onAskFromSelection={onAskFromSelection}
            setAskPopup={setAskPopup}
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
            pendingCloseTab={pendingCloseTab}
            cancelClose={cancelClose}
            confirmClose={confirmClose}
            tabs={tabs}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
