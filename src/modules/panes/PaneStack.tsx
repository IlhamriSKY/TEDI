import type { EditorPaneHandle } from "@/modules/editor";
import type { PaneTab, Tab } from "@/modules/tabs";
import { leaves, type PaneEdge, type SplitDir } from "@/modules/terminal/lib/panes";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { TediOpenInput, TediSpawnTabInput } from "@/modules/terminal/lib/useTerminalSession";
import type { SshConnectionBinding, SshStatus } from "@/modules/ssh/status";
import { useSshHosts } from "@/modules/ssh/connections";
import type { AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef } from "react";
import { PaneTreeView, type LeafBundle } from "./PaneTreeView";

type Props = {
  tabs: Tab[];
  activeId: number;
  // Terminal leaf callbacks
  registerTerminalHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onDetectedLocalUrl: (leafId: number, url: string) => void;
  onExit: (leafId: number, code: number) => void;
  onTediOpen?: (leafId: number, input: TediOpenInput) => void;
  onTediSpawnTab?: (leafId: number, input: TediSpawnTabInput) => void;
  onSshStatus?: (leafId: number, status: SshStatus) => void;
  onAiCliStatus?: (leafId: number, status: AiCliStatus) => void;
  /**
   * Fires once whenever a leaf's PTY acquires a daemon UUID. Forwarded
   * to `App.tsx` which writes it onto the leaf's `ptyId` field so the
   * workspace serializer persists it for restore.
   */
  onPtyId?: (leafId: number, ptyId: string) => void;
  // Editor leaf callbacks
  registerEditorHandle: (leafId: number, handle: EditorPaneHandle | null) => void;
  onDirtyChange: (leafId: number, dirty: boolean) => void;
  onCloseLeaf: (leafId: number) => void;
  // Preview (browser) leaf callbacks
  onBrowserUrlChange: (leafId: number, url: string) => void;
  /** Editor leaf ids rendered as markdown preview instead of source. */
  mdPreviewLeafIds: ReadonlySet<number>;
  // Shared
  onFocusLeaf: (tabId: number, leafId: number) => void;
  /** Drag-and-drop a leaf onto an edge of another leaf in the same tab. */
  onMovePaneLeaf?: (sourceLeafId: number, targetLeafId: number, edge: PaneEdge) => void;
  /** Close button in each pane header. */
  onCloseLeafRequest?: (leafId: number) => void;
  /** Split a pane (next to `targetLeafId` in `targetTabId`) with an open
   *  extension tab, relocating that tab into the pane. */
  onSplitWithExtTab?: (
    extTabId: number,
    targetTabId: number,
    targetLeafId: number,
    dir: SplitDir,
  ) => void;
  /** Set (or clear, with `null`) a terminal leaf's per-pane theme override.
   *  `themeId` is a `TERMINAL_PRESETS` id. Backs the header "Terminal theme" menu. */
  onSetTerminalTheme?: (leafId: number, themeId: string | null) => void;
  /** Flip a markdown editor leaf between source and preview, from its pane header. */
  onToggleMdPreview?: (leafId: number) => void;
  /** Detected local URL for the focused pane header's "open preview" globe. */
  detectedBrowserUrl?: string | null;
  onOpenPreview?: () => void;
  /** Persist a split node's per-child size percentages after a divider drag. */
  onSplitSizes?: (splitId: number, sizes: number[]) => void;
  /** Live SSH status per terminal leaf id. Colors the SSH header label, mirroring the tab strip. */
  sshStatuses?: Map<number, SshStatus>;
  /** Live AI CLI status per terminal leaf id. Tints the header icon, mirroring the tab strip. */
  aiCliStatuses?: Map<number, AiCliStatus>;
  /** Live session per saved SSH connection. A remote editor leaf holds a
   *  connection id (which survives a restart) and reads its session from here. */
  sshBindingByConnection?: Map<string, SshConnectionBinding>;
  /** Open an SSH session for a saved connection, from a remote editor pane that
   *  has no live session to bind to. */
  onReconnectSsh?: (connectionId: string, title: string) => void;
};

