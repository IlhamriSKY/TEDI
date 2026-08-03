import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBarConnect";
import {
  BUILTIN_SECTION_EXT,
  panelsRegistry,
  parseSectionPanelId,
  RightPanelHost,
  sectionPanelId,
  sidebarSectionsRegistry,
  useRegistry,
  useRightPanelStore,
  useSidebarPlacementStore,
  type ActivePanel,
  type BuiltinSectionId,
} from "@/modules/extensions";
import { WorkspacesPanel } from "@/modules/workspaces";
import { type Tab } from "@/modules/tabs";
import { Suspense, type ReactNode, type RefObject } from "react";
import { type TabsApi } from "../hooks/tabsApi";
import { AiSidebarPanel, SourceControlPanel, SshFileExplorer } from "./lazyPanels";
import { SectionStack, TALL_HEADER_COLLAPSED_SIZE, type StackSection } from "./SectionStack";

type Props = {
  rightPanels: ActivePanel[];
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

// Persisted in localStorage, alongside the left sidebar's own order key.
const ORDER_LS_KEY = "tedi:right:sectionOrder";
// The AI panel is the tall one (a conversation plus its composer); everything
// else starts compact. Normalized by the group for whatever is actually open.
const AI_DEFAULT_SIZE = "45%";
const PANEL_DEFAULT_SIZE = "25%";

/**
 * The right column: the AI panel, Source Control, Remote, right-docked sidebar
 * sections and extension panels, STACKED rather than mutually exclusive.
 *
 * It renders through the same `SectionStack` as the left sidebar, so every
 * surface here is resizable against its neighbours, minimizable to its header,
 * and drag-reorderable by the grip in that header. Each surface already draws
 * its own bento card, hence `chrome={false}`. Renders nothing when the column
 * is empty.
 */
export function AppRightSlot({
  rightPanels,
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
  // Titles for the stack's drag overlay + aria labels. Extension panels and
  // right-docked extension sections both name themselves in their manifest.
  const extPanels = useRegistry(panelsRegistry);
  const extSections = useRegistry(sidebarSectionsRegistry);

  // Move a docked section back to the left sidebar (undocks) vs just close it
  // (keeps the dock; the status-bar toggle reopens it) - mirrors SCM/SSH.
  const dockLeft = (key: BuiltinSectionId) => {
    useSidebarPlacementStore.getState().moveLeft(key);
    useRightPanelStore.getState().close(BUILTIN_SECTION_EXT, sectionPanelId(key));
  };

  const sections: StackSection[] = [];

  if (keysLoaded && panelOpen) {
    sections.push({
      key: "ai",
      title: "AI",
      defaultSize: AI_DEFAULT_SIZE,
      collapsedSize: TALL_HEADER_COLLAPSED_SIZE,
      render: (controls) =>
        hasComposer ? (
          <Suspense fallback={null}>
            <AiSidebarPanel dragHandle={controls} />
          </Suspense>
        ) : (
          // No API key yet: the connect card stands in for the panel. It draws
          // no header of its own, so the grip needs a rail or this is the one
          // section in the column that cannot be reordered.
          <div className="border-border/60 bg-background tedi-glass-panel flex h-full flex-col overflow-hidden rounded-md border">
            <div className="border-border/60 flex h-5 shrink-0 items-center border-b px-1.5">
              {controls}
            </div>
            <AiInputBarConnect onAdd={onAddProviderKey} />
          </div>
        ),
    });
  }

  if (scmRightOpen) {
    sections.push({
      key: "scm",
      title: "Source Control",
      defaultSize: PANEL_DEFAULT_SIZE,
      render: (controls, collapsed) => (
        <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
          <Suspense fallback={null}>
            <SourceControlPanel
              rootPath={explorerRoot}
              onPathDeleted={onPathDeleted}
              onOpenDiff={openGitDiffTab}
              onClose={closeScmRight}
              onOpenInTab={openScmTab}
              dragHandle={controls}
              collapsed={collapsed}
              sshSessionId={activeSshContext.fromActiveLeaf ? activeSshContext.sessionId : null}
              sshCwd={activeSshContext.cwd}
            />
          </Suspense>
        </div>
      ),
    });
  }

  if (sshRightOpen) {
    sections.push({
      key: "ssh",
      title: "Remote",
      defaultSize: PANEL_DEFAULT_SIZE,
      render: (controls, collapsed) => (
        <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
          <Suspense fallback={null}>
            <SshFileExplorer
              sessionId={activeSshContext.sessionId}
              hostLabel={activeSshContext.hostLabel}
              currentCwd={activeSshContext.cwd}
              onOpenFile={onOpenRemoteFile}
              onClose={closeSshRight}
              dragHandle={controls}
              collapsed={collapsed}
            />
          </Suspense>
        </div>
      ),
    });
  }

  for (const panel of rightPanels) {
    // A built-in section (Workspaces) docked into the column is flagged by the
    // sentinel extensionId; it is a plain React panel, not an extension one.
    const builtin =
      panel.extensionId === BUILTIN_SECTION_EXT
        ? (parseSectionPanelId(panel.panelId) as BuiltinSectionId | null)
        : null;
    if (builtin === "workspaces") {
      sections.push({
        key: "workspaces",
        title: "Workspaces",
        defaultSize: PANEL_DEFAULT_SIZE,
        render: (controls) => (
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
              dragHandle={controls}
              onMoveToLeft={() => dockLeft("workspaces")}
              onClosePanel={() =>
                useRightPanelStore.getState().close(BUILTIN_SECTION_EXT, panel.panelId)
              }
            />
          </div>
        ),
      });
      continue;
    }
    // A right-docked extension SECTION carries the `__section__:` sentinel and
    // is named by the sidebar-section registry; a manifest panel by the panel
    // registry. Both fall back to the raw id so the grip is never unlabelled.
    // The collapsed height follows whichever header the host will draw: the
    // section's own h-8, the host's h-11, or the slim grip rail a
    // `hideHostHeader` panel gets.
    const sectionId = parseSectionPanelId(panel.panelId);
    const meta = sectionId
      ? null
      : extPanels.find((p) => p.extensionId === panel.extensionId && p.item.id === panel.panelId);
    const title = sectionId
      ? (extSections.find((s) => s.extensionId === panel.extensionId && s.item.id === sectionId)
          ?.item.title ?? sectionId)
      : (meta?.item.title ?? panel.panelId);
    sections.push({
      key: `xp:${panel.extensionId}:${panel.panelId}`,
      title,
      defaultSize: PANEL_DEFAULT_SIZE,
      collapsedSize: sectionId
        ? undefined
        : meta?.item.hideHostHeader
          ? "22px"
          : TALL_HEADER_COLLAPSED_SIZE,
      render: (controls: ReactNode) => (
        <RightPanelHost
          extensionId={panel.extensionId}
          panelId={panel.panelId}
          dragHandle={controls}
        />
      ),
    });
  }

  if (sections.length === 0) return null;

  return (
    <>
      <ResizableHandle withHandle />
      <ResizablePanel id="right-slot" defaultSize="22%" minSize="18%" maxSize="50%">
        <div className="flex h-full flex-col">
          <SectionStack
            sections={sections}
            orderStorageKey={ORDER_LS_KEY}
            idPrefix="right"
            chrome={false}
          />
        </div>
      </ResizablePanel>
    </>
  );
}
