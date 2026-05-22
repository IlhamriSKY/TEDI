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
import { setAppContext } from "@/modules/extensions/appBridge";
import type { AppContextSnapshot } from "@/modules/extensions/host";
import { setExtensionWorkspaceBridge } from "@/modules/extensions/workspaceBridge";
import { RightPanelHost, useExtensionsStore, useRightPanelStore } from "@/modules/extensions";
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
  setContentZoom,
  setLastModelId,
  setLastProviderId,
  setLineWrap,
  CONTENT_ZOOM_DEFAULT,
  CONTENT_ZOOM_MAX,
  CONTENT_ZOOM_MIN,
  CONTENT_ZOOM_STEP,
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
  MAX_PANES_PER_TAB,
  useTabs,
  useWorkspaceCwd,
  type Tab,
} from "@/modules/tabs";
import {
  disposeSession,
  ensureFsDragListener,
  findLeaf,
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
import type { SshStatus } from "@/modules/ssh/status";
import { toolDisplayName, type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { playBlockingBeep, playCompletionBeep } from "@/lib/blockingBeep";
import { scheduler, setSchedulerBridge } from "@/modules/scheduler";
import type { TerminalInfo, TerminalTarget } from "@/modules/scheduler/types";
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
const AiDiffStack = lazy(() =>
  import("@/modules/editor/AiDiffStack").then((m) => ({ default: m.AiDiffStack })),
);
const NewEditorDialog = lazy(() =>
  import("@/modules/editor/NewEditorDialog").then((m) => ({ default: m.NewEditorDialog })),
);
const PreviewStack = lazy(() =>
  import("@/modules/preview/PreviewStack").then((m) => ({ default: m.PreviewStack })),
);
const SshConnectionDialog = lazy(() =>
  import("@/modules/ssh/SshConnectionDialog").then((m) => ({ default: m.SshConnectionDialog })),
);
// Lazy-load the SFTP panel and its russh-sftp wrappers. Local-only
// workflows skip this code entirely.
const SshFileExplorer = lazy(() =>
  import("@/modules/ssh/SshFileExplorer").then((m) => ({ default: m.SshFileExplorer })),
);

/** Narrow context for live-terminal helpers. Subset of `liveContextRef.current`. */
type LiveTerminalCtx = {
  tabs: ReturnType<typeof useTabs>["tabs"];
  activeId: number;
};

/**
 * Snapshots all terminal leaves in tab order. `ordinal` is the leaf's
 * FIFO `terminalOrdinal` (the number on the TabBar chip), so "terminal 3"
 * maps to the same leaf across closes, drags, and restarts. Falls back to
 * positional numbering if the saved field is missing.
 */
function snapshotTerminals(ctx: LiveTerminalCtx): TerminalInfo[] {
  const out: TerminalInfo[] = [];
  let fallback = 0;
  for (const t of ctx.tabs) {
    if (t.kind !== "pane") continue;
    for (const l of leaves(t.paneTree)) {
      if (l.leafKind !== "terminal") continue;
      fallback += 1;
      out.push({
        tabId: t.id,
        leafId: l.id,
        ordinal: l.terminalOrdinal ?? fallback,
        title: t.title,
        cwd: l.cwd ?? null,
        isActive: t.id === ctx.activeId && t.activeLeafId === l.id,
      });
    }
  }
  return out;
}

/** Resolves a TerminalTarget to a leaf id. Order: leafId, tabId, ordinal, title substring. Empty target picks the active terminal. */
function resolveTerminalLeaf(target: TerminalTarget, ctx: LiveTerminalCtx): number | null {
  const list = snapshotTerminals(ctx);
  if (list.length === 0) return null;
  if (typeof target.leafId === "number") {
    const hit = list.find((r) => r.leafId === target.leafId);
    return hit ? hit.leafId : null;
  }
  if (typeof target.tabId === "number") {
    const hit =
      list.find((r) => r.tabId === target.tabId && r.isActive) ??
      list.find((r) => r.tabId === target.tabId);
    return hit ? hit.leafId : null;
  }
  if (typeof target.ordinal === "number") {
    const hit = list.find((r) => r.ordinal === target.ordinal);
    return hit ? hit.leafId : null;
  }
  if (typeof target.title === "string" && target.title.trim()) {
    const needle = target.title.trim().toLowerCase();
    const hit = list.find((r) => r.title.toLowerCase().includes(needle));
    return hit ? hit.leafId : null;
  }
  // Fall back to the active terminal.
  const active = list.find((r) => r.isActive);
  return active ? active.leafId : null;
}

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
    moveLeafToNewTab,
    rotateLeafSplit,
    replaceAllTabs,
    allocId,
    reorderTabs,
    reorderLeafInGroup,
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

  // Active leaf says what's focused in the current tab. Drives Search,
  // AI selection, CWD wiring, etc.
  const activeLeafIdInTab = activePaneTab?.activeLeafId ?? null;
  const activeLeafKindCurrent = activeTab ? activeLeafKind(activeTab) : null;

  // -------- runtime handles & search/url state --------
  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  // Per-leaf SSH status. React state so TabBar dot and StatusBar pill
  // rerender on transitions. Keyed by leafId; pruned with dead terminal
  // handles below.
  const [sshStatuses, setSshStatuses] = useState<Map<number, SshStatus>>(() => new Map());
  // Per-leaf AI CLI status (claude, codex, opencode, copilot, pi). Drives
  // the tab dot and the toast/beep on transition to "blocking". Pruned
  // with `sshStatuses`.
  const [aiCliStatuses, setAiCliStatuses] = useState<Map<number, AiCliStatus>>(() => new Map());
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
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
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

  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
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
    >("tedi:open-cli-target", (e) => {
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
  const contentZoom = usePreferencesStore((s) => s.contentZoom);
  // Expose the zoom factor as a CSS variable so CodeMirror and diff
  // surfaces can scale via `calc(... * var(--content-zoom))`. The terminal
  // reads the factor from the prefs store and multiplies into xterm's
  // `fontSize`. CSS `zoom` on a canvas/WebGL terminal breaks cursor and
  // glyph positioning, so we do not touch surfaces outside content.
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
  // Boot extensions after prefs so extension-contributed settings (themes,
  // slash commands, AI tools) land before first render. Idempotent.
  useEffect(() => {
    void useExtensionsStore.getState().init();
  }, []);

  // Right-panel and AI sidebar are mutually exclusive (both want the same
  // ~22% slot). Opening one closes the other. Each effect reacts to one
  // trigger and reads the other via `getState()`, avoiding ping-pong.
  const rightPanelActive = useRightPanelStore((s) => s.active);
  useEffect(() => {
    if (rightPanelActive && useChatStore.getState().panelOpen) {
      useChatStore.getState().closePanel();
    }
  }, [rightPanelActive]);
  useEffect(() => {
    if (panelOpen && useRightPanelStore.getState().active) {
      useRightPanelStore.getState().close();
    }
  }, [panelOpen]);

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

  const switchToWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === wsActiveId) return;
      // Snapshot current first.
      if (wsActiveId) {
        // Disk snapshot for restart. Drops live ids, keeps cwd/path.
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
        // Live snapshot for in-session switches. Keeps leaf ids so the
        // existing PTY/xterm sessions stay attached on return.
        liveTabsByWorkspace.current.set(wsActiveId, {
          tabs,
          activeId,
        });
      }
      wsSetActive(workspaceId);
      // Prefer the live cache so the leaf ids match the running terminal
      // sessions and the dispose effect doesn't kill them.
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
      // Closing the active workspace: skip the next auto-snapshot so the
      // closing workspace's live tabs don't clobber the neighbor's saved
      // tabs.
      if (wasActive) skipNextSnapshotRef.current = true;
      // Drop the cached live tabs so the closed workspace's leaves stop
      // being "live" and the next tabs-effect pass disposes their PTYs.
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

  // Snapshot of "what the user is doing now", pushed to extensions via
  // `setAppContext`. Extensions subscribe via `tedi.app.onContextChange`.
  // Core code stays free of integration-specific hooks.
  const activeFileName = useMemo(() => {
    if (!activePaneTab) return null;
    const leaf = activeLeaf(activePaneTab);
    if (!leaf || leaf.leafKind !== "editor") return null;
    const parts = leaf.path.split(/[\\/]/);
    return parts[parts.length - 1] || null;
  }, [activePaneTab]);
  const terminalCount = useMemo(() => {
    let n = 0;
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal") n += 1;
      }
    }
    return n;
  }, [tabs]);
  const activeTabKind = useMemo<AppContextSnapshot["activeTabKind"]>(() => {
    if (!activeTab) return null;
    if (activeTab.kind === "preview") return "preview";
    if (activeTab.kind === "ai-diff" || activeTab.kind === "git-diff") return "diff";
    if (activeTab.kind === "pane") {
      const leaf = activeLeaf(activeTab);
      if (!leaf) return null;
      if (leaf.leafKind === "editor") return "editor";
      // SSH leaves are marked by `sshConnectionId` at create time. The kind
      // only reflects how the leaf was opened, not its current status.
      if (leaf.leafKind === "terminal") {
        return leaf.sshConnectionId ? "ssh" : "terminal";
      }
    }
    return null;
  }, [activeTab]);
  useEffect(() => {
    setAppContext({
      workspaceCwd: explorerRoot,
      activeFileName,
      terminalCount,
      activeTabKind,
    });
  }, [explorerRoot, activeFileName, terminalCount, activeTabKind]);

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

  const handleSshStatus = useCallback((leafId: number, status: SshStatus) => {
    setSshStatuses((prev) => {
      if (prev.get(leafId) === status) return prev;
      const next = new Map(prev);
      next.set(leafId, status);
      return next;
    });
  }, []);

  // SFTP panel view: prefer the active leaf if it's a connected SSH leaf,
  // else any connected SSH leaf so the panel stays useful while the user
  // is in a local editor. Derived from tracked state, no extra IPC.
  const activeSshContext = useMemo<{
    sessionId: number | null;
    hostLabel: string | null;
    /** Active SSH leaf's last-known cwd from OSC 7. If set, the SSH file tree roots here instead of $HOME. */
    cwd: string | null;
  }>(() => {
    if (sshStatuses.size === 0) return { sessionId: null, hostLabel: null, cwd: null };
    const lookupLeafSession = (leafId: number): number | null => {
      const status = sshStatuses.get(leafId);
      if (status && status.kind === "connected") return status.sessionId;
      return null;
    };
    const hostLabelForTab = (tab: Tab | undefined): string | null =>
      tab && tab.kind === "pane" ? tab.title : null;

    // Active leaf if connected.
    if (activePaneTab) {
      const leaf = activeLeaf(activePaneTab);
      if (leaf && leaf.leafKind === "terminal" && leaf.sshConnectionId) {
        const sid = lookupLeafSession(leaf.id);
        if (sid !== null) {
          return {
            sessionId: sid,
            hostLabel: hostLabelForTab(activePaneTab),
            cwd: leaf.cwd ?? null,
          };
        }
      }
    }
    // Else any connected SSH leaf. Walks all pane tabs so a backgrounded
    // SSH session still drives the panel when the user is in a local tab.
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal" || !l.sshConnectionId) continue;
        const sid = lookupLeafSession(l.id);
        if (sid !== null)
          return { sessionId: sid, hostLabel: hostLabelForTab(t), cwd: l.cwd ?? null };
      }
    }
    return { sessionId: null, hostLabel: null, cwd: null };
  }, [sshStatuses, activePaneTab, tabs]);

  // Render the SFTP panel only after the session opens any SSH leaf. The
  // SshFileExplorer + sftp.ts chunk then loads once.
  const hasAnySshLeaf = useMemo(() => {
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal" && l.sshConnectionId) return true;
      }
    }
    return false;
  }, [tabs]);

  const handleAiCliStatus = useCallback((leafId: number, status: AiCliStatus) => {
    setAiCliStatuses((prev) => {
      try {
        const before = prev.get(leafId) ?? null;
        const sameTool = before?.tool === status?.tool;
        const sameState = before?.state === status?.state;
        if (sameTool && sameState) return prev;
        // Toast and beep gated by user preference. Tab badge updates either
        // way: the preference disables attention-grabbing feedback only.
        const notify = usePreferencesStore.getState().aiNotificationsEnabled;
        // Toast and beep on transition into blocking.
        if (notify && status && status.state === "blocking" && before?.state !== "blocking") {
          try {
            toast(`${toolDisplayName(status.tool)} needs your approval`, {
              variant: "warning",
              durationMs: 6000,
            });
            playBlockingBeep();
          } catch {
            // Notification failures are non-critical.
          }
        } else if (
          notify &&
          status &&
          status.state === "idle" &&
          before?.state === "working" &&
          status.tool === before.tool &&
          Date.now() - before.since >= 1500
        ) {
          // AI returned to idle after working. Skip when working lasted
          // under 1.5s to avoid spam from brief spinner flickers.
          try {
            toast(`${toolDisplayName(status.tool)} finished`, {
              variant: "success",
              durationMs: 4000,
            });
            playCompletionBeep();
          } catch {
            // Notification failures are non-critical.
          }
        }
        const next = new Map(prev);
        if (status) next.set(leafId, status);
        else next.delete(leafId);
        return next;
      } catch {
        return prev;
      }
    });
  }, []);

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

  const openNewTab = useCallback(() => {
    // Ctrl+T opens the new shell in the explorer's root so the tab matches
    // the folder being browsed.
    newTab(explorerRoot ?? inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab, explorerRoot]);

  const sendCd = useCallback(
    (path: string) => {
      // Breadcrumb click = open this folder. Updates the workspace root so
      // the explorer, AI workspace context, and inherited cwd follow.
      // Persisted across reloads.
      const normalized = path.replace(/\\/g, "/");
      setPickedRoot(normalized);
      try {
        localStorage.setItem("tedi.workspaceRoot", normalized);
      } catch {
        // Storage unavailable. Skip persistence.
      }
      // If the active leaf is a terminal, cd it too so the shell tracks
      // the new workspace. Double quotes work across pwsh/bash/zsh/cmd for
      // paths without shell metacharacters (segmentsFromCwd outputs never
      // contain any). React state updates the cwd optimistically so the
      // breadcrumb reflects the click immediately. Shells with OSC 7
      // reconcile after, shells without it still show the target.
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

  // Wire the extension workspace bridge to the live file-open handler.
  // Extensions mounting `ctx.ui.mountFolderTree` route click-to-open
  // through this bridge so they get the same behavior as the left
  // explorer.
  useEffect(() => {
    setExtensionWorkspaceBridge({
      openFile: (path, opts) => handleOpenFile(path, opts?.pin ?? false),
    });
    return () => setExtensionWorkspaceBridge(null);
  }, [handleOpenFile]);

  // SSH tree calls this when the user clicks a remote file. Pin the tab
  // because preview-mode shares one slot with local previews and would
  // silently replace whichever local file is in preview.
  const handleOpenRemoteFile = useCallback(
    (path: string, sessionId: number, hostLabel: string | null) => {
      openFileTab(path, true, {
        sshSessionId: sessionId,
        sshHostLabel: hostLabel ?? "remote",
      });
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
        // If any editor leaf in this tab references the deleted path, drop
        // the whole tab. Matches the prior single-leaf behavior.
        const affected = leaves(t.paneTree).some(
          (l) => l.leafKind === "editor" && (l.path === path || l.path.startsWith(`${path}/`)),
        );
        if (affected) disposeTab(t.id);
      }
    },
    [tabs, disposeTab],
  );

  // Absolute local path of the file currently being viewed. Drives the
  // status-bar breadcrumb and the file-explorer "reveal" behavior, so it
  // must cover every tab kind that has a workspace file backing it:
  // editor leaf, AI-proposed diff, and git diff. SSH editor leaves are
  // excluded — their `path` is remote and would never match the local
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
   * Ctrl+D / Ctrl+Shift+D: splits the active pane in the active tab.
   * "row" puts the new pane to the right, "col" puts it below. The new
   * leaf becomes active. Capped at `MAX_PANES_PER_TAB`.
   */
  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return;
      // New pane uses the explorer's root, matching the new-tab flow.
      splitActivePane(activeId, dir, undefined, explorerRoot ?? undefined);
    },
    [activeId, splitActivePane, explorerRoot],
  );

  /**
   * Moves a leaf into `targetTabId` as a horizontal split. The leaf's id
   * is preserved so its PTY / editor session survives. Resolves the
   * target title before the move so the toast can name it if the source
   * tab is dropped.
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
      // Ctrl+D: horizontal split (new pane beside focus).
      // Ctrl+Shift+D: vertical split (new pane below focus).
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
      // Ctrl+Shift+C: copy terminal selection. No-op when nothing is
      // selected. useGlobalShortcuts preventDefaults the event so xterm
      // never sees it. Ctrl+C without Shift falls through to xterm and
      // sends SIGINT.
      "terminal.copy": () => {
        if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
        const term = terminalRefs.current.get(activeLeafIdInTab);
        const sel = term?.getSelection();
        if (!sel) return;
        // navigator.clipboard works in Tauri 2's webview without prompting.
        // Fire-and-forget; the usual failure is the document not yet
        // focused (window-switch race) and the user can retry.
        void navigator.clipboard.writeText(sel).catch((e) => {
          console.warn("terminal.copy: clipboard write failed:", e);
        });
      },
      // Ctrl+Shift+V: paste clipboard via term.paste so the shell gets a
      // bracketed paste (multi-line snippets don't auto-execute line by
      // line under bash/zsh).
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
      // Ctrl+Shift+X: close the focused terminal pane. Blocked when it's
      // the last terminal in the workspace, mirroring the respawn rule in
      // handleLeafExit.
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

  // Generic dispatcher for extension-contributed keybindings. Walks
  // `keybindingsRegistry` and `commandsRegistry` on each keydown and
  // fires the matching command. No per-extension wiring here.
  useExtensionShortcuts();

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
      // Respawn if this is the only terminal leaf left, so the UI isn't
      // empty.
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

  // OSC 8889: shell asks TEDI to open a new terminal tab at `cwd` and run
  // `cmd`. Used by tools like Laravel's `php artisan dev:serve` to keep
  // dev processes inside TEDI instead of spawning cmd.exe windows.
  //
  // If `split` is set, splits the last spawned pane in the same tab
  // instead of opening a new tab. Lets `dev:serve` cluster
  // Vite/Reverb/Queue into one tab with horizontal splits.
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

      // Split path requires a previous spawned tab still alive.
      if (input.split) {
        const lastTabId = lastSpawnedTabIdRef.current;
        const lastTab = lastTabId !== null ? tabsRef.current.find((x) => x.id === lastTabId) : null;
        if (lastTab && lastTab.kind === "pane") {
          const newLeafId = splitActivePane(lastTabId!, input.split);
          if (newLeafId !== null) {
            writeIntoLeaf(newLeafId);
            return;
          }
          // Split refused (e.g. MAX_PANES_PER_TAB). Fall through to new tab.
        }
      }

      const tabId = newTab(cwd);
      lastSpawnedTabIdRef.current = tabId;
      if (!cmd) return;
      // Wait for the new PTY to be ready before injecting the command.
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
      // `:q` in a split pane should close only that pane.
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
    setLive({
      getCwd: () => {
        const { tabs, activeId, explorerRoot, home } = liveContextRef.current;
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
      },
      getTerminalContext: (lines) => {
        const { tabs, activeId } = liveContextRef.current;
        const t = tabs.find((x) => x.id === activeId);
        if (!t || t.kind !== "pane") return null;
        const leaf = activeLeaf(t);
        if (!leaf || leaf.leafKind !== "terminal") return null;
        const n = Math.max(1, Math.min(2000, lines ?? 300));
        return terminalRefs.current.get(leaf.id)?.getBuffer(n) ?? null;
      },
      injectIntoActivePty: (text) => {
        const { tabs, activeId } = liveContextRef.current;
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
      getWorkspaceRoot: () => {
        const { explorerRoot, home } = liveContextRef.current;
        return explorerRoot ?? home ?? null;
      },
      getActiveFile: () => {
        const { tabs, activeId } = liveContextRef.current;
        const t = tabs.find((x) => x.id === activeId);
        if (!t || t.kind !== "pane") return null;
        const leaf = activeLeaf(t);
        return leaf?.leafKind === "editor" ? leaf.path : null;
      },
      openPreview: (url: string) => {
        liveContextRef.current.openPreviewTab(url);
        return true;
      },
      openTerminal: (cwd) => {
        const { explorerRoot, newTab, inheritedCwdForNewTab } = liveContextRef.current;
        const target = cwd ?? explorerRoot ?? inheritedCwdForNewTab();
        newTab(target ?? undefined);
        return true;
      },
      runInActiveTerminal: (command) => {
        const { tabs, activeId } = liveContextRef.current;
        const t = tabs.find((x) => x.id === activeId);
        if (!t || t.kind !== "pane") return false;
        const leaf = activeLeaf(t);
        if (!leaf || leaf.leafKind !== "terminal") return false;
        const term = terminalRefs.current.get(leaf.id);
        if (!term) return false;
        // Strip trailing newlines, submit with CR. Windows ConPTY + pwsh
        // require \r, not \n. Matches sendCd / cdInNewTab above.
        const trimmed = command.replace(/[\r\n]+$/, "");
        term.write(`${trimmed}\r`);
        term.focus();
        return true;
      },
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
      openTerminalAdvanced: (opts: {
        cwd?: string | null;
        mode?: "tab" | "split";
        splitDir?: "row" | "col";
        targetTabId?: number | null;
      }) => {
        const {
          tabs,
          activeId,
          explorerRoot,
          inheritedCwdForNewTab,
          splitActivePane,
          newTab,
          setActiveId,
        } = liveContextRef.current;
        const mode = opts.mode ?? "tab";
        const cwd = opts.cwd ?? null;
        if (mode === "split") {
          const targetTabId = opts.targetTabId ?? activeId;
          const target = tabs.find((x) => x.id === targetTabId);
          if (!target) return { ok: false, error: `tab ${targetTabId} not found` };
          if (target.kind !== "pane")
            return { ok: false, error: `tab ${targetTabId} is not a pane tab` };
          if (leafIds(target.paneTree).length >= MAX_PANES_PER_TAB)
            return { ok: false, error: `tab ${targetTabId} already has MAX_PANES_PER_TAB panes` };
          // Focus the target tab so the split operates on it.
          if (targetTabId !== activeId) setActiveId(targetTabId);
          const dir = opts.splitDir ?? "row";
          const cwdResolved =
            cwd ??
            (() => {
              const active = findLeaf(target.paneTree, target.activeLeafId);
              return active?.leafKind === "terminal" ? (active.cwd ?? null) : null;
            })() ??
            explorerRoot ??
            null;
          const newLeafId = splitActivePane(targetTabId, dir, "terminal", cwdResolved ?? undefined);
          if (newLeafId === null)
            return { ok: false, error: "could not split (active leaf missing or limit reached)" };
          return { ok: true, tabId: targetTabId, leafId: newLeafId, mode: "split" };
        }
        const targetCwd = cwd ?? explorerRoot ?? inheritedCwdForNewTab();
        try {
          const newTabId = newTab(targetCwd ?? undefined);
          return { ok: true, tabId: newTabId, leafId: null, mode: "tab" };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      consolidateTerminalsIntoGroup: (targetTabId) => {
        const { tabs, moveLeafToTab, setActiveId } = liveContextRef.current;
        const target = tabs.find((x) => x.id === targetTabId);
        if (!target) return { ok: false, error: `tab ${targetTabId} not found` };
        if (target.kind !== "pane")
          return { ok: false, error: `tab ${targetTabId} is not a pane tab` };
        const allTerminals = snapshotTerminals(liveContextRef.current);
        if (allTerminals.length === 0)
          return { ok: false, error: "no terminals open to consolidate" };
        if (allTerminals.length > MAX_PANES_PER_TAB)
          return {
            ok: false,
            error: `cannot consolidate ${allTerminals.length} terminals into one tab — the per-tab cap is ${MAX_PANES_PER_TAB}. Close some or merge in batches.`,
          };
        let moved = 0;
        let alreadyInGroup = 0;
        for (const t of allTerminals) {
          if (t.tabId === targetTabId) {
            alreadyInGroup += 1;
            continue;
          }
          const r = moveLeafToTab(t.leafId, targetTabId);
          if (r === "ok") {
            moved += 1;
          } else if (r === "full") {
            return {
              ok: false,
              error: "target tab filled up mid-move",
              movedBeforeFailure: moved,
            };
          } else {
            return {
              ok: false,
              error: `move failed (${r})`,
              movedBeforeFailure: moved,
            };
          }
        }
        // Focus the consolidated group.
        setActiveId(targetTabId);
        return { ok: true, targetTabId, moved, alreadyInGroup };
      },
      closeTerminalLeaf: (leafId) => {
        const { tabs, closePaneByLeaf } = liveContextRef.current;
        const owner = tabs.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
        if (!owner || owner.kind !== "pane")
          return { ok: false, error: `leaf ${leafId} not found` };
        const onlyLeafInTab = leafIds(owner.paneTree).length === 1;
        const onlyTab = tabs.filter((t) => t.kind === "pane").length === 1;
        if (onlyLeafInTab && onlyTab)
          return { ok: false, error: "refusing to close the last terminal" };
        closePaneByLeaf(leafId);
        return { ok: true, closedTab: onlyLeafInTab };
      },
    });
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
  useEffect(() => {
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
  }, [setOpenEditorFiles, tabs]);

  // Stable props for memoised footer/sidebar children so unrelated state
  // churn (AI streaming, PaneStack ticks) doesn't re-render them. Inline
  // arrows or per-render expressions would defeat memo equality.
  const handleOpenDetectedPreview = useCallback(() => {
    if (detectedPreviewUrl) openPreviewTab(detectedPreviewUrl);
  }, [detectedPreviewUrl, openPreviewTab]);
  const handleAddProviderKey = useCallback(() => void openSettingsWindow("models"), []);
  const liveTabsCount = useMemo(
    () => tabs.filter((t) => t.kind === "pane" || t.kind === "preview").length,
    [tabs],
  );

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
            onReorderLeafInGroup={reorderLeafInGroup}
            onToggleSidebar={toggleSidebar}
            onOpenFolder={openWorkspaceFolder}
            onSplit={splitActivePaneInActiveTab}
            canSplit={
              activePaneTab !== null && leafIds(activePaneTab.paneTree).length < MAX_PANES_PER_TAB
            }
            onOpenShortcuts={() => void openSettingsWindow("shortcuts")}
            onOpenExtensions={() => void openSettingsWindow("extensions")}
            onOpenSettings={() => void openSettingsWindow()}
            onConnectSsh={(conn) => newSshTab(conn.id, conn.name)}
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
                    {showSourceControl ? (
                      <>
                        <ResizableHandle withHandle />
                        <ResizablePanel id="sidebar-scm" defaultSize="20%" minSize="10%">
                          <Suspense fallback={null}>
                            <SourceControlPanel
                              rootPath={explorerRoot}
                              onPathDeleted={handlePathDeleted}
                              onOpenDiff={openGitDiffTab}
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
                        onAiCliStatus={handleAiCliStatus}
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
                  </div>
                </div>
              </ResizablePanel>
              {/* Right slot shared by the AI sidebar and extension right
                  panels. Mutual exclusion is enforced by the coordinator
                  effects above. This precedence covers the one-tick gap
                  before the loser closes: a fresh `rightPanelActive`
                  reflects the user's latest click, so render that and
                  let the AI panel close in the background. */}
              {rightPanelActive || (keysLoaded && panelOpen) ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="right-slot" defaultSize="22%" minSize="18%" maxSize="50%">
                    {rightPanelActive ? (
                      <RightPanelHost />
                    ) : hasComposer ? (
                      <AiSidebarPanel />
                    ) : (
                      <div className="border-border/60 bg-card/60 flex h-full flex-col border-l">
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

          {/* Mount-once. Defers the chunk until first open, then stays
              mounted so Radix's exit animation plays and reopens skip the
              chunk-load cost. */}
          {newEditorMounted ? (
            <Suspense fallback={null}>
              <NewEditorDialog
                open={newEditorOpen}
                onOpenChange={setNewEditorOpen}
                rootPath={explorerRoot ?? home}
                onCreated={(path) => openFileTab(path)}
              />
            </Suspense>
          ) : null}

          {sshEditorMounted ? (
            <Suspense fallback={null}>
              <SshConnectionDialog
                open={sshEditorOpen}
                onOpenChange={(o) => {
                  setSshEditorOpen(o);
                  if (!o) setEditingSshConn(null);
                }}
                editing={editingSshConn}
              />
            </Suspense>
          ) : null}

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
