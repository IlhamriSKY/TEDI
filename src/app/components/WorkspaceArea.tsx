import { ResizablePanel } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { ExtensionTabStack } from "@/modules/extensions/components/ExtensionTabStack";
import { PaneStack } from "@/modules/panes";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { type SshConnectionBinding, type SshStatus } from "@/modules/ssh/status";
import { type PaneTab, type Tab } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { Suspense } from "react";
import { type TabsApi } from "../hooks/tabsApi";
import { type usePaneHandles } from "../hooks/usePaneHandles";
import { AiDiffStack, GitDiffStack, ScmStack } from "./lazyPanels";
import { WorkspaceBoard } from "@/modules/workspaces/WorkspaceBoard";
import type { CanvasAdders } from "@/modules/panes/CanvasView";
import type { WorkspaceView } from "@/modules/workspaces/store";

type PaneHandles = ReturnType<typeof usePaneHandles>;

type Props = {
  tabs: Tab[];
  activeId: number;
  activeTab: Tab | undefined;
  activePaneTab: PaneTab | null;
  uiZoom: number;
  explorerRoot: string | null;
  paneHandles: PaneHandles;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onDetectedLocalUrl: (leafId: number, url: string) => void;
  onSshStatus: (leafId: number, status: SshStatus) => void;
  onAiCliStatus: (leafId: number, status: AiCliStatus) => void;
  sshStatuses: Map<number, SshStatus>;
  aiCliStatuses: Map<number, AiCliStatus>;
  /** Live session per saved SSH connection; a remote editor pane binds through it. */
  sshBindingByConnection: Map<string, SshConnectionBinding>;
  /** Open an SSH session for a saved connection (remote editor reconnect). */
  onReconnectSsh: (connectionId: string, title: string) => void;
  mdPreviewLeafIds: ReadonlySet<number>;
  /** Flip a markdown editor leaf between source and preview, from its pane header. */
  onToggleMdPreview: (leafId: number) => void;
  /** Detected local dev-server URL. Renders the globe beside the float button
   *  on the header of `previewLeafId`. */
  previewUrl?: string | null;
  /** Pane that carries the globe: the leaf that printed the url, so it does not
   *  hop between headers as panes take focus. */
  previewLeafId?: number | null;
  /** Opens `previewUrl` in the browser. */
  onOpenPreview?: () => void;
  hasAiDiffTab: boolean;
  hasGitDiffTab: boolean;
  hasScmTab: boolean;
  hasExtensionTab: boolean;
  respondToApproval: (approvalId: string, approve: boolean) => void;
  onPathDeleted: (path: string) => void;
  /** Persist a split node's per-child size percentages after a divider drag. */
  onSplitSizes: (splitId: number, sizes: number[]) => void;
  /** How the active WORKSPACE presents its panes. `kanban` and `canvas` both
   *  show the whole workspace at once, so the tab strip is hidden for them
   *  (see `Header`). */
  view: WorkspaceView;
  /** What the canvas `+` menu opens. Existing tab openers, so a pane added on
   *  the canvas is an ordinary pane tab that survives a view switch. */
  canvasAdders: CanvasAdders;
  /** Focus a pane in any tab. Canvas windows and board cards both need it. */
  onFocusEntry: (tabId: number, leafId: number) => void;
  /** Rename a leaf, for the canvas window header's right-click menu. */
  onRenameLeaf: (leafId: number, title: string | null) => void;
} & Pick<
  TabsApi,
  | "movePaneLeafToEdge"
  | "moveExtTabToPane"
  | "openGitDiffTab"
  | "setLeafTerminalTheme"
  | "setCanvasRects"
>;

/**
 * The center workspace column. Stacks the live PaneStack and the four overlay
 * surfaces (AI diff, git diff, SCM, extension tabs) in one relative box, each
 * shown/hidden by the active tab kind via the `invisible`/`pointer-events-none`
 * pattern (kept mounted so their session/scroll state survives a tab switch).
 * Lifted out of App verbatim; the per-leaf handlers arrive bundled as
 * `paneHandles`, with the chrome/ssh/tabs-api handlers threaded in alongside.
 */
/**
 * One absolutely-positioned overlay in the workspace stack. Hidden rather than
 * unmounted, so a surface keeps its session and scroll position across a tab or
 * view switch. Extracted because the wrapper was written out five times with
 * the visibility rule duplicated between `className` and `aria-hidden` - two
 * places per surface for the same fact to drift apart in.
 */
function Overlay({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn("absolute inset-0", hidden && "pointer-events-none invisible")}
      aria-hidden={hidden ? "true" : "false"}
    >
      {children}
    </div>
  );
}

