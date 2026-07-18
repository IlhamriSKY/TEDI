import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBar";
import {
  BUILTIN_SECTION_EXT,
  parseSectionPanelId,
  RightPanelHost,
  useRightPanelStore,
  useSidebarPlacementStore,
  type BuiltinSectionId,
} from "@/modules/extensions";
import { WorkspacesPanel } from "@/modules/workspaces";
import { type Tab } from "@/modules/tabs";
import { Suspense, type RefObject } from "react";
import { type TabsApi } from "../hooks/tabsApi";
import { AiSidebarPanel, SourceControlPanel, SshFileExplorer } from "./lazyPanels";

type RightPanelActive = ReturnType<typeof useRightPanelStore.getState>["active"];

type Props = {
  rightPanelActive: RightPanelActive;
  scmRightOpen: boolean;
  sshRightOpen: boolean;
  keysLoaded: boolean;
  panelOpen: boolean;
  hasComposer: boolean;
  explorerRoot: string | null;
  onPathDeleted: (path: string) => void;
  closeScmRight: () => void;
  closeSshRight: () => void;
  /** SSH context for the right-slot Remote explorer (same source the sidebar uses). */
  activeSshContext: {
    sessionId: number | null;
    hostLabel: string | null;
    cwd: string | null;
    fromActiveLeaf: boolean;
  };
  onOpenRemoteFile: (path: string, sessionId: number, hostLabel: string | null) => void;
  onAddProviderKey: () => void;
  /** Workspaces-section props, for a right-docked Workspaces section. */
  workspacesSection: {
    onSwitch: (id: string) => void;
    onCreate: () => void;
    onCloseWorkspace: (id: string) => void;
    tabCounts: Record<string, number>;
    liveTabs: Tab[];
    cachedTabsByWorkspace: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
    onFocusLeaf: (tabId: number, leafId: number) => void;
    activeLeafId: number | null;
  };
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab">;

/**
 * The right column shared by the AI sidebar, the extension right panels, and
 * the SCM right panel. Mutual exclusion among the three is enforced by the
 * coordinator effects in App; the precedence here (`rightPanelActive` first)
 * covers the one-tick gap before the loser closes - a fresh `rightPanelActive`
 * reflects the user's latest click, so render that and let the AI panel close
 * in the background. Renders nothing when no surface wants the slot. Lifted out
 * of App verbatim; returns the handle + panel as a fragment, which the
 * context-registered ResizablePanelGroup handles correctly.
 */
export function AppRightSlot({
  rightPanelActive,
  scmRightOpen,
  sshRightOpen,
  keysLoaded,
  panelOpen,
  hasComposer,
  explorerRoot,
  onPathDeleted,
  closeScmRight,
  closeSshRight,
  activeSshContext,
  onOpenRemoteFile,
  onAddProviderKey,
  workspacesSection,
  openGitDiffTab,
  openScmTab,
}: Props) {
  if (!(rightPanelActive || scmRightOpen || sshRightOpen || (keysLoaded && panelOpen))) return null;
  // A built-in section (Files / Workspaces) docked into the slot is flagged by
  // the sentinel extensionId in the shared right-panel store; render it here
  // instead of the extension `RightPanelHost` (which only knows extension panels).
  const builtinDocked =
    rightPanelActive?.extensionId === BUILTIN_SECTION_EXT
      ? (parseSectionPanelId(rightPanelActive.panelId) as BuiltinSectionId | null)
      : null;
  // Move a docked section back to the left sidebar (undocks) vs just close the
  // slot (keeps the dock; the status-bar toggle reopens it) — mirrors SCM/SSH.
  const dockLeft = (key: BuiltinSectionId) => {
    useSidebarPlacementStore.getState().moveLeft(key);
    useRightPanelStore.getState().close();
  };
  const closeDock = () => useRightPanelStore.getState().close();
  return (
    <>
      <ResizableHandle withHandle />
      <ResizablePanel id="right-slot" defaultSize="22%" minSize="18%" maxSize="50%">
        {builtinDocked === "workspaces" ? (
          <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
            <WorkspacesPanel
              onSwitch={workspacesSection.onSwitch}
              onCreate={workspacesSection.onCreate}
              onClose={workspacesSection.onCloseWorkspace}
              tabCounts={workspacesSection.tabCounts}
              liveTabs={workspacesSection.liveTabs}
              cachedTabsByWorkspace={workspacesSection.cachedTabsByWorkspace}
              onFocusLeaf={workspacesSection.onFocusLeaf}
              activeLeafId={workspacesSection.activeLeafId}
              onMoveToLeft={() => dockLeft("workspaces")}
              onClosePanel={closeDock}
            />
          </div>
        ) : rightPanelActive ? (
          <RightPanelHost />
        ) : scmRightOpen ? (
          <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
            <Suspense fallback={null}>
              <SourceControlPanel
                rootPath={explorerRoot}
                onPathDeleted={onPathDeleted}
                onOpenDiff={openGitDiffTab}
                onClose={closeScmRight}
                onOpenInTab={openScmTab}
                sshSessionId={activeSshContext.fromActiveLeaf ? activeSshContext.sessionId : null}
                sshCwd={activeSshContext.cwd}
              />
            </Suspense>
          </div>
        ) : sshRightOpen ? (
          <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
            <Suspense fallback={null}>
              <SshFileExplorer
                sessionId={activeSshContext.sessionId}
                hostLabel={activeSshContext.hostLabel}
                currentCwd={activeSshContext.cwd}
                onOpenFile={onOpenRemoteFile}
                onClose={closeSshRight}
              />
            </Suspense>
          </div>
        ) : hasComposer ? (
          <Suspense fallback={null}>
            <AiSidebarPanel />
          </Suspense>
        ) : (
          <div className="border-border/60 bg-background tedi-glass-panel flex h-full flex-col overflow-hidden rounded-md border">
            <AiInputBarConnect onAdd={onAddProviderKey} />
          </div>
        )}
      </ResizablePanel>
    </>
  );
}
