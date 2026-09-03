import type { EditorPaneHandle } from "@/modules/editor";
import type { PaneTab, Tab } from "@/modules/tabs";
import { leaves, type PaneEdge, type SplitDir } from "@/modules/terminal/lib/panes";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { TediOpenInput, TediSpawnTabInput } from "@/modules/terminal/lib/useTerminalSession";
import type { SshConnectionBinding, SshStatus } from "@/modules/ssh/status";
import { useSshHosts } from "@/modules/ssh/connections";
import { useAiSessionTitles } from "@/modules/ai/lib/sessionTitles";
import { useAiSessionStatus } from "@/modules/ai/lib/sessionStatus";
import type { AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef } from "react";
import { PaneTreeView, type LeafBundle, type PaneMetaValue } from "./PaneTreeView";
import { CanvasView, type CanvasAdders } from "./CanvasView";
import type { CanvasRect } from "@/modules/terminal/lib/panes";
import type { OpenDiffInput } from "@/modules/scm/types";

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
  /** Detected local dev-server URL. Renders the globe beside the float button
   *  on the header of `previewLeafId`. `null` hides it. */
  previewUrl?: string | null;
  /** Pane that carries the globe: the leaf that printed the url, so it does not
   *  hop between headers as panes take focus. */
  previewLeafId?: number | null;
  /** Opens `previewUrl` in the browser. */
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
  /** Live workspace repo root, for a source-control leaf. */
  scmRoot?: string | null;
  /** Open a file diff in a tab, from a source-control leaf. */
  onOpenGitDiff?: (input: OpenDiffInput) => void;
  /** A path a source-control leaf discarded, so open editors on it can close. */
  onPathDeleted?: (path: string) => void;
  /**
   * How this workspace presents its panes. `tabs` is the classic strip of tabs
   * and splits; `canvas` floats every pane of the workspace on one surface.
   * (`kanban` is drawn by `WorkspaceArea` over the top of this, which stays
   * mounted so no PTY is torn down by a view switch.)
   */
  canvas?: boolean;
  /** Canvas view: merge window geometry after a drag / resize / raise / tidy.
   *  Field-by-field, so each caller sends only what it changed. */
  onSetCanvasRects?: (patch: Record<number, Partial<CanvasRect>>) => void;
  /** Canvas view: what the canvas `+` menu can open. */
  canvasAdders?: CanvasAdders;
  /** Focus a pane in ANY tab. A canvas spans tabs, so focusing a window has to
   *  activate its owning tab too. */
  onFocusEntry?: (tabId: number, leafId: number) => void;
  /** Rename a leaf. Same setter the tab strip's Rename uses. */
  onRenameLeaf?: (leafId: number, title: string | null) => void;
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
  mdPreviewLeafIds,
  onFocusLeaf,
  onMovePaneLeaf,
  onCloseLeafRequest,
  onSplitWithExtTab,
  onSetTerminalTheme,
  onToggleMdPreview,
  previewUrl,
  previewLeafId,
  onOpenPreview,
  onSplitSizes,
  sshStatuses,
  aiCliStatuses,
  sshBindingByConnection,
  onReconnectSsh,
  scmRoot,
  onOpenGitDiff,
  onPathDeleted,
  canvas,
  onSetCanvasRects,
  canvasAdders,
  onFocusEntry,
  onRenameLeaf,
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
  // Names an `ai` leaf's header after its conversation, the same way `sshHosts`
  // names an SSH leaf after its host.
  const aiTitles = useAiSessionTitles();
  // Run state per chat, so an `ai` pane header tints like a terminal running an
  // agent does.
  const aiStates = useAiSessionStatus((s) => s.states);

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
  };

  // The workspace-wide values both views hand to their leaves. Built once here
  // rather than twice, since a canvas renders `LeafBody` outside
  // `PaneTreeView`'s provider and needs the identical object.
  const meta = useMemo<PaneMetaValue>(
    () => ({
      sshHosts,
      sshStatuses,
      aiCliStatuses,
      sshBindingByConnection,
      onReconnectSsh,
      // A board leaf charts the WHOLE workspace, so it gets every tab, not just
      // the one it happens to live in - and its cards focus a pane in ANOTHER
      // tab, which the per-tab `onFocusLeaf` wrapper below cannot address.
      boardTabs: tabs,
      onFocusEntry,
      scmRoot,
      onOpenGitDiff,
      onPathDeleted,
      aiTitles,
      aiStates,
      onRenameLeaf,
    }),
    [
      sshHosts,
      sshStatuses,
      aiCliStatuses,
      sshBindingByConnection,
      onReconnectSsh,
      tabs,
      onFocusEntry,
      scmRoot,
      onOpenGitDiff,
      onPathDeleted,
      aiTitles,
      aiStates,
      onRenameLeaf,
    ],
  );

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
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  // Prune per-leaf bundles whose leaf has disappeared from the active
  // workspace's tabs. Session disposal itself lives in `useSessionDisposal`,
  // which reconciles against ALL workspaces so a leaf is not torn down merely
  // because its workspace went inactive.
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

  // Canvas view: ONE surface holding every pane of the workspace, instead of one
  // hidden wrapper per tab. The leaves are the same ones tabs view renders, so
  // this is a re-layout, not a rebuild - `useSessionDisposal` reconciles against
  // the pane TREE, which is untouched, so nothing respawns on a view switch.
  if (canvas && onSetCanvasRects && canvasAdders && onFocusEntry) {
    return (
      <CanvasView
        tabs={paneTabs}
        activeTabId={activeId}
        getBundle={getBundle}
        mdPreviewLeafIds={mdPreviewLeafIds}
        onFocusLeaf={onFocusEntry}
        onCloseLeaf={onCloseLeafRequest}
        onSetRects={onSetCanvasRects}
        add={canvasAdders}
        meta={meta}
      />
    );
  }

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
              previewUrl={previewUrl}
              previewLeafId={previewLeafId}
              onOpenPreview={onOpenPreview}
              onSplitSizes={onSplitSizes}
              meta={meta}
            />
          </div>
        );
      })}
    </div>
  );
}
