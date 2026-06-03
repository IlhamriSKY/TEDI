import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { FileExplorer } from "@/modules/explorer";
import { WorkspacesPanel } from "@/modules/workspaces";
import { Suspense, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { type TabsApi } from "../hooks/tabsApi";
import { SourceControlPanel, SshFileExplorer } from "./lazyPanels";

type Props = {
  sidebarRef: RefObject<PanelImperativeHandle | null>;
  explorerRoot: string | null;
  hasAnySshLeaf: boolean;
  localFilesCollapsed: boolean;
  sshFilesCollapsed: boolean;
  toggleLocalFiles: () => void;
  toggleSshFiles: () => void;
  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed: (from: string, to: string) => void;
  onPathDeleted: (path: string) => void;
  onRevealInTerminal: (path: string) => void;
  onAttachToAgent: (path: string) => void;
  activeFilePath: string | null;
  activeSshContext: {
    sessionId: number | null;
    hostLabel: string | null;
    cwd: string | null;
  };
  onOpenRemoteFile: (path: string, sessionId: number, hostLabel: string | null) => void;
  showSourceControl: boolean;
  sourceControlInRightPanel: boolean;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onCloseWorkspace: (workspaceId: string) => void;
  tabCounts: Record<string, number>;
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab">;

/**
 * The left sidebar column: the merged Files section (local explorer + the
 * connected-SSH SFTP tree), the optional in-sidebar Source Control panel, and
 * the Workspaces panel. Lifted out of App's render tree verbatim; every
 * value/handler arrives as an explicit prop and the Suspense + conditional
 * mounting are preserved. The outer ResizablePanel registers via context, so
 * wrapping it in this component is layout-safe.
 */
export function AppSidebar({
  sidebarRef,
  explorerRoot,
  hasAnySshLeaf,
  localFilesCollapsed,
  sshFilesCollapsed,
  toggleLocalFiles,
  toggleSshFiles,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
  onRevealInTerminal,
  onAttachToAgent,
  activeFilePath,
  activeSshContext,
  onOpenRemoteFile,
  showSourceControl,
  sourceControlInRightPanel,
  onSwitchWorkspace,
  onCreateWorkspace,
  onCloseWorkspace,
  tabCounts,
  openGitDiffTab,
  openScmTab,
}: Props) {
  return (
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
              <div className={cn("min-h-0", localFilesCollapsed ? "h-8 shrink-0" : "flex-1")}>
                <FileExplorer
                  rootPath={explorerRoot}
                  onOpenFile={onOpenFile}
                  onPathRenamed={onPathRenamed}
                  onPathDeleted={onPathDeleted}
                  onRevealInTerminal={onRevealInTerminal}
                  onAttachToAgent={onAttachToAgent}
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
                      onOpenFile={onOpenRemoteFile}
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
                    onPathDeleted={onPathDeleted}
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
              onSwitch={onSwitchWorkspace}
              onCreate={onCreateWorkspace}
              onClose={onCloseWorkspace}
              tabCounts={tabCounts}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </ResizablePanel>
  );
}