export function PaneStack({
  tabs,
  activeId,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onDetectedLocalUrl,
  onExit,
  onTediOpen,
  onTediSpawnTab,
  onSshStatus,
  onAiCliStatus,
  onPtyId,
  registerEditorHandle,
  onDirtyChange,
  onCloseLeaf,
  onBrowserUrlChange,
  mdPreviewLeafIds,
  onFocusLeaf,
  onMovePaneLeaf,
  onCloseLeafRequest,
  onSplitWithExtTab,
  onSetTerminalTheme,
  onToggleMdPreview,
  detectedBrowserUrl,
  onOpenPreview,
  onSplitSizes,
  sshStatuses,
  aiCliStatuses,
  sshBindingByConnection,
  onReconnectSsh,
}: Props) {
  // Memoize the filter so the prune effect below sees a stable identity.
  const paneTabs = useMemo(() => tabs.filter((t): t is PaneTab => t.kind === "pane"), [tabs]);

  // Open extension tabs offered in the per-pane "Split with…" context menu.
  // All tab kinds carry `id` + `title`, so no narrowing cast is needed.
  const extTabList = useMemo(
    () => tabs.filter((t) => t.kind === "ext").map((t) => ({ id: t.id, title: t.title })),
    [tabs],
  );

  // Resolve a leaf's `sshConnectionId` to a host for the `ssh:<host>` header
  // label. Read here (not per-leaf), from the same hook the tab strip and the
  // Workspaces panel use, so all three read identically.
  const sshHosts = useSshHosts();

  // Stable refs for per-leaf callbacks. Re-creating bundles would tear down PTY/editor state.
  // Bundles are only invoked from post-commit PTY/editor/async callbacks, so a render-time ref
  // write is behavior-equivalent (mirrors useTerminalSession.ts).
  const cbRef = useRef({
    registerTerminalHandle,
    onSearchReady,
    onCwd,
    onDetectedLocalUrl,
    onExit,
    onTediOpen,
    onTediSpawnTab,
    onSshStatus,
    onAiCliStatus,
    onPtyId,
    registerEditorHandle,
    onDirtyChange,
    onCloseLeaf,
    onBrowserUrlChange,
  });
  cbRef.current = {
    registerTerminalHandle,
    onSearchReady,
    onCwd,
    onDetectedLocalUrl,
    onExit,
    onTediOpen,
    onTediSpawnTab,
    onSshStatus,
    onAiCliStatus,
    onPtyId,
    registerEditorHandle,
    onDirtyChange,
    onCloseLeaf,
    onBrowserUrlChange,
  };

  const bundles = useRef(new Map<number, LeafBundle>());
  const getBundle = (leafId: number): LeafBundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setTerminalRef: (h) => cbRef.current.registerTerminalHandle(leafId, h),
        onSearchReady: (addon) => cbRef.current.onSearchReady(leafId, addon),
        onCwd: (cwd) => cbRef.current.onCwd(leafId, cwd),
        onDetectedLocalUrl: (url) => cbRef.current.onDetectedLocalUrl(leafId, url),
        onExit: (code) => cbRef.current.onExit(leafId, code),
        onTediOpen: (input) => cbRef.current.onTediOpen?.(leafId, input),
        onTediSpawnTab: (input) => cbRef.current.onTediSpawnTab?.(leafId, input),
        onSshStatus: (status) => cbRef.current.onSshStatus?.(leafId, status),
        onAiCliStatus: (status) => cbRef.current.onAiCliStatus?.(leafId, status),
        onPtyId: (ptyId) => cbRef.current.onPtyId?.(leafId, ptyId),
        setEditorRef: (h) => cbRef.current.registerEditorHandle(leafId, h),
        onDirtyChange: (dirty) => cbRef.current.onDirtyChange(leafId, dirty),
        onCloseLeaf: () => cbRef.current.onCloseLeaf(leafId),
        onBrowserUrlChange: (url) => cbRef.current.onBrowserUrlChange(leafId, url),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  // Prune per-leaf bundles whose leaf has disappeared from the active
  // workspace's tabs. The native browser webview close decision lives in
  // useSessionDisposal instead, which reconciles against ALL workspaces so a
  // preview leaf isn't destroyed merely because its workspace went inactive.
  useEffect(() => {
    const live = new Set<number>();
    for (const t of paneTabs) {
      for (const l of leaves(t.paneTree)) {
        live.add(l.id);
      }
    }
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [paneTabs]);

  return (
    <div className="relative h-full w-full">
      {paneTabs.map((t) => {
        const tabVisible = t.id === activeId;
        return (
          <div
            key={t.id}
            // Hide inactive tabs at the wrapper. Panes stay mounted so PTY and
            // editor state survive tab switches; hidden DOM ignores pointer
            // events so resize handles from inactive tabs don't leak through.
            // Each hidden TerminalPane additionally uses `display: none` so
            // WebView2 cannot composite an inactive xterm scrollbar above
            // this active wrapper.
            className={
              tabVisible
                ? "bg-background absolute inset-0"
                : "pointer-events-none invisible absolute inset-0"
            }
            aria-hidden={tabVisible ? "false" : "true"}
          >
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
              mdPreviewLeafIds={mdPreviewLeafIds}
              onMovePaneLeaf={onMovePaneLeaf}
              onCloseLeaf={onCloseLeafRequest}
              extTabs={extTabList}
              onSplitWithExtTab={
                onSplitWithExtTab
                  ? (extTabId, leafId, dir) => onSplitWithExtTab(extTabId, t.id, leafId, dir)
                  : undefined
              }
              onSetTerminalTheme={onSetTerminalTheme}
              onToggleMdPreview={onToggleMdPreview}
              detectedBrowserUrl={detectedBrowserUrl}
              onOpenPreview={onOpenPreview}
              // A board leaf charts the WHOLE workspace, so it gets every tab,
              // not just the one it happens to live in.
              boardTabs={tabs}
              // Already the two-arg form: a board card focuses a pane in ANOTHER
              // tab, which the per-tab wrapper below cannot address.
              onFocusEntry={onFocusLeaf}
              onSplitSizes={onSplitSizes}
              sshHosts={sshHosts}
              sshStatuses={sshStatuses}
              aiCliStatuses={aiCliStatuses}
              sshBindingByConnection={sshBindingByConnection}
              onReconnectSsh={onReconnectSsh}
            />
          </div>
        );
      })}
    </div>
  );
}