export function WorkspaceArea({
  tabs,
  activeId,
  activeTab,
  activePaneTab,
  uiZoom,
  explorerRoot,
  paneHandles,
  onSearchReady,
  onDetectedLocalUrl,
  onSshStatus,
  onAiCliStatus,
  sshStatuses,
  aiCliStatuses,
  sshBindingByConnection,
  onReconnectSsh,
  mdPreviewLeafIds,
  onToggleMdPreview,
  previewUrl,
  previewLeafId,
  onOpenPreview,
  hasAiDiffTab,
  hasGitDiffTab,
  hasScmTab,
  hasExtensionTab,
  respondToApproval,
  onPathDeleted,
  onSplitSizes,
  view,
  canvasAdders,
  onFocusEntry,
  onRenameLeaf,
  movePaneLeafToEdge,
  moveExtTabToPane,
  openGitDiffTab,
  setLeafTerminalTheme,
  setCanvasRects,
}: Props) {
  // The four tab-kind surfaces only ever show in tabs view; kanban and canvas
  // each present the whole workspace themselves.
  const tabsView = view === "tabs";
  return (
    <ResizablePanel id="workspace" defaultSize="58%" minSize="25%">
      {/* Counter the body-level UI zoom so the panes (terminal,
          editor, preview, diffs) render at their native scale.
          Net effective zoom here is uiZoom * (1 / uiZoom) = 1. */}
      <div
        className="flex h-full min-h-0 flex-col"
        style={uiZoom === 1 ? undefined : { zoom: 1 / uiZoom }}
      >
        {/* Transparent to the bento tray (`bg-sidebar`, owned by App's <main>):
            each pane is its own `bg-background` bordered card that floats on the
            tray, butting the uniform tray gutter like the sidebar / right cards. */}
        <div className="relative min-h-0 flex-1">
          {/* Panes. Always mounted, in every view: `useSessionDisposal` keys off
              the pane TREE, but unmounting the stack would still tear down every
              xterm and CodeMirror, so kanban hides it rather than replacing it.
              In canvas view the stack lays the same leaves out as free-floating
              windows instead of per-tab split trees. */}
          <Overlay hidden={view === "kanban" || (!activePaneTab && view === "tabs")}>
            <PaneStack
              tabs={tabs}
              activeId={activeId}
              registerTerminalHandle={paneHandles.registerTerminalHandle}
              onSearchReady={onSearchReady}
              onCwd={paneHandles.handleTerminalCwd}
              onDetectedLocalUrl={onDetectedLocalUrl}
              onExit={paneHandles.handleLeafExit}
              onTediOpen={paneHandles.handleTediOpen}
              onTediSpawnTab={paneHandles.handleTediSpawnTab}
              onSshStatus={onSshStatus}
              onAiCliStatus={onAiCliStatus}
              onPtyId={paneHandles.handlePtyId}
              registerEditorHandle={paneHandles.registerEditorHandle}
              onDirtyChange={paneHandles.handleEditorDirty}
              onCloseLeaf={paneHandles.handleEditorCloseLeaf}
              mdPreviewLeafIds={mdPreviewLeafIds}
              onToggleMdPreview={onToggleMdPreview}
              previewUrl={previewUrl}
              previewLeafId={previewLeafId}
              onOpenPreview={onOpenPreview}
              onFocusLeaf={paneHandles.handleFocusLeaf}
              onMovePaneLeaf={movePaneLeafToEdge}
              onCloseLeafRequest={paneHandles.handlePaneHeaderClose}
              onSplitWithExtTab={moveExtTabToPane}
              onSetTerminalTheme={setLeafTerminalTheme}
              onSplitSizes={onSplitSizes}
              scmRoot={explorerRoot}
              onOpenGitDiff={openGitDiffTab}
              onPathDeleted={onPathDeleted}
              onSetCanvasRects={setCanvasRects}
              canvas={view === "canvas"}
              canvasAdders={canvasAdders}
              onFocusEntry={onFocusEntry}
              onRenameLeaf={onRenameLeaf}
              sshStatuses={sshStatuses}
              aiCliStatuses={aiCliStatuses}
              sshBindingByConnection={sshBindingByConnection}
              onReconnectSsh={onReconnectSsh}
            />
          </Overlay>
          {/* Kanban view of the workspace: the same board a `board` pane leaf
              shows, given the whole area. An overlay rather than a swap, so the
              pane stack underneath keeps every session alive. */}
          <Overlay hidden={view !== "kanban"}>
            {/* Mounted only while shown. The board holds no state of its own -
                it is rebuilt from the live tab tree - so keeping it alive in the
                background would just re-run `buildEntries` on every tab change
                for a surface nobody is looking at. */}
            {view === "kanban" ? (
              <div className="border-border bg-background h-full overflow-hidden rounded-md border">
                <WorkspaceBoard
                  tabs={tabs}
                  sshStatuses={sshStatuses}
                  aiCliStatuses={aiCliStatuses}
                  onFocusLeaf={onFocusEntry}
                />
              </div>
            ) : null}
          </Overlay>
          <Overlay hidden={!tabsView || activeTab?.kind !== "ai-diff"}>
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
          </Overlay>
          <Overlay hidden={!tabsView || activeTab?.kind !== "git-diff"}>
            {hasGitDiffTab ? (
              <Suspense fallback={null}>
                <GitDiffStack tabs={tabs} activeId={activeId} />
              </Suspense>
            ) : null}
          </Overlay>
          <Overlay hidden={!tabsView || activeTab?.kind !== "scm"}>
            {hasScmTab ? (
              <Suspense fallback={null}>
                <ScmStack
                  tabs={tabs}
                  activeId={activeId}
                  rootPath={explorerRoot}
                  onPathDeleted={onPathDeleted}
                  onOpenDiff={openGitDiffTab}
                />
              </Suspense>
            ) : null}
          </Overlay>
          {/* The Board is a pane LEAF, not an overlay surface: it renders
              inside PaneStack above, with the same header every other pane has. */}
          {hasExtensionTab ? (
            <Overlay hidden={!tabsView || activeTab?.kind !== "ext"}>
              <ExtensionTabStack tabs={tabs} activeId={activeId} />
            </Overlay>
          ) : null}
        </div>
      </div>
    </ResizablePanel>
  );
}
