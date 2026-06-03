import { ResizablePanel } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { ExtensionTabStack } from "@/modules/extensions/components/ExtensionTabStack";
import { PaneStack } from "@/modules/panes";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { type SshStatus } from "@/modules/ssh/status";
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
  mdPreviewLeafIds: ReadonlySet<number>;
  hasAiDiffTab: boolean;
  hasGitDiffTab: boolean;
  hasScmTab: boolean;
  hasExtensionTab: boolean;
  respondToApproval: (approvalId: string, approve: boolean) => void;
  onPathDeleted: (path: string) => void;
} & Pick<TabsApi, "setPreviewLeafUrl" | "movePaneLeafToEdge" | "openGitDiffTab">;

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
  mdPreviewLeafIds,
  hasAiDiffTab,
  hasGitDiffTab,
  hasScmTab,
  hasExtensionTab,
  respondToApproval,
  onPathDeleted,
  setPreviewLeafUrl,
  movePaneLeafToEdge,
  openGitDiffTab,
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
              onPreviewUrlChange={setPreviewLeafUrl}
              mdPreviewLeafIds={mdPreviewLeafIds}
              onFocusLeaf={paneHandles.handleFocusLeaf}
              onMovePaneLeaf={movePaneLeafToEdge}
              onCloseLeafRequest={paneHandles.handlePaneHeaderClose}
              sshStatuses={sshStatuses}
              aiCliStatuses={aiCliStatuses}
            />
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
                  onPathDeleted={onPathDeleted}
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
  );
}
