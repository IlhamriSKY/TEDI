/**
 * App.tsx - the main-window top-level COORDINATOR (not a feature dump).
 *
 * This is intentionally the largest file in src/: it wires modules together
 * rather than implementing features (those live in src/modules/<area>/). When
 * hunting for where a behavior is set up, these are the regions:
 *
 *   - Bridges to the extension host (setSidebarSetter / setRightSidebarSetter /
 *     setAppContext) and the AI live-context bridge (setLive).
 *   - Terminal snapshot + target-resolution helpers (snapshotTerminals,
 *     resolveTerminalLeaf) used by workspace save/restore and AI tools.
 *   - Workspace switch / create / close orchestration.
 *   - Right-panel mutual-exclusion effects (SCM / AI / extension panels).
 *   - The global shortcut-handler map (id -> handler) consumed by
 *     useGlobalShortcuts.
 *
 * See ARCHITECTURE.md for the two-process model and TEDI.md for full detail.
 */
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster, toast } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentRunBridge, getAllKeys, hasAnyKey, hasKeyForModel, useChatStore } from "@/modules/ai";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBar";
import { providerNeedsKey, type ProviderId } from "@/modules/ai/config";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import {
  clearOpenAICompatibleInstance,
  refreshOpenAICompatibleInstance,
} from "@/modules/ai/lib/openaiCompatible";
import { getOpenAICompatibleInstanceKey } from "@/modules/ai/lib/keyring";
import { clearSumopodModels, refreshSumopodModels } from "@/modules/ai/lib/sumopod";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { usePromptsStore } from "@/modules/ai/store/promptsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { setEditorBridge } from "@/modules/extensions/editorBridge";
import { ExtensionTabStack } from "@/modules/extensions/components/ExtensionTabStack";
import { RightPanelHost, useExtensionsStore, useRightPanelStore } from "@/modules/extensions";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import { type EditorPaneHandle } from "@/modules/editor";
import { FileExplorer } from "@/modules/explorer";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Header, type SearchInlineHandle, type SearchTarget } from "@/modules/header";
import { PaneStack } from "@/modules/panes";
import { type PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  onKeysChanged,
  setLastModelId,
  setLastProviderId,
  setLineWrap,
} from "@/modules/settings/store";
import {
  useExtensionShortcuts,
  useGlobalShortcuts,
  type ShortcutHandlers,
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
  disposeSession,
  ensureFsDragListener,
  leaves,
  useTerminalFileDrop,
  type PaneLeaf,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { type SshConnection } from "@/modules/ssh/connections";
import { scheduler, setSchedulerBridge } from "@/modules/scheduler";
import { resolveTerminalLeaf, snapshotTerminals } from "./lib/terminalSnapshot";
import { buildShortcutHandlers } from "./lib/shortcutHandlers";
import { buildLiveContext } from "./lib/buildLiveContext";
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
import { AppDialogs } from "./components/AppDialogs";
import {
  savedToTab,
  serializeTabs,
  useWorkspacesStore,
  WorkspacesPanel,
} from "@/modules/workspaces";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IPC_EVENTS } from "@/lib/ipc";
import type { SearchAddon } from "@xterm/addon-search";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

