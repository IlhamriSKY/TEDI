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
import { pathToFileUrl } from "@/lib/path";
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
  leaves,
  useTerminalFileDrop,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { listConnections, type SshConnection } from "@/modules/ssh/connections";
import { setSshConnectionBridge } from "@/modules/extensions/sshBridge";
import { useWorkspacesStore } from "@/modules/workspaces";
import type { SearchAddon } from "@xterm/addon-search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { buildShortcutHandlers } from "./lib/shortcutHandlers";
import { useApplyZoom } from "./hooks/useApplyZoom";
import { useRightPanelExclusion } from "./hooks/useRightPanelExclusion";
import { useDockedSectionAutoOpen } from "./hooks/useDockedSectionAutoOpen";
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
import { useAdoptDaemonSessions } from "./hooks/useAdoptDaemonSessions";
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
    newBrowserTab,
    openExtensionTab,
    openExtensionPane,
    setExtensionTabState,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    closeTab,
    selectByIndex,
    setLeafCwd,
    setBrowserLeafUrl,
    setBrowserLeafTitle,
    setLeafPtyId,
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
  // its owning hook instead (e.g. pendingClose in useTabActions).
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
  // True only when the file-explorer sidebar is collapsed by explicit user
  // intent (the toggle). Lets the minimize/restore guard below tell a real
  // collapse apart from the spurious one react-resizable-panels does when a
  // minimized window reports a 0px container - see the effect under
  // `toggleSidebar`.
  const userCollapsedSidebarRef = useRef(false);
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
  // Last user-intended sidebar width in px, so a window minimize -> restore can
  // put it back. react-resizable-panels recomputes its layout against the 0px
  // container a minimized window reports, which leaves the sidebar shrunk (or
  // collapsed) once the window comes back. We snapshot the good width on every
  // resize *while the window is live*, then re-apply it on restore. `frozen`
  // pauses tracking across the minimize->restore window so the corrupt 0px-era
  // sizes never overwrite the good value.
  const lastSidebarPxRef = useRef<number | null>(null);
  const sidebarTrackingFrozenRef = useRef(false);
  const handleSidebarResize = useCallback((size: PanelSize) => {
    if (sidebarTrackingFrozenRef.current) return;
    // A minimized/hidden window reports a degenerate layout; ignore it. Guards
    // the race where the DOM resize fires before our Tauri minimize listener.
    if (document.visibilityState !== "visible") return;
    // While the window is live the panel enforces its `minSize`, so any width
    // below it is a 0px-container transition artifact, not a real user width.
    // Belt-and-suspenders for the same race. Keep in sync with AppSidebar's
    // `minSize="130px"`.
    if (size.inPixels >= 130) lastSidebarPxRef.current = size.inPixels;
  }, []);
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    sidebarHiderRef.current = null;
    if (p.getSize().asPercentage <= 0) {
      userCollapsedSidebarRef.current = false;
      p.expand();
    } else {
      userCollapsedSidebarRef.current = true;
      p.collapse();
    }
  }, []);

  // Minimizing the window reports a 0px container to react-resizable-panels,
  // which recomputes its layout and leaves the sidebar either collapsed or just
  // shrunk to an arbitrary smaller width once the window is restored/maximized.
  // On the minimize->restore transition, re-open and re-size the sidebar back to
  // the user's last width - but only undo a spurious change, never one the user
  // made (userCollapsedSidebarRef) or an extension made by hiding it
  // (sidebarHiderRef).
  useEffect(() => {
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let wasMinimized = false;
    void w
      .onResized(async () => {
        const minimized = await w.isMinimized();
        if (minimized) {
          // Freeze size tracking so the 0px-container resizes that follow don't
          // overwrite the good width we want to restore.
          sidebarTrackingFrozenRef.current = true;
          wasMinimized = true;
          return;
        }
        if (!wasMinimized) return;
        wasMinimized = false;
        // Defer past the panel library's own post-restore layout pass so our
        // expand()/resize() is the final word, then resume tracking.
        setTimeout(() => {
          const p = sidebarRef.current;
          if (p && !userCollapsedSidebarRef.current && !sidebarHiderRef.current) {
            if (p.isCollapsed()) p.expand();
            const want = lastSidebarPxRef.current;
            if (want != null && Math.abs(p.getSize().inPixels - want) > 1) {
              p.resize(`${want}px`);
            }
          }
          sidebarTrackingFrozenRef.current = false;
        }, 120);
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
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
  // Re-open a sidebar section docked to the right slot on boot (else it would
  // vanish: gone from the left sidebar, closed in the right).
  useDockedSectionAutoOpen();

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

  // Register the extension-host tabs/sidebar bridge setters and run the
  // sidebar / right-aux auto-restore effects. The shared refs (sidebar
  // handle + the two hider latches) stay in App; other effects read them.
  useExtensionSidebarBridges({
    openExtensionTab,
    openExtensionPane,
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
  useAdoptDaemonSessions({ tabsRef, liveTabsByWorkspace, newTab, restoreDone: wsHydrated });

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
        return list
          .filter((c) => !!c.lastFingerprint)
          .map((c) => ({
            id: c.id,
            name: c.name,
            host: c.host,
            port: c.port,
            user: c.user,
            pinned: true,
          }));
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
    newBrowserTab,
    setLeafCwd,
    splitActivePane,
    moveLeafToTab,
    closePaneByLeaf,
  });

  // On active leaf/tab change, surface the focused leaf's search addon,
  // editor handle, and detected URL to the chrome; track browser-pane titles.
  const { handleSearchReady, handleDetectedLocalUrl, detectedBrowserUrl } = useActiveLeafSurface({
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
    setBrowserLeafTitle,
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

  // Explorer "Preview in Browser" (HTML files): open the local file in a new
  // in-app browser preview tab via its file:// URL.
  const handlePreviewFileInBrowser = useCallback(
    (path: string) => {
      const url = pathToFileUrl(path);
      if (url) openPreviewTab(url, true);
    },
    [openPreviewTab],
  );

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
        requestCloseLeaf,
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
    detectedBrowserUrl,
    openPreviewTab,
    handleClose,
    requestCloseLeaf,
    setNewEditorOpen,
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
                onSidebarResize={handleSidebarResize}
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
                onSwitchWorkspace={switchToWorkspace}
                onCreateWorkspace={createNewWorkspace}
                onCloseWorkspace={closeWorkspace}
                tabCounts={liveTabCounts}
                liveTabs={tabs}
                cachedTabsByWorkspace={liveTabsByWorkspace}
                onFocusLeaf={focusLeafInTab}
                activeLeafId={activePaneTab?.activeLeafId ?? null}
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
                setBrowserLeafUrl={setBrowserLeafUrl}
                movePaneLeafToEdge={movePaneLeafToEdge}
                moveExtTabToPane={moveExtTabToPane}
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
            detectedBrowserUrl={detectedBrowserUrl}
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
            pendingClose={pendingClose}
            cancelClose={cancelClose}
            confirmClose={confirmClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
