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
  /** Detected local URL for the focused pane header's "open preview" globe. */
  detectedBrowserUrl: string | null;
  onOpenPreview: () => void;
  hasAiDiffTab: boolean;
  hasGitDiffTab: boolean;
  hasScmTab: boolean;
  hasExtensionTab: boolean;
  respondToApproval: (approvalId: string, approve: boolean) => void;
  onPathDeleted: (path: string) => void;
  /** Persist a split node's per-child size percentages after a divider drag. */
  onSplitSizes: (splitId: number, sizes: number[]) => void;
} & Pick<
  TabsApi,
  | "setBrowserLeafUrl"
  | "movePaneLeafToEdge"
  | "moveExtTabToPane"
  | "openGitDiffTab"
  | "setLeafTerminalTheme"
>;

/**
 * The center workspace column. Stacks the live PaneStack and the four overlay
 * surfaces (AI diff, git diff, SCM, extension tabs) in one relative box, each
 * shown/hidden by the active tab kind via the `invisible`/`pointer-events-none`
 * pattern (kept mounted so their session/scroll state survives a tab switch).
 * Lifted out of App verbatim; the per-leaf handlers arrive bundled as
 * `paneHandles`, with the chrome/ssh/tabs-api handlers threaded in alongside.
 */
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
  detectedBrowserUrl,
  onOpenPreview,
  hasAiDiffTab,
  hasGitDiffTab,
  hasScmTab,
  hasExtensionTab,
  respondToApproval,
  onPathDeleted,
  onSplitSizes,
  setBrowserLeafUrl,
  movePaneLeafToEdge,
  moveExtTabToPane,
  openGitDiffTab,
  setLeafTerminalTheme,
}: Props) {
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
          <div
            className={cn("absolute inset-0", !activePaneTab && "pointer-events-none invisible")}
            aria-hidden={activePaneTab ? "false" : "true"}
          >
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
              onBrowserUrlChange={setBrowserLeafUrl}
              mdPreviewLeafIds={mdPreviewLeafIds}
              onToggleMdPreview={onToggleMdPreview}
              detectedBrowserUrl={detectedBrowserUrl}
              onOpenPreview={onOpenPreview}
              onFocusLeaf={paneHandles.handleFocusLeaf}
              onMovePaneLeaf={movePaneLeafToEdge}
              onCloseLeafRequest={paneHandles.handlePaneHeaderClose}
              onSplitWithExtTab={moveExtTabToPane}
              onSetTerminalTheme={setLeafTerminalTheme}
              onSplitSizes={onSplitSizes}
              sshStatuses={sshStatuses}
              aiCliStatuses={aiCliStatuses}
              sshBindingByConnection={sshBindingByConnection}
              onReconnectSsh={onReconnectSsh}
            />
          </div>
          <div
            className={cn(
              "absolute inset-0",
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
              "absolute inset-0",
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
              "absolute inset-0",
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
                  onPathDeleted={onPathDeleted}
                  onOpenDiff={openGitDiffTab}
                />
              </Suspense>
            ) : null}
          </div>
          {/* The Board is a pane LEAF, not an overlay surface: it renders
              inside PaneStack above, with the same header every other pane has. */}
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
  );
}
