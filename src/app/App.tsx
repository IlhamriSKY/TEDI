import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster, toast } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  AgentRunBridge,
  AiSidebarPanel,
  getAllKeys,
  hasAnyKey,
  hasKeyForModel,
  SelectionAskAi,
  useChatStore,
} from "@/modules/ai";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBar";
import { providerNeedsKey, type ProviderId } from "@/modules/ai/config";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import {
  clearOpenAICompatibleModels,
  refreshOpenAICompatibleModels,
} from "@/modules/ai/lib/openaiCompatible";
import { clearSumopodModels, refreshSumopodModels } from "@/modules/ai/lib/sumopod";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { AiDiffStack, NewEditorDialog, type EditorPaneHandle } from "@/modules/editor";
import { FileExplorer } from "@/modules/explorer";
import { SourceControlPanel } from "@/modules/scm/SourceControlPanel";
import { GitDiffStack } from "@/modules/scm/GitDiffStack";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Header, type SearchInlineHandle, type SearchTarget } from "@/modules/header";
import { PaneStack } from "@/modules/panes";
import { PreviewStack, type PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  onKeysChanged,
  setContentZoom,
  setLastModelId,
  setLastProviderId,
  setLineWrap,
  CONTENT_ZOOM_DEFAULT,
  CONTENT_ZOOM_MAX,
  CONTENT_ZOOM_MIN,
  CONTENT_ZOOM_STEP,
} from "@/modules/settings/store";
import { useGlobalShortcuts, type ShortcutHandlers } from "@/modules/shortcuts";
import { StatusBar } from "@/modules/statusbar";
import {
  activeLeaf,
  activeLeafKind,
  isEditorLikeTab,
  isTerminalLikeTab,
  MAX_PANES_PER_TAB,
  useTabs,
  useWorkspaceCwd,
  type Tab,
} from "@/modules/tabs";
import {
  disposeSession,
  hasLeaf,
  leafIds,
  leaves,
  respawnSession,
  useTerminalFileDrop,
  type TerminalPaneHandle,
  type TediOpenInput,
  type TediSpawnTabInput,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { type SshConnection } from "@/modules/ssh/connections";
import { SshConnectionDialog } from "@/modules/ssh/SshConnectionDialog";
import type { SshStatus } from "@/modules/ssh/status";
import {
  defaultTabForEmptyWorkspace,
  savedToTab,
  serializeTabs,
  useWorkspacesStore,
  WorkspacesPanel,
} from "@/modules/workspaces";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.protocol === ub.protocol;
  } catch {
    return a === b;
  }
}

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
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    setEditorLeafDirty,
    setEditorLeafPath,
    focusPane,
    focusNextPaneInTab,
    closePaneByLeaf,
    splitActivePane,
    closeActivePane,
    moveLeafToTab,
    rotateLeafSplit,
    replaceAllTabs,
    allocId,
    reorderTabs,
  } = useTabs();

  // Drag a file from the OS file manager onto a terminal pane → paste its
  // shell-quoted path. Tauri captures OS drops globally, so the listener
  // lives once at the app root and dispatches by hit-testing the cursor.
  useTerminalFileDrop();

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId), [tabs, activeId]);
  const activePaneTab = activeTab?.kind === "pane" ? activeTab : null;
  const isTerminalLike = activeTab ? isTerminalLikeTab(activeTab) : false;
  const isEditorLike = activeTab ? isEditorLikeTab(activeTab) : false;

  // Active leaf is the single source of truth for "what's focused inside the
  // current tab" - controls Search/AI selection/CWD wiring etc.
  const activeLeafIdInTab = activePaneTab?.activeLeafId ?? null;
  const activeLeafKindCurrent = activeTab ? activeLeafKind(activeTab) : null;

  // -------- runtime handles & search/url state --------
  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  // Per-leaf SSH status. Lives in React state so TabBar's dot + StatusBar's
  // pill rerender on transitions. Keyed by leafId; entries are cleared by
  // the same prune-effect that drops dead terminal handles below.
  const [sshStatuses, setSshStatuses] = useState<Map<number, SshStatus>>(() => new Map());
  const [editingSshConn, setEditingSshConn] = useState<SshConnection | null>(null);
  const [sshEditorOpen, setSshEditorOpen] = useState(false);
  const [activeSearchAddon, setActiveSearchAddon] = useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const detectedUrls = useRef<Map<number, string>>(new Map());
  const [activeDetectedUrl, setActiveDetectedUrl] = useState<string | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] = useState<EditorPaneHandle | null>(null);
  /**
   * Editor leaf ids currently rendered as a markdown-preview view instead of
   * the source editor. Keyed by leaf id so split panes can be toggled
   * independently. Cleaned up by `PaneStack`'s leaf-pruning effect - the IDs
   * here for closed leaves are harmless (just a stale `Set` entry).
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
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) p.expand();
    else p.collapse();
  }, []);

  // -------- home / picked root --------
  const [home, setHome] = useState<string | null>(null);
  const [pickedRoot, setPickedRoot] = useState<string | null>(() => {
    try {
      return localStorage.getItem("tedi.workspaceRoot");
    } catch {
      return null;
    }
  });

  const openWorkspaceFolder = useCallback(async () => {
    const fallbackTerminalCwd = (() => {
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind === "terminal" && l.cwd) return l.cwd;
        }
      }
      return undefined;
    })();
    const activeTermCwd = (() => {
      if (!activePaneTab) return undefined;
      const leaf = activeLeaf(activePaneTab);
      return leaf?.leafKind === "terminal" ? leaf.cwd : undefined;
    })();
    const defaultPath = pickedRoot ?? activeTermCwd ?? fallbackTerminalCwd ?? home ?? undefined;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath,
      title: "Open Folder",
    });
    if (typeof selected !== "string") return;
    const normalized = selected.replace(/\\/g, "/");
    setPickedRoot(normalized);
    try {
      localStorage.setItem("tedi.workspaceRoot", normalized);
    } catch {
      // Storage may be unavailable (private mode etc.) - skip persistence.
    }
    // Auto-open a terminal tab rooted at the picked folder so the user lands
    // straight in a shell at the new workspace.
    newTab(normalized);
  }, [pickedRoot, activePaneTab, tabs, home, newTab]);

  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  useEffect(() => {
    // Forward-slash form so explorerRoot stays equal across home → OSC 7.
    homeDir()
      .then((p) => setHome(p.replace(/\\/g, "/")))
      .catch(() => setHome(null));
  }, []);

  // `tedi .` / `tedi <path>` handler. Drained from the Rust side on boot,
  // and pushed live by the single-instance plugin when a second `tedi`
  // invocation forwards its argv into this window. Folder → adopt as
  // workspace root + open a fresh terminal there. File → adopt parent as
  // root + open the file in an editor tab.
  const openCliTarget = useCallback(
    (
      target:
        | { kind: "folder"; path: string }
        | {
            kind: "file";
            path: string;
            parent: string;
          },
    ) => {
      const root = target.kind === "folder" ? target.path : target.parent;
      setPickedRoot(root);
      try {
        localStorage.setItem("tedi.workspaceRoot", root);
      } catch {
        // Storage may be unavailable - skip persistence.
      }
      if (target.kind === "folder") {
        newTab(target.path);
      } else {
        newTab(target.parent);
        openFileTab(target.path);
      }
    },
    [newTab, openFileTab],
  );

  // Drain the captured startup target exactly once. The Rust side clears
  // its slot on read, so a webview reload won't replay this.
  const cliStartupRunRef = useRef(false);
  useEffect(() => {
    if (cliStartupRunRef.current) return;
    cliStartupRunRef.current = true;
    void invoke<
      { kind: "folder"; path: string } | { kind: "file"; path: string; parent: string } | null
    >("cli_initial_target").then((target) => {
      if (target) openCliTarget(target);
    });
  }, [openCliTarget]);

  // Live forwarding from `tauri-plugin-single-instance` when the user runs
  // `tedi <path>` while this window is already up.
  useEffect(() => {
    const unlistenP = listen<
      { kind: "folder"; path: string } | { kind: "file"; path: string; parent: string }
    >("tedi:open-cli-target", (e) => {
      if (e.payload) openCliTarget(e.payload);
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, [openCliTarget]);

  // -------- AI composer / chat store wiring --------
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const openMini = useChatStore((s) => s.openMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const setLive = useChatStore((s) => s.setLive);
  const setOpenEditorFiles = useChatStore((s) => s.setOpenEditorFiles);
  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const hasComposer = hasAnyKey(apiKeys);

  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
        // Auto-detect SumoPod models whenever the key arrives or changes.
        if (keys.sumopod) {
          void refreshSumopodModels(keys.sumopod);
        } else {
          clearSumopodModels();
        }
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys]);

  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const prefLastModelId = usePreferencesStore((s) => s.lastModelId);
  const prefLastProviderId = usePreferencesStore((s) => s.lastProviderId);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  const contentZoom = usePreferencesStore((s) => s.contentZoom);
  // Expose the zoom factor as a CSS variable so the CodeMirror editor + diff
  // surfaces can scale via `calc(... * var(--content-zoom))`. The terminal
  // pulls the factor directly from the prefs store and multiplies it into
  // xterm's `fontSize` option — applying CSS `zoom` to a canvas/WebGL terminal
  // breaks cursor + glyph positioning, so we deliberately *don't* touch
  // anything outside the content surfaces.
  useEffect(() => {
    document.documentElement.style.setProperty("--content-zoom", String(contentZoom));
  }, [contentZoom]);
  const openaiCompatibleBaseURL = usePreferencesStore((s) => s.openaiCompatibleBaseURL);
  useEffect(() => {
    const key = apiKeys["openai-compatible"];
    if (!key) {
      clearOpenAICompatibleModels();
      return;
    }
    if (!openaiCompatibleBaseURL) return;
    void refreshOpenAICompatibleModels(key, openaiCompatibleBaseURL);
  }, [apiKeys, openaiCompatibleBaseURL]);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  // One-shot boot restore: pick the last model the user actually used, fall
  // back to the workspace default if it's gone (key removed, model deleted).
  // Guarded by a ref so picking a different model in the dropdown later
  // doesn't get overwritten by a delayed prefs/keys hydration.
  const bootModelRestoredRef = useRef(false);
  useEffect(() => {
    if (bootModelRestoredRef.current) return;
    if (!prefsHydrated || !keysLoaded) return;
    // Prefer the saved provider over re-deriving via tryGetModel — the model
    // registry may still be hydrating on cold boot (openai-compatible /v1/models
    // fetch hasn't returned yet) and we don't want that race to demote the
    // user's last pick to the workspace default.
    const savedProvider = prefLastProviderId as ProviderId | null;
    const savedHasKey =
      savedProvider != null && (providerNeedsKey(savedProvider) ? !!apiKeys[savedProvider] : true);
    if (prefLastModelId && savedProvider && savedHasKey) {
      setSelectedModelId(prefLastModelId, savedProvider);
    } else if (prefLastModelId && hasKeyForModel(prefLastModelId)) {
      // No saved provider (pre-fix data) — fall back to registry lookup.
      setSelectedModelId(prefLastModelId);
    } else {
      setSelectedModelId(prefDefaultModel);
    }
    bootModelRestoredRef.current = true;
  }, [
    prefsHydrated,
    keysLoaded,
    prefLastModelId,
    prefLastProviderId,
    prefDefaultModel,
    setSelectedModelId,
  ]);
  // Persist the active model + provider whenever they change (after the boot
  // restore has settled). This is what makes the next launch land on the same
  // model, with the same provider tag — avoiding the "registry race" that
  // would otherwise mis-label the chip when a stale duplicate id existed.
  useEffect(() => {
    const unsub = useChatStore.subscribe((s, prev) => {
      if (!bootModelRestoredRef.current) return;
      if (
        s.selectedModelId === prev.selectedModelId &&
        s.selectedProvider === prev.selectedProvider
      )
        return;
      if (s.selectedModelId !== prev.selectedModelId) {
        void setLastModelId(s.selectedModelId);
      }
      if (s.selectedProvider !== prev.selectedProvider) {
        void setLastProviderId(s.selectedProvider);
      }
    });
    return unsub;
  }, []);

  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
  }, [hydrateSessions]);

  // -------- workspaces wiring --------
  const wsHydrate = useWorkspacesStore((s) => s.hydrate);
  const wsHydrated = useWorkspacesStore((s) => s.hydrated);
  const wsList = useWorkspacesStore((s) => s.workspaces);
  const wsActiveId = useWorkspacesStore((s) => s.activeId);
  const wsSetActive = useWorkspacesStore((s) => s.setActiveId);
  const wsCreate = useWorkspacesStore((s) => s.createWorkspace);
  const wsRemove = useWorkspacesStore((s) => s.removeWorkspace);
  const wsSaveTabs = useWorkspacesStore((s) => s.saveWorkspaceTabs);

  // When the active workspace is closed, the store reassigns activeId to a
  // neighbor. We must skip the auto-snapshot effect for that transition so it
  // doesn't overwrite the neighbor's saved tabs with the closing workspace's
  // live tabs (which are still in `useTabs` until we rehydrate below).
  const skipNextSnapshotRef = useRef(false);

  // In-memory cache of each workspace's live Tab[] (including leaf ids) so
  // that switching back restores the *same* terminal leaf ids - keeps the
  // existing PTY/xterm sessions alive across workspace switches. The disk
  // snapshot via `serializeTabs` is still done for crash/restart recovery,
  // but live state takes precedence on switch.
  const liveTabsByWorkspace = useRef<Map<string, { tabs: Tab[]; activeId: number | null }>>(
    new Map(),
  );

  useEffect(() => {
    void wsHydrate();
  }, [wsHydrate]);

  // After the workspace store hydrates, load the active workspace's saved
  // tabs into the live tabs state. Skip if there are no saved tabs (first run
  // - the default `useTabs` initial state already covers it).
  const hydratedWorkspaceRef = useRef(false);
  useEffect(() => {
    if (!wsHydrated || hydratedWorkspaceRef.current) return;
    const active = wsList.find((w) => w.id === wsActiveId);
    if (!active) {
      hydratedWorkspaceRef.current = true;
      return;
    }
    if (active.tabs.length === 0) {
      hydratedWorkspaceRef.current = true;
      return;
    }
    const liveTabs: Tab[] = active.tabs.map((s) => savedToTab(s, allocId));
    const target = liveTabs[Math.min(active.activeTabIndex, liveTabs.length - 1)];
    replaceAllTabs(liveTabs, target?.id ?? null);
    hydratedWorkspaceRef.current = true;
  }, [wsHydrated, wsList, wsActiveId, replaceAllTabs, allocId]);

  // Auto-snapshot tabs whenever they change. Lightly debounced via the
  // autoSave window inside the workspaces LazyStore.
  useEffect(() => {
    if (!wsHydrated || !wsActiveId || !hydratedWorkspaceRef.current) return;
    if (skipNextSnapshotRef.current) {
      skipNextSnapshotRef.current = false;
      return;
    }
    const saved = serializeTabs(tabs);
    let savedIdx = 0;
    let i = -1;
    for (const t of tabs) {
      if (t.kind !== "ai-diff") i++;
      if (t.id === activeId) {
        savedIdx = i;
        break;
      }
    }
    wsSaveTabs(wsActiveId, saved, Math.max(0, savedIdx));
  }, [tabs, activeId, wsHydrated, wsActiveId, wsSaveTabs]);

  const switchToWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === wsActiveId) return;
      // Snapshot current first so we don't lose state.
      if (wsActiveId) {
        // Disk snapshot (for restart): drops live ids, keeps cwd/path.
        const saved = serializeTabs(tabs);
        let savedIdx = 0;
        let i = -1;
        for (const t of tabs) {
          if (t.kind !== "ai-diff") i++;
          if (t.id === activeId) {
            savedIdx = i;
            break;
          }
        }
        wsSaveTabs(wsActiveId, saved, Math.max(0, savedIdx));
        // Live snapshot (for in-session switches): keeps leaf ids so the
        // existing PTY/xterm sessions stay attached when the user comes back.
        liveTabsByWorkspace.current.set(wsActiveId, {
          tabs,
          activeId,
        });
      }
      wsSetActive(workspaceId);
      // Prefer the live cache - restores the exact leaf ids that the running
      // terminal sessions are keyed by, so the dispose effect doesn't kill
      // them.
      const cached = liveTabsByWorkspace.current.get(workspaceId);
      if (cached && cached.tabs.length > 0) {
        replaceAllTabs(cached.tabs, cached.activeId);
        return;
      }
      const next = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!next) return;
      const liveTabs: Tab[] =
        next.tabs.length === 0
          ? [defaultTabForEmptyWorkspace(allocId, home ?? undefined)]
          : next.tabs.map((s) => savedToTab(s, allocId));
      const target = liveTabs[Math.min(next.activeTabIndex, liveTabs.length - 1)] ?? liveTabs[0];
      replaceAllTabs(liveTabs, target?.id ?? null);
    },
    [wsActiveId, tabs, activeId, wsSaveTabs, wsSetActive, allocId, home, replaceAllTabs],
  );

  const createNewWorkspace = useCallback(() => {
    const n = wsList.length + 1;
    const ws = wsCreate(`Workspace ${n}`);
    switchToWorkspace(ws.id);
  }, [wsList.length, wsCreate, switchToWorkspace]);

  const closeWorkspace = useCallback(
    (workspaceId: string) => {
      const wasActive = workspaceId === wsActiveId;
      // Closing the active workspace: skip the upcoming auto-snapshot so we
      // don't clobber the neighbor's saved tabs with the closing workspace's
      // still-live tabs.
      if (wasActive) skipNextSnapshotRef.current = true;
      // Drop the cached live tabs for the closed workspace so its leaves are
      // no longer "live" - the next tabs-effect pass will dispose their PTYs.
      liveTabsByWorkspace.current.delete(workspaceId);
      wsRemove(workspaceId);
      if (!wasActive) return;
      const nextActiveId = useWorkspacesStore.getState().activeId;
      const next = useWorkspacesStore.getState().workspaces.find((w) => w.id === nextActiveId);
      if (!next) return;
      const cached = nextActiveId !== null ? liveTabsByWorkspace.current.get(nextActiveId) : null;
      if (cached && cached.tabs.length > 0) {
        replaceAllTabs(cached.tabs, cached.activeId);
        return;
      }
      const liveTabs: Tab[] =
        next.tabs.length === 0
          ? [defaultTabForEmptyWorkspace(allocId, home ?? undefined)]
          : next.tabs.map((s) => savedToTab(s, allocId));
      const target = liveTabs[Math.min(next.activeTabIndex, liveTabs.length - 1)] ?? liveTabs[0];
      replaceAllTabs(liveTabs, target?.id ?? null);
    },
    [wsActiveId, wsRemove, allocId, home, replaceAllTabs],
  );

  // -------- AI-diff reload bridge (per-leaf) --------
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const other of tabs) {
        if (other.kind !== "pane") continue;
        for (const leaf of leaves(other.paneTree)) {
          if (leaf.leafKind !== "editor") continue;
          if (leaf.path !== t.path) continue;
          editorRefs.current.get(leaf.id)?.reload();
        }
      }
    }
  }, [tabs]);

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    home,
    pickedRoot,
  );

  // When the active leaf changes (or the active tab changes), surface its
  // search addon / editor handle / detected URL for the chrome bits.
  useEffect(() => {
    setActiveSearchAddon(
      activeLeafIdInTab !== null && activeLeafKindCurrent === "terminal"
        ? (searchAddons.current.get(activeLeafIdInTab) ?? null)
        : null,
    );
    setActiveEditorHandle(
      activeLeafIdInTab !== null && activeLeafKindCurrent === "editor"
        ? (editorRefs.current.get(activeLeafIdInTab) ?? null)
        : null,
    );
    setActiveDetectedUrl(
      activeLeafIdInTab !== null && activeLeafKindCurrent === "terminal"
        ? (detectedUrls.current.get(activeLeafIdInTab) ?? null)
        : null,
    );
  }, [activeId, activeLeafIdInTab, activeLeafKindCurrent]);

  const handleDetectedLocalUrl = useCallback(
    (leafId: number, url: string) => {
      detectedUrls.current.set(leafId, url);
      if (leafId === activeLeafIdInTab) setActiveDetectedUrl(url);
    },
    [activeLeafIdInTab],
  );

  const detectedPreviewUrl = useMemo(() => {
    if (!isTerminalLike || !activeDetectedUrl) return null;
    const alreadyOpen = tabs.some(
      (t) => t.kind === "preview" && sameOrigin(t.url, activeDetectedUrl),
    );
    return alreadyOpen ? null : activeDetectedUrl;
  }, [isTerminalLike, activeDetectedUrl, tabs]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafIdInTab) setActiveSearchAddon(addon);
    },
    [activeLeafIdInTab],
  );

  const handleSshStatus = useCallback((leafId: number, status: SshStatus) => {
    setSshStatuses((prev) => {
      if (prev.get(leafId) === status) return prev;
      const next = new Map(prev);
      next.set(leafId, status);
      return next;
    });
  }, []);

  const disposeTab = useCallback(
    (id: number) => {
      // Per-leaf maps are pruned by the effect below when the tree shrinks;
      // only the tab-id-keyed handles (preview) need explicit cleanup here.
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  // Drives session disposal off the pane tree, not React lifecycles - split/
  // unsplit re-mount components but the leaf is still live.
  //
  // Workspace switches also flow through here: when the active workspace
  // changes, `tabs` becomes the new workspace's tabs and the prior
  // workspace's leaves would naively look "dead." To keep terminal sessions
  // alive across switches we treat the cached workspaces' leaves as still
  // live - only when a workspace is closed (its cache entry cleared) do its
  // sessions actually get disposed.
  const liveLeavesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const liveTerm = new Set<number>();
    const liveEditor = new Set<number>();
    const collect = (t: Tab) => {
      if (t.kind !== "pane") return;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal") liveTerm.add(l.id);
        else liveEditor.add(l.id);
      }
    };
    for (const t of tabs) collect(t);
    for (const cached of liveTabsByWorkspace.current.values()) {
      for (const t of cached.tabs) collect(t);
    }
    for (const id of liveLeavesRef.current) {
      if (!liveTerm.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = liveTerm;
    for (const k of [...terminalRefs.current.keys()])
      if (!liveTerm.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!liveTerm.has(k)) searchAddons.current.delete(k);
    for (const k of [...detectedUrls.current.keys()])
      if (!liveTerm.has(k)) detectedUrls.current.delete(k);
    for (const k of [...editorRefs.current.keys()])
      if (!liveEditor.has(k)) editorRefs.current.delete(k);
    setSshStatuses((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const k of next.keys()) {
        if (!liveTerm.has(k)) {
          next.delete(k);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  }, [tabs]);

  const handleClose = useCallback(
    (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "pane" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIdx].id);
    },
    [tabs, activeId, setActiveId],
  );

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || t.kind !== "pane") return null;
    const leaf = activeLeaf(t);
    if (!leaf) return null;
    if (leaf.leafKind === "terminal") {
      return terminalRefs.current.get(leaf.id)?.getSelection() ?? null;
    }
    return editorRefs.current.get(leaf.id)?.getSelection() ?? null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      window.dispatchEvent(new CustomEvent<string>("tedi:ai-attach-file", { detail: path }));
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeLeafKindCurrent === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [hasComposer, captureActiveSelection, focusInput, attachSelection, activeLeafKindCurrent]);

  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-input-bar]") ||
        el.closest("[data-ai-mini-window]")
      );
    };

    const paneLeafFor = (t: EventTarget | null): HTMLElement | null => {
      const el = t as HTMLElement | null;
      return el?.closest<HTMLElement>("[data-pane-leaf]") ?? null;
    };

    // Anchor the popup to the actual selection rect when possible, so it
    // hovers right above the highlighted text instead of where the mouse
    // happened to land. Falls back to the mouseup point for terminals where
    // the DOM selection API doesn't surface xterm's internal selection.
    const anchorFromSelection = (
      pane: HTMLElement,
      fallbackX: number,
      fallbackY: number,
    ): { x: number; y: number } => {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top };
          }
        }
        const xtermSel = pane.querySelector<HTMLElement>(
          ".xterm-selection > div, .xterm-selection-layer canvas",
        );
        if (xtermSel) {
          const rect = xtermSel.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top };
          }
        }
      } catch {
        // ignore — fall through to mouse coords
      }
      return { x: fallbackX, y: fallbackY };
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      // Only consider mouseups that land inside a terminal/editor pane —
      // otherwise a stale xterm selection could pop the button anywhere
      // (status bar, sidebar, tab strip, etc.).
      const pane = paneLeafFor(e.target);
      if (!pane) {
        setAskPopup(null);
        return;
      }
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          const { x, y } = anchorFromSelection(pane, e.clientX, e.clientY);
          setAskPopup({ x, y });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  const openNewTab = useCallback(() => {
    // Ctrl+T lands the new shell in whatever the file explorer is rooted at,
    // so a fresh tab always matches the folder the user is browsing.
    newTab(explorerRoot ?? inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab, explorerRoot]);

  const sendCd = useCallback(
    (path: string) => {
      // Treat a breadcrumb click as "open this folder": change the workspace
      // root so the explorer, AI workspace context, and inherited cwd for
      // new tabs all follow. Persist so it survives reloads.
      const normalized = path.replace(/\\/g, "/");
      setPickedRoot(normalized);
      try {
        localStorage.setItem("tedi.workspaceRoot", normalized);
      } catch {
        // Storage may be unavailable - skip persistence.
      }
      // Additionally, if the active leaf is a terminal at a shell prompt,
      // cd it so the running shell tracks the new workspace. Double-quote
      // wrapping works across pwsh / bash / zsh / cmd for paths without
      // shell metacharacters (which segmentsFromCwd outputs never contain).
      // We optimistically update the leaf cwd in React state so the
      // breadcrumb reflects the click immediately - shells that emit OSC 7
      // reconcile after, shells without shell integration still show the
      // intended target instead of being stuck at the prior cwd.
      if (activeLeafIdInTab !== null && activeLeafKindCurrent === "terminal") {
        setLeafCwd(activeLeafIdInTab, normalized);
        const term = terminalRefs.current.get(activeLeafIdInTab);
        if (term) {
          term.write(`cd "${normalized}"\r`);
          term.focus();
        }
      }
    },
    [activeLeafIdInTab, activeLeafKindCurrent, setLeafCwd],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "pane") return;
        const leaf = activeLeaf(tab);
        if (!leaf || leaf.leafKind !== "terminal") return;
        const t = terminalRefs.current.get(leaf.id);
        if (!t) return;
        const quoted = path.includes(" ") ? `'${path.replace(/'/g, `'\\''`)}'` : path;
        t.write(`cd ${quoted}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      openFileTab(path, pin ?? false);
    },
    [openFileTab],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        for (const leaf of leaves(t.paneTree)) {
          if (leaf.leafKind !== "editor") continue;
          if (leaf.path === from) {
            setEditorLeafPath(leaf.id, to);
          } else if (leaf.path.startsWith(`${from}/`)) {
            const suffix = leaf.path.slice(from.length);
            setEditorLeafPath(leaf.id, `${to}${suffix}`);
          }
        }
      }
    },
    [tabs, setEditorLeafPath],
  );

  const handlePathDeleted = useCallback(
    (path: string) => {
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        // If *any* editor leaf in this tab references the deleted path, drop
        // the whole tab - simpler than surgically removing one leaf and
        // matches the prior single-leaf behavior.
        const affected = leaves(t.paneTree).some(
          (l) => l.leafKind === "editor" && (l.path === path || l.path.startsWith(`${path}/`)),
        );
        if (affected) disposeTab(t.id);
      }
    },
    [tabs, disposeTab],
  );

  const activeFilePath = useMemo(() => {
    if (!activePaneTab) return null;
    const leaf = activeLeaf(activePaneTab);
    return leaf?.leafKind === "editor" ? leaf.path : null;
  }, [activePaneTab]);

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  /**
   * Ctrl+D / Ctrl+Shift+D: split the active pane within the active tab.
   * Adds a new terminal leaf next to the focused pane in the requested
   * direction:
   * - "row"  → new pane on the right of the focused one (horizontal split).
   * - "col"  → new pane below the focused one (vertical split).
   *
   * The new leaf becomes the active pane. Bounded by `MAX_PANES_PER_TAB`.
   */
  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return;
      // Ctrl+D / Ctrl+Shift+D: new pane lands in the explorer's root path,
      // matching the new-tab behavior so both flows are consistent.
      splitActivePane(activeId, dir, undefined, explorerRoot ?? undefined);
    },
    [activeId, splitActivePane, explorerRoot],
  );

  /**
   * Move a leaf from its current tab into `targetTabId` as a horizontal
   * split. Backed by `useTabs.moveLeafToTab` which preserves the leaf's id
   * so its underlying PTY / editor session survives the relocation. We
   * resolve the target's display title *before* the move so the toast can
   * name it even when the source tab is the one getting dropped.
   */
  const moveLeafToGroup = useCallback(
    (leafId: number, targetTabId: number) => {
      const target = tabsRef.current.find((x) => x.id === targetTabId);
      if (!target || target.kind !== "pane") return;
      const targetTitle = target.title;
      const result = moveLeafToTab(leafId, targetTabId);
      if (result === "full") {
        toast(`Group "${targetTitle}" is full (${MAX_PANES_PER_TAB} panes max).`, {
          variant: "warning",
        });
      }
    },
    [moveLeafToTab],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    // Multi-pane tab → close just the focused pane. Single-pane tab → close
    // the whole tab.
    if (t?.kind === "pane" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "tab.new": openNewTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => cycleTab(1),
      "tab.prev": () => cycleTab(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      // Ctrl+D → split horizontal (new tab beside the focused one).
      // Ctrl+Shift+D → split vertical (new tab stacks below the focused one).
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "search.focus": () => searchInlineRef.current?.focus(),
      "ai.toggle": togglePanelAndFocus,
      "ai.askSelection": askFromSelection,
      "shortcuts.open": () => void openSettingsWindow("shortcuts"),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "view.zoomIn": () => {
        const current = usePreferencesStore.getState().contentZoom;
        const next = Math.min(
          CONTENT_ZOOM_MAX,
          Math.round((current + CONTENT_ZOOM_STEP) * 100) / 100,
        );
        if (next !== current) void setContentZoom(next);
      },
      "view.zoomOut": () => {
        const current = usePreferencesStore.getState().contentZoom;
        const next = Math.max(
          CONTENT_ZOOM_MIN,
          Math.round((current - CONTENT_ZOOM_STEP) * 100) / 100,
        );
        if (next !== current) void setContentZoom(next);
      },
      "view.zoomReset": () => {
        if (usePreferencesStore.getState().contentZoom !== CONTENT_ZOOM_DEFAULT) {
          void setContentZoom(CONTENT_ZOOM_DEFAULT);
        }
      },
      "editor.toggleWordWrap": () => {
        void setLineWrap(!usePreferencesStore.getState().lineWrap);
      },
      // Ctrl+Shift+C — copy current terminal selection to clipboard. No-op
      // when nothing is selected (the event is still preventDefault'd by
      // useGlobalShortcuts so it never reaches xterm; `Ctrl+C` without
      // Shift falls through to xterm and sends SIGINT as expected).
      "terminal.copy": () => {
        if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
        const term = terminalRefs.current.get(activeLeafIdInTab);
        const sel = term?.getSelection();
        if (!sel) return;
        // navigator.clipboard works inside Tauri 2's webview without a
        // permission prompt. Fire-and-forget; failure is silent because
        // the only realistic cause is the document not being focused yet
        // (e.g., during a window-switch race) and the user can retry.
        void navigator.clipboard.writeText(sel).catch((e) => {
          console.warn("terminal.copy: clipboard write failed:", e);
        });
      },
      // Ctrl+Shift+V — paste clipboard into the active terminal via
      // term.paste so the shell sees a bracketed paste (multi-line
      // snippets don't execute line-by-line under bash/zsh).
      "terminal.paste": () => {
        if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
        const term = terminalRefs.current.get(activeLeafIdInTab);
        if (!term) return;
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch((e) => {
            console.warn("terminal.paste: clipboard read failed:", e);
          });
      },
      // Ctrl+Shift+X — close the focused terminal pane. Blocked when this
      // is the last terminal in the workspace so the user is never left
      // without a shell (mirrors the respawn rule in handleLeafExit).
      "terminal.close": () => {
        if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
        let terminalLeafCount = 0;
        for (const t of tabsRef.current) {
          if (t.kind !== "pane") continue;
          for (const l of leaves(t.paneTree)) if (l.leafKind === "terminal") terminalLeafCount++;
        }
        if (terminalLeafCount <= 1) return;
        closePaneByLeaf(activeLeafIdInTab);
      },
    }),
    [
      activeId,
      activeLeafIdInTab,
      activeLeafKindCurrent,
      closePaneByLeaf,
      cycleTab,
      handleCloseTabOrPane,
      openNewTab,
      openPreviewTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      togglePanelAndFocus,
      askFromSelection,
      toggleSidebar,
    ],
  );

  useGlobalShortcuts(shortcutHandlers);

  const registerTerminalHandle = useCallback((leafId: number, h: TerminalPaneHandle | null) => {
    if (h) terminalRefs.current.set(leafId, h);
    else terminalRefs.current.delete(leafId);
  }, []);

  const registerEditorHandle = useCallback(
    (leafId: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(leafId, h);
      else editorRefs.current.delete(leafId);
      if (leafId === activeLeafIdInTab) setActiveEditorHandle(h);
    },
    [activeLeafIdInTab],
  );

  const registerPreviewHandle = useCallback((id: number, h: PreviewPaneHandle | null) => {
    if (h) previewRefs.current.set(id, h);
    else previewRefs.current.delete(id);
  }, []);

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => setLeafCwd(leafId, cwd),
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!tab || tab.kind !== "pane") return;
      const terminalLeafCount = (() => {
        let n = 0;
        for (const t of all) {
          if (t.kind !== "pane") continue;
          for (const l of leaves(t.paneTree)) if (l.leafKind === "terminal") n++;
        }
        return n;
      })();
      // If this is the only terminal leaf left in the entire workspace,
      // respawn it instead of dropping the user into an empty UI.
      const targetLeaf = leaves(tab.paneTree).find((l) => l.id === leafId);
      const cwd = targetLeaf?.leafKind === "terminal" ? targetLeaf.cwd : undefined;
      if (terminalLeafCount === 1 && leafIds(tab.paneTree).length === 1) {
        void respawnSession(leafId, cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleTediOpen = useCallback(
    (_leafId: number, input: TediOpenInput) => {
      openFileTab(input.file);
    },
    [openFileTab],
  );

  // OSC 8889: shell (or a Laravel artisan command etc.) asks TEDI to open a
  // new terminal tab rooted at `cwd` and auto-run `cmd`. Used by tools like
  // Laravel's `php artisan dev:serve` to keep all dev processes inside TEDI
  // instead of spawning external cmd.exe windows.
  //
  // When `split` is set, split the most-recently-spawned pane in the same tab
  // instead of opening a new tab - lets `dev:serve` cluster Vite/Reverb/Queue
  // into one grouped tab with horizontal splits.
  const lastSpawnedTabIdRef = useRef<number | null>(null);
  const handleTediSpawnTab = useCallback(
    (_leafId: number, input: TediSpawnTabInput) => {
      const cwd = input.cwd;
      const cmd = input.cmd;

      const writeIntoLeaf = (leafId: number) => {
        if (!cmd) return;
        setTimeout(() => {
          const t = terminalRefs.current.get(leafId);
          if (!t) return;
          t.write(`${cmd}\r`);
          t.focus();
        }, 120);
      };

      // Split path: only valid if we have a previous spawned tab still alive.
      if (input.split) {
        const lastTabId = lastSpawnedTabIdRef.current;
        const lastTab = lastTabId !== null ? tabsRef.current.find((x) => x.id === lastTabId) : null;
        if (lastTab && lastTab.kind === "pane") {
          const newLeafId = splitActivePane(lastTabId!, input.split);
          if (newLeafId !== null) {
            writeIntoLeaf(newLeafId);
            return;
          }
          // Split refused (e.g. MAX_PANES_PER_TAB hit) - fall through to new tab.
        }
      }

      const tabId = newTab(cwd);
      lastSpawnedTabIdRef.current = tabId;
      if (!cmd) return;
      // Wait for the new pane's PTY to be ready, then inject the command.
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "pane") return;
        const leaf = activeLeaf(tab);
        if (!leaf || leaf.leafKind !== "terminal") return;
        const t = terminalRefs.current.get(leaf.id);
        if (!t) return;
        t.write(`${cmd}\r`);
        t.focus();
      }, 120);
    },
    [newTab, splitActivePane],
  );

  const handleEditorDirty = useCallback(
    (leafId: number, dirty: boolean) => setEditorLeafDirty(leafId, dirty),
    [setEditorLeafDirty],
  );

  const handleEditorCloseLeaf = useCallback(
    (leafId: number) => {
      // vim :q in a split pane should drop that pane, not the whole tab.
      const tab = tabsRef.current.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!tab || tab.kind !== "pane") return;
      if (leafIds(tab.paneTree).length > 1) {
        closePaneByLeaf(leafId);
      } else {
        handleClose(tab.id);
      }
    },
    [closePaneByLeaf, handleClose],
  );

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

  /** Markdown-preview toggle exposed to the Header. Non-null only when the
   *  active leaf is an editor pointed at a `.md`/`.markdown`/`.mdx` file. */
  const mdPreviewToggle = useMemo(() => {
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

  /** Word-wrap toggle exposed to the Header. Non-null when the active leaf is
   *  an editor (markdown preview hides the source, so suppress it then too). */
  const lineWrap = usePreferencesStore((s) => s.lineWrap);
  const lineWrapToggle = useMemo(() => {
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

  useEffect(() => {
    const findCwd = () => {
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "pane") {
        const leaf = activeLeaf(active);
        if (leaf?.leafKind === "terminal" && leaf.cwd) return leaf.cwd;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind === "terminal" && l.cwd) return l.cwd;
        }
      }
      return explorerRoot ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        const t = tabs.find((x) => x.id === activeId);
        if (!t || t.kind !== "pane") return null;
        const leaf = activeLeaf(t);
        if (!leaf || leaf.leafKind !== "terminal") return null;
        return terminalRefs.current.get(leaf.id)?.getBuffer(300) ?? null;
      },
      injectIntoActivePty: (text) => {
        const t = tabs.find((x) => x.id === activeId);
        if (!t || t.kind !== "pane") return false;
        const leaf = activeLeaf(t);
        if (!leaf || leaf.leafKind !== "terminal") return false;
        const term = terminalRefs.current.get(leaf.id);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => explorerRoot ?? home ?? null,
      getActiveFile: () => {
        const t = tabs.find((x) => x.id === activeId);
        if (!t || t.kind !== "pane") return null;
        const leaf = activeLeaf(t);
        return leaf?.leafKind === "editor" ? leaf.path : null;
      },
      openPreview: (url: string) => {
        openPreviewTab(url);
        return true;
      },
    });

    // Surface every open editor leaf to the AI input as a click-to-attach
    // suggestion chip. De-dup by path so the same file shared across split
    // panes only shows once.
    const openFiles: { path: string; name: string }[] = [];
    const seenPaths = new Set<string>();
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "editor") continue;
        if (seenPaths.has(l.path)) continue;
        seenPaths.add(l.path);
        const parts = l.path.split(/[\\/]/).filter(Boolean);
        openFiles.push({
          path: l.path,
          name: parts.length ? parts[parts.length - 1] : l.path,
        });
      }
    }
    setOpenEditorFiles(openFiles);
  }, [setLive, setOpenEditorFiles, activeId, tabs, explorerRoot, home, openPreviewTab]);

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="bg-background text-foreground relative flex h-screen flex-col overflow-hidden">
          <Header
            tabs={tabs}
            activeId={activeId}
            onSelectEntry={(tabId, leafId) => {
              setActiveId(tabId);
              if (leafId !== null) focusPane(tabId, leafId);
            }}
            onCloseEntry={(tabId, leafId) => {
              if (leafId !== null) {
                closePaneByLeaf(leafId);
              } else {
                handleClose(tabId);
              }
            }}
            onNewTerminal={openNewTab}
            onNewPreview={() => openPreviewTab("")}
            onNewEditor={() => setNewEditorOpen(true)}
            onPinLeaf={(tabId, leafId) => {
              focusPane(tabId, leafId);
              pinTab(tabId);
            }}
            onReorderTabs={reorderTabs}
            onToggleSidebar={toggleSidebar}
            onOpenFolder={openWorkspaceFolder}
            onSplit={splitActivePaneInActiveTab}
            canSplit={
              activePaneTab !== null && leafIds(activePaneTab.paneTree).length < MAX_PANES_PER_TAB
            }
            onOpenShortcuts={() => void openSettingsWindow("shortcuts")}
            onOpenSettings={() => void openSettingsWindow()}
            onConnectSsh={(conn) => newSshTab(conn.id, conn.name)}
            onMoveLeafToGroup={moveLeafToGroup}
            onRotateLeafSplit={rotateLeafSplit}
            sshStatuses={sshStatuses}
            searchTarget={searchTarget}
            searchRef={searchInlineRef}
            mdPreviewToggle={mdPreviewToggle}
            lineWrapToggle={lineWrapToggle}
          />

          <main className="flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize="225px"
                minSize="130px"
                maxSize="450px"
                collapsible
                collapsedSize={0}
              >
                <div className="border-border/60 bg-card flex h-full flex-col border-r">
                  <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
                    <ResizablePanel id="sidebar-files" defaultSize="50%" minSize="15%">
                      <FileExplorer
                        rootPath={explorerRoot}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onAttachToAgent={handleAttachFileToAgent}
                      />
                    </ResizablePanel>
                    {showSourceControl ? (
                      <>
                        <ResizableHandle withHandle />
                        <ResizablePanel id="sidebar-scm" defaultSize="25%" minSize="10%">
                          <SourceControlPanel
                            rootPath={explorerRoot}
                            onPathDeleted={handlePathDeleted}
                            onOpenDiff={openGitDiffTab}
                          />
                        </ResizablePanel>
                      </>
                    ) : null}
                    <ResizableHandle withHandle />
                    <ResizablePanel id="sidebar-workspaces" defaultSize="25%" minSize="10%">
                      <WorkspacesPanel
                        onSwitch={switchToWorkspace}
                        onCreate={createNewWorkspace}
                        onClose={closeWorkspace}
                        liveTabsCount={
                          tabs.filter((t) => t.kind === "pane" || t.kind === "preview").length
                        }
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="58%" minSize="25%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        !activePaneTab && "pointer-events-none invisible",
                      )}
                      aria-hidden={activePaneTab ? "false" : "true"}
                    >
                      <PaneStack
                        tabs={tabs}
                        activeId={activeId}
                        registerTerminalHandle={registerTerminalHandle}
                        onSearchReady={handleSearchReady}
                        onCwd={handleTerminalCwd}
                        onDetectedLocalUrl={handleDetectedLocalUrl}
                        onExit={handleLeafExit}
                        onTediOpen={handleTediOpen}
                        onTediSpawnTab={handleTediSpawnTab}
                        onSshStatus={handleSshStatus}
                        registerEditorHandle={registerEditorHandle}
                        onDirtyChange={handleEditorDirty}
                        onCloseLeaf={handleEditorCloseLeaf}
                        mdPreviewLeafIds={mdPreviewLeafIds}
                        onFocusLeaf={handleFocusLeaf}
                      />
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "preview" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "preview" ? "false" : "true"}
                    >
                      <PreviewStack
                        tabs={tabs}
                        activeId={activeId}
                        registerHandle={registerPreviewHandle}
                        onUrlChange={handlePreviewUrl}
                      />
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "ai-diff" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "ai-diff" ? "false" : "true"}
                    >
                      <AiDiffStack
                        tabs={tabs}
                        activeId={activeId}
                        onAccept={(id) => respondToApproval(id, true)}
                        onReject={(id) => respondToApproval(id, false)}
                      />
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "git-diff" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "git-diff" ? "false" : "true"}
                    >
                      <GitDiffStack tabs={tabs} activeId={activeId} />
                    </div>
                  </div>
                </div>
              </ResizablePanel>
              {keysLoaded && panelOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="ai-sidebar" defaultSize="22%" minSize="18%" maxSize="50%">
                    {hasComposer ? (
                      <AiSidebarPanel />
                    ) : (
                      <div className="border-border/60 bg-card/60 flex h-full flex-col border-l">
                        <AiInputBarConnect onAdd={() => void openSettingsWindow("models")} />
                      </div>
                    )}
                  </ResizablePanel>
                </>
              ) : null}
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
            onOpenPreview={() => {
              if (detectedPreviewUrl) openPreviewTab(detectedPreviewUrl);
            }}
          />

          {hasComposer ? (
            <AgentRunBridge openAiDiffTab={openAiDiffTab} setAiDiffStatus={setAiDiffStatus} />
          ) : null}

          <AnimatePresence>
            {askPopup ? (
              <SelectionAskAi
                key="ask-ai-popup"
                x={askPopup.x}
                y={askPopup.y}
                onAsk={onAskFromSelection}
                onDismiss={() => setAskPopup(null)}
              />
            ) : null}
          </AnimatePresence>

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <SshConnectionDialog
            open={sshEditorOpen}
            onOpenChange={(o) => {
              setSshEditorOpen(o);
              if (!o) setEditingSshConn(null);
            }}
            editing={editingSshConn}
          />

          <Toaster />

          <AlertDialog
            open={pendingCloseTab !== null}
            onOpenChange={(open) => !open && cancelClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {tabs.find((t) => t.id === pendingCloseTab)?.title
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseTab)?.title
                      }" has unsaved changes. Close anyway?`
                    : "This file has unsaved changes. Close anyway?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelClose}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={confirmClose}>Close Anyway</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