// Code-split. Each chunk loads only when its UI is opened:
//   - Source Control mounts when `showSourceControl` is on
//   - Diff stacks render null until a relevant tab exists
//   - Preview stack mounts once a preview tab exists
//   - Dialogs mount only while `open` is true
const SourceControlPanel = lazy(() =>
  import("@/modules/scm/SourceControlPanel").then((m) => ({ default: m.SourceControlPanel })),
);
const GitDiffStack = lazy(() =>
  import("@/modules/scm/GitDiffStack").then((m) => ({ default: m.GitDiffStack })),
);
const ScmStack = lazy(() =>
  import("@/modules/scm/ScmStack").then((m) => ({ default: m.ScmStack })),
);
const AiDiffStack = lazy(() =>
  import("@/modules/editor/AiDiffStack").then((m) => ({ default: m.AiDiffStack })),
);
const PreviewStack = lazy(() =>
  import("@/modules/preview/PreviewStack").then((m) => ({ default: m.PreviewStack })),
);
// Lazy-load the SFTP panel and its russh-sftp wrappers. Local-only
// workflows skip this code entirely.
const SshFileExplorer = lazy(() =>
  import("@/modules/ssh/SshFileExplorer").then((m) => ({ default: m.SshFileExplorer })),
);
const AiSidebarPanel = lazy(() =>
  import("@/modules/ai/components/AiMiniWindow").then((m) => ({ default: m.AiSidebarPanel })),
);

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
    openExtensionTab,
    setExtensionTabState,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
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

  // Lazy-mount the diff/preview stacks. Chunks only load once a tab of
  // that kind exists.
  const hasPreviewTab = useMemo(() => tabs.some((t) => t.kind === "preview"), [tabs]);
  const hasAiDiffTab = useMemo(() => tabs.some((t) => t.kind === "ai-diff"), [tabs]);
  const hasGitDiffTab = useMemo(() => tabs.some((t) => t.kind === "git-diff"), [tabs]);
  const hasScmTab = useMemo(() => tabs.some((t) => t.kind === "scm"), [tabs]);
  const hasExtensionTab = useMemo(() => tabs.some((t) => t.kind === "ext"), [tabs]);

  // Active leaf says what's focused in the current tab. Drives Search,
  // AI selection, CWD wiring, etc.
  const activeLeafIdInTab = activePaneTab?.activeLeafId ?? null;
  const activeLeafKindCurrent = activeTab ? activeLeafKind(activeTab) : null;

  // -------- runtime handles & search/url state --------
  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [editingSshConn, setEditingSshConn] = useState<SshConnection | null>(null);
  const [sshEditorOpen, setSshEditorOpen] = useState(false);
  // Latches the first time each lazy dialog opens. Stays true; see the
  // dialog mount sites for why.
  const [sshEditorMounted, setSshEditorMounted] = useState(false);
  useEffect(() => {
    if (sshEditorOpen) setSshEditorMounted(true);
  }, [sshEditorOpen]);
  const [activeSearchAddon, setActiveSearchAddon] = useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const detectedUrls = useRef<Map<number, string>>(new Map());
  const [activeDetectedUrl, setActiveDetectedUrl] = useState<string | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] = useState<EditorPaneHandle | null>(null);
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
      // Storage unavailable (private mode etc.). Skip persistence.
    }
    // Open a terminal tab rooted at the picked folder.
    newTab(normalized);
  }, [pickedRoot, activePaneTab, tabs, home, newTab]);

  useEffect(() => {
    // Forward slashes so explorerRoot matches across home and OSC 7.
    homeDir()
      .then((p) => setHome(p.replace(/\\/g, "/")))
      .catch(() => setHome(null));
  }, []);

  // Handles `tedi .` / `tedi <path>`. Drained from Rust on boot and pushed
  // live by the single-instance plugin when a second `tedi` invocation
  // forwards its argv. Folder: adopt as root and open a terminal there.
  // File: adopt parent as root and open the file in an editor tab.
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
        // Storage unavailable. Skip persistence.
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

  // Drain the captured startup target once. Rust clears its slot on read,
  // so a webview reload won't replay it.
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

  // Live forwarding from `tauri-plugin-single-instance` when `tedi <path>`
  // runs while this window is already up.
  useEffect(() => {
    const unlistenP = listen<
      { kind: "folder"; path: string } | { kind: "file"; path: string; parent: string }
    >(IPC_EVENTS.OPEN_CLI_TARGET, (e) => {
      if (e.payload) openCliTarget(e.payload);
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, [openCliTarget]);

  // -------- AI composer / chat store wiring --------
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [newEditorMounted, setNewEditorMounted] = useState(false);
  useEffect(() => {
    if (newEditorOpen) setNewEditorMounted(true);
  }, [newEditorOpen]);
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
        // Refresh SumoPod models when the key arrives or changes.
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
  const prefDefaultProvider = usePreferencesStore((s) => s.defaultProviderId);
  const prefLastModelId = usePreferencesStore((s) => s.lastModelId);
  const prefLastProviderId = usePreferencesStore((s) => s.lastProviderId);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  const sourceControlInRightPanel = usePreferencesStore((s) => s.sourceControlInRightPanel);
  const scmRightOpen = useScmRightPanelStore((s) => s.open);
  const closeScmRight = useScmRightPanelStore((s) => s.closePanel);
  const contentZoom = usePreferencesStore((s) => s.contentZoom);
  // UI zoom scales the chrome only (header / tabs, sidebar, side panels, status
  // bar) plus portaled overlays, which mount on `document.body` outside `#root`.
  // The workspace pane counter-zooms back to 1 (see `workspaceCounterZoom`
  // below) so terminal / editor / preview keep native resolution and their
  // own `--content-zoom`.
  const uiZoom = usePreferencesStore((s) => s.uiZoom);
  // Apply --content-zoom (CSS var) and body.zoom from the prefs values.
  useApplyZoom(contentZoom, uiZoom);
  const openaiCompatibleInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  useEffect(() => {
    // Detect models for every configured openai-compatible endpoint. Each
    // instance's key is read from the OS keychain by its instance id (the
    // default instance reuses the legacy unsuffixed account). An instance with
    // no key or no base URL is cleared rather than fetched.
    let cancelled = false;
    void (async () => {
      for (const inst of openaiCompatibleInstances) {
        if (!inst.baseURL) {
          clearOpenAICompatibleInstance(inst.id);
          continue;
        }
        const key = await getOpenAICompatibleInstanceKey(inst.id);
        if (cancelled) return;
        if (!key) {
          clearOpenAICompatibleInstance(inst.id);
          continue;
        }
        void refreshOpenAICompatibleInstance(inst.id, key, inst.baseURL);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `apiKeys` kept as a dependency so a key change in the same window
    // re-triggers detection (keychain writes don't otherwise notify here).
  }, [openaiCompatibleInstances, apiKeys]);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  // Boot extensions after prefs so extension-contributed settings (themes,
  // slash commands, AI tools) land before first render. Idempotent.
  useEffect(() => {
    void useExtensionsStore.getState().init();
  }, []);

  // Right-panel, SCM right panel, and AI sidebar are mutually exclusive
  // (all three want the same ~22% slot). Opening one closes the others.
  // Each effect reacts to one trigger and reads the others via
  // `getState()`, avoiding ping-pong. The fourth effect closes the SCM
  // right panel when the relevant prefs flip off.
  const rightPanelActive = useRightPanelStore((s) => s.active);
  useRightPanelExclusion(
    rightPanelActive,
    panelOpen,
    scmRightOpen,
    sourceControlInRightPanel,
    showSourceControl,
    closeScmRight,
  );

  // Honor manifest `defaultOpen` for right-surface panels once per session.
  // Reads from the extensions store so this runs after `bootAll()` or when
  // an extension is enabled. `markDefaultOpenHandled` stops us reopening a
  // panel the user has closed.
  const extensionsList = useExtensionsStore((s) => s.list);
  const extensionsHydrated = useExtensionsStore((s) => s.hydrated);
  useEffect(() => {
    if (!extensionsHydrated) return;
    const store = useRightPanelStore.getState();
    for (const ext of extensionsList) {
      if (!ext.enabled) continue;
      const panels = ext.manifest.contributes.panels ?? [];
      for (const panel of panels) {
        if (panel.surface !== "right" || panel.defaultOpen !== true) continue;
        if (store.markDefaultOpenHandled(ext.id, panel.id)) {
          store.open(ext.id, panel.id);
          // First defaultOpen wins. The user can toggle the rest.
          return;
        }
      }
    }
  }, [extensionsHydrated, extensionsList]);

  // Hide an active right-panel target whose extension is now disabled or
  // uninstalled, so the slot doesn't show a dead header.
  useEffect(() => {
    if (!rightPanelActive) return;
    const owner = extensionsList.find((e) => e.id === rightPanelActive.extensionId && e.enabled);
    const hasPanel =
      owner?.manifest.contributes.panels?.some((p) => p.id === rightPanelActive.panelId) ?? false;
    if (!owner || !hasPanel) {
      useRightPanelStore.getState().close();
    }
  }, [extensionsList, rightPanelActive]);
  // One-shot boot restore. Picks the last-used model, falling back to the
  // workspace default if it's gone (key removed, model deleted). The ref
  // guards against late prefs/keys hydration clobbering a fresh user pick.
  const bootModelRestoredRef = useRef(false);
  useEffect(() => {
    if (bootModelRestoredRef.current) return;
    if (!prefsHydrated || !keysLoaded) return;
    // Use the saved provider instead of re-deriving via tryGetModel. The
    // registry may still be hydrating (openai-compatible /v1/models hasn't
    // returned), and that race would demote the last pick to default.
    const savedProvider = prefLastProviderId as ProviderId | null;
    const savedHasKey =
      savedProvider != null && (providerNeedsKey(savedProvider) ? !!apiKeys[savedProvider] : true);
    if (prefLastModelId && savedProvider && savedHasKey) {
      setSelectedModelId(prefLastModelId, savedProvider);
    } else if (prefLastModelId && hasKeyForModel(prefLastModelId)) {
      // Pre-fix data: no saved provider. Fall back to registry lookup.
      setSelectedModelId(prefLastModelId);
    } else if (prefDefaultProvider) {
      // Explicit default provider sidesteps the id/provider ambiguity that
      // lastProviderId fixes for the active selection.
      setSelectedModelId(prefDefaultModel, prefDefaultProvider as ProviderId);
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
    prefDefaultProvider,
    setSelectedModelId,
    apiKeys,
  ]);
  // Persist the active model and provider on change (after boot restore
  // settles). Lets the next launch land on the same model and provider,
  // avoiding the registry race that would mislabel the chip.
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
    // The agent runs in THIS (main) window; prompt overrides are saved from the
    // separate Settings webview. Hydrate here so getPromptOverrides() sees them
    // at runtime without waiting for the Settings panel to mount.
    void usePromptsStore.getState().hydrate();
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

  // When the active workspace is closed, activeId is reassigned to a
  // neighbor. Skip the auto-snapshot for that transition so it doesn't
  // overwrite the neighbor's saved tabs with the closing workspace's
  // live tabs (still in `useTabs` until we rehydrate below).
  const skipNextSnapshotRef = useRef(false);

  // In-memory cache of each workspace's live Tab[] (with leaf ids) so a
  // switch back restores the same terminal leaf ids and keeps PTY/xterm
  // sessions alive. `serializeTabs` still writes to disk for crash
  // recovery, but live state wins on switch.
  const liveTabsByWorkspace = useRef<Map<string, { tabs: Tab[]; activeId: number | null }>>(
    new Map(),
  );

  useEffect(() => {
    void wsHydrate();
  }, [wsHydrate]);

  // Once the workspace store hydrates, load the active workspace's saved
  // tabs into live state. Skip if there are none (first run already covered
  // by the default `useTabs` state).
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
  // The bridge closures read live state on each call so an extension that
  // hangs onto `ctx.editor` always reaches the currently-focused leaf, not
  // whichever editor happened to be active when the extension activated.
  const editorBridgeStateRef = useRef<{
    handle: EditorPaneHandle | null;
    leaf: PaneLeaf | null;
  }>({ handle: null, leaf: null });
  editorBridgeStateRef.current = {
    handle: activeEditorHandle,
    leaf: activePaneTab ? activeLeaf(activePaneTab) : null,
  };
  useEffect(() => {
    setEditorBridge({
      getActive() {
        const { handle, leaf } = editorBridgeStateRef.current;
        if (!handle || !leaf || leaf.leafKind !== "editor") return null;
        const content = handle.getContent();
        if (content === null) return null;
        const dirty = (leaf as PaneLeaf & { dirty?: boolean }).dirty === true;
        return { path: leaf.path, content, dirty };
      },
      setActiveContent(content) {
        const { handle, leaf } = editorBridgeStateRef.current;
        if (!handle || !leaf || leaf.leafKind !== "editor") return false;
        return handle.setContent(content);
      },
    });
    return () => setEditorBridge(null);
  }, []);

  // On active leaf or tab change, surface its search addon, editor handle,
  // and detected URL to the chrome.
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
      // Per-leaf maps are pruned by the effect below. Only tab-id-keyed
      // handles (preview) need explicit cleanup here.
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  // Disposes sessions by pane tree, not React lifecycle. Split and unsplit
  // remount components but the leaf is still live.
  //
  // Workspace switches flow through here too. When the active workspace
  // changes, `tabs` becomes the new workspace's tabs and the prior
  // workspace's leaves would look dead. To keep their sessions alive, we
  // treat cached workspaces' leaves as live. Only a closed workspace
  // (cache entry cleared) disposes its sessions.
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
    setAiCliStatuses((prev) => {
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
    previewRefs,
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

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || t.kind !== "pane") return null;
    const leaf = activeLeaf(t);
    if (!leaf) return null;
    // Private leaves never expose their selection to the AI. Returning
    // null here suppresses the Ask-AI popup and short-circuits attachSelection.
    if (leaf.private) return null;
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

    // Anchor the popup to the selection rect when possible so it sits above
    // the highlighted text, not the mouse. Falls back to the mouseup point
    // for terminals where the DOM selection API doesn't expose xterm's
    // selection.
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
        // Fall through to mouse coords.
      }
      return { x: fallbackX, y: fallbackY };
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      // Only handle mouseups inside a terminal/editor pane. A stale xterm
      // selection could otherwise pop the button in the status bar,
      // sidebar, or tab strip.
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

  const { handleOpenFile, handleOpenRemoteFile, handlePathRenamed, handlePathDeleted } =
    useFileActions({
      tabs,
      disposeTab,
      openFileTab,
      setEditorLeafPath,
    });

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

  const {
    registerTerminalHandle,
    registerEditorHandle,
    registerPreviewHandle,
    handlePreviewUrl,
    handleTerminalCwd,
    handlePtyId,
    handleFocusLeaf,
    handleLeafExit,
    handleTediOpen,
    handleTediSpawnTab,
    handleEditorDirty,
    handleEditorCloseLeaf,
    handlePaneHeaderClose,
  } = usePaneHandles({
    terminalRefs,
    editorRefs,
    previewRefs,
    tabsRef,
    activeLeafIdInTab,
    setActiveEditorHandle,
    handleClose,
    updateTab,
    setLeafCwd,
    setLeafPtyId,
    focusPane,
    closePaneByLeaf,
    openFileTab,
    splitActivePane,
    newTab,
    setEditorLeafDirty,
  });

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

  /** Word-wrap toggle for the Header. Non-null when the active leaf is an editor and not in markdown preview. */
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

  // Mirror values needed by `setLive` closures into refs so the closures
  // stay stable. The chat store holds the live object and never
  // resubscribes (consumers read via getState() in event handlers), so
  // rebuilding the closures on every `tabs` mutation (including
  // per-keystroke dirty flips) wastes work.
  const liveContextRef = useRef({
    tabs,
    activeId,
    explorerRoot,
    home,
    openPreviewTab,
    newTab,
    inheritedCwdForNewTab,
    splitActivePane,
    setActiveId,
    moveLeafToTab,
    closePaneByLeaf,
  });
  liveContextRef.current = {
    tabs,
    activeId,
    explorerRoot,
    home,
    openPreviewTab,
    newTab,
    inheritedCwdForNewTab,
    splitActivePane,
    setActiveId,
    moveLeafToTab,
    closePaneByLeaf,
  };

  useEffect(() => {
    setLive(buildLiveContext({ liveContextRef, terminalRefs }));
  }, [setLive]);

  // Boot the schedule-trigger engine once. Bridge closures read live
  // state through `liveContextRef` and stay valid across re-renders.
  useEffect(() => {
    setSchedulerBridge({
      listTerminals: () => snapshotTerminals(liveContextRef.current),
      injectIntoTerminal: (target, text) => {
        const leafId = resolveTerminalLeaf(target, liveContextRef.current);
        if (leafId === null) return false;
        const term = terminalRefs.current.get(leafId);
        if (!term) return false;
        term.write(text);
        return true;
      },
      runInTerminal: (target, command) => {
        const leafId = resolveTerminalLeaf(target, liveContextRef.current);
        if (leafId === null) return false;
        const term = terminalRefs.current.get(leafId);
        if (!term) return false;
        const trimmed = command.replace(/[\r\n]+$/, "");
        term.write(`${trimmed}\r`);
        return true;
      },
      notify: (message, level) => {
        const variant =
          level === "success"
            ? "success"
            : level === "warning"
              ? "warning"
              : level === "error"
                ? "error"
                : "info";
        toast(message, { variant });
      },
    });
    void scheduler.boot();
    // Prune fired/cancelled history every 5min to keep the store small.
    const interval = window.setInterval(() => {
      void scheduler.pruneHistory();
    }, 5 * 60_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  // Surface every open editor leaf as a click-to-attach chip in the AI
  // input. De-dup by path so split panes don't duplicate. The setter
  // short-circuits on shape-equal lists, so most keystroke runs are
  // no-ops downstream.
  //
  // Private editor leaves are excluded so their path never appears as a
  // chip or mention-picker entry - preventing the user from accidentally
  // attaching a private file to the AI conversation.
  useEffect(() => {
    const openFiles: { path: string; name: string }[] = [];
    const seenPaths = new Set<string>();
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "editor") continue;
        if (l.private) continue;
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
  }, [setOpenEditorFiles, tabs]);

  const liveTabsCount = useMemo(
    () => tabs.filter((t) => t.kind === "pane" || t.kind === "preview").length,
    [tabs],
  );

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
                    {/* Files section: outer panel hosts the local tree on
                        top and, when an SSH leaf is connected, the remote
                        tree below. Each inner panel collapses to its h-8
                        header. */}
                    <ResizablePanel
                      id="sidebar-files"
                      defaultSize={hasAnySshLeaf ? "65%" : "40%"}
                      minSize="20%"
                    >
                      {/* Plain flex stack. See `localFilesCollapsed`
                          comment for why this is not a nested
                          ResizablePanelGroup. Each section is `flex-1`
                          when open and `h-8 shrink-0` when collapsed.
                          Both collapse independently; the parent
                          ResizablePanel still drag-resizes against SCM
                          and Workspaces below. */}
                      <div className="flex h-full min-h-0 flex-col">
                        <div
                          className={cn("min-h-0", localFilesCollapsed ? "h-8 shrink-0" : "flex-1")}
                        >
                          <FileExplorer
                            rootPath={explorerRoot}
                            onOpenFile={handleOpenFile}
                            onPathRenamed={handlePathRenamed}
                            onPathDeleted={handlePathDeleted}
                            onRevealInTerminal={cdInNewTab}
                            onAttachToAgent={handleAttachFileToAgent}
                            collapsed={localFilesCollapsed}
                            onToggleCollapsed={toggleLocalFiles}
                            activeFilePath={activeFilePath}
                            hideSort
                          />
                        </div>
                        {hasAnySshLeaf ? (
                          <div
                            className={cn(
                              "border-border/60 min-h-0 border-t",
                              sshFilesCollapsed ? "h-8 shrink-0" : "flex-1",
                            )}
                          >
                            <Suspense fallback={null}>
                              <SshFileExplorer
                                sessionId={activeSshContext.sessionId}
                                hostLabel={activeSshContext.hostLabel}
                                currentCwd={activeSshContext.cwd}
                                onOpenFile={handleOpenRemoteFile}
                                collapsed={sshFilesCollapsed}
                                onToggleCollapsed={toggleSshFiles}
                              />
                            </Suspense>
                          </div>
                        ) : null}
                      </div>
                    </ResizablePanel>
                    {showSourceControl && !sourceControlInRightPanel ? (
                      <>
                        <ResizableHandle withHandle />
                        <ResizablePanel id="sidebar-scm" defaultSize="20%" minSize="10%">
                          <Suspense fallback={null}>
                            <SourceControlPanel
                              rootPath={explorerRoot}
                              onPathDeleted={handlePathDeleted}
                              onOpenDiff={openGitDiffTab}
                              onOpenInTab={openScmTab}
                            />
                          </Suspense>
                        </ResizablePanel>
                      </>
                    ) : null}
                    <ResizableHandle withHandle />
                    <ResizablePanel id="sidebar-workspaces" defaultSize="15%" minSize="10%">
                      <WorkspacesPanel
                        onSwitch={switchToWorkspace}
                        onCreate={createNewWorkspace}
                        onClose={closeWorkspace}
                        liveTabsCount={liveTabsCount}
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="58%" minSize="25%">
                {/* Counter the body-level UI zoom so the panes (terminal,
                    editor, preview, diffs) render at their native scale.
                    Net effective zoom here is uiZoom * (1 / uiZoom) = 1. */}
                <div
                  className="flex h-full min-h-0 flex-col"
                  style={uiZoom === 1 ? undefined : { zoom: 1 / uiZoom }}
                >
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
                        onAiCliStatus={handleAiCliStatus}
                        onPtyId={handlePtyId}
                        registerEditorHandle={registerEditorHandle}
                        onDirtyChange={handleEditorDirty}
                        onCloseLeaf={handleEditorCloseLeaf}
                        mdPreviewLeafIds={mdPreviewLeafIds}
                        onFocusLeaf={handleFocusLeaf}
                        onMovePaneLeaf={movePaneLeafToEdge}
                        onCloseLeafRequest={handlePaneHeaderClose}
                        sshStatuses={sshStatuses}
                        aiCliStatuses={aiCliStatuses}
                      />
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "preview" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "preview" ? "false" : "true"}
                    >
                      {hasPreviewTab ? (
                        <Suspense fallback={null}>
                          <PreviewStack
                            tabs={tabs}
                            activeId={activeId}
                            registerHandle={registerPreviewHandle}
                            onUrlChange={handlePreviewUrl}
                          />
                        </Suspense>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "ai-diff" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "ai-diff" ? "false" : "true"}
                    >
                      {hasAiDiffTab ? (
                        <Suspense fallback={null}>
                          <AiDiffStack
                            tabs={tabs}
                            activeId={activeId}
                            onAccept={(id) => respondToApproval(id, true)}
                            onReject={(id) => respondToApproval(id, false)}
                          />
                        </Suspense>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "git-diff" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "git-diff" ? "false" : "true"}
                    >
                      {hasGitDiffTab ? (
                        <Suspense fallback={null}>
                          <GitDiffStack tabs={tabs} activeId={activeId} />
                        </Suspense>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0 px-3 pt-2 pb-2",
                        activeTab?.kind !== "scm" && "pointer-events-none invisible",
                      )}
                      aria-hidden={activeTab?.kind === "scm" ? "false" : "true"}
                    >
                      {hasScmTab ? (
                        <Suspense fallback={null}>
                          <ScmStack
                            tabs={tabs}
                            activeId={activeId}
                            rootPath={explorerRoot}
                            onPathDeleted={handlePathDeleted}
                            onOpenDiff={openGitDiffTab}
                          />
                        </Suspense>
                      ) : null}
                    </div>
                    {hasExtensionTab ? (
                      <div
                        className={cn(
                          "absolute inset-0",
                          activeTab?.kind !== "ext" && "pointer-events-none invisible",
                        )}
                        aria-hidden={activeTab?.kind === "ext" ? "false" : "true"}
                      >
                        <ExtensionTabStack tabs={tabs} activeId={activeId} />
                      </div>
                    ) : null}
                  </div>
                </div>
              </ResizablePanel>
              {/* Right slot shared by the AI sidebar and extension right
                  panels. Mutual exclusion is enforced by the coordinator
                  effects above. This precedence covers the one-tick gap
                  before the loser closes: a fresh `rightPanelActive`
                  reflects the user's latest click, so render that and
                  let the AI panel close in the background. */}
              {rightPanelActive || scmRightOpen || (keysLoaded && panelOpen) ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="right-slot" defaultSize="22%" minSize="18%" maxSize="50%">
                    {rightPanelActive ? (
                      <RightPanelHost />
                    ) : scmRightOpen ? (
                      <div className="border-border/60 bg-card/60 tedi-glass-panel flex h-full min-h-0 flex-col border-l">
                        <Suspense fallback={null}>
                          <SourceControlPanel
                            rootPath={explorerRoot}
                            onPathDeleted={handlePathDeleted}
                            onOpenDiff={openGitDiffTab}
                            onClose={closeScmRight}
                            onOpenInTab={openScmTab}
                          />
                        </Suspense>
                      </div>
                    ) : hasComposer ? (
                      <Suspense fallback={null}>
                        <AiSidebarPanel />
                      </Suspense>
                    ) : (
                      <div className="border-border/60 bg-card/60 tedi-glass-panel flex h-full flex-col border-l">
                        <AiInputBarConnect onAdd={handleAddProviderKey} />
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
