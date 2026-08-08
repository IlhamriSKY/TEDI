import { ResizablePanel } from "@/components/ui/resizable";
import { FileExplorer } from "@/modules/explorer";
import {
  BUILTIN_SECTION_EXT,
  ExtensionSidebarSection,
  sectionPanelId,
  sidebarSectionsRegistry,
  useRegistry,
  useRightPanelStore,
  useSidebarPlacementStore,
  type BuiltinSectionId,
} from "@/modules/extensions";
import { type SshStatus } from "@/modules/ssh/status";
import { type Tab } from "@/modules/tabs";
import { WorkspacesPanel } from "@/modules/workspaces";
import { Suspense, useMemo, type ReactNode, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { type TabsApi } from "../hooks/tabsApi";
import { SourceControlPanel, SshFileExplorer } from "./lazyPanels";
import { SectionStack, type StackSection } from "./SectionStack";

type Props = {
  sidebarRef: RefObject<PanelImperativeHandle | null>;
  explorerRoot: string | null;
  hasAnySshLeaf: boolean;
  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed: (from: string, to: string) => void;
  onPathDeleted: (path: string) => void;
  onRevealInTerminal: (path: string) => void;
  onAttachToAgent: (path: string) => void;
  onPreviewInBrowser: (path: string) => void;
  activeFilePath: string | null;
  activeSshContext: {
    sessionId: number | null;
    hostLabel: string | null;
    cwd: string | null;
    fromActiveLeaf: boolean;
  };
  onOpenRemoteFile: (path: string, sessionId: number, hostLabel: string | null) => void;
  showSourceControl: boolean;
  sourceControlInRightPanel: boolean;
  /** When true, the Remote/SSH section is docked in the right slot, so the
   *  sidebar drops its pane (mirrors `sourceControlInRightPanel`). */
  sshInRightPanel: boolean;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onCloseWorkspace: (workspaceId: string) => void;
  tabCounts: Record<string, number>;
  /** Live tabs of the active workspace, for the Workspaces panel's terminal list. */
  liveTabs: Tab[];
  /** App-owned cache of every visited workspace's live tab trees, so inactive
   * workspaces still list terminals with live AI CLI status. */
  cachedTabsByWorkspace: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
  /** Focus a live terminal leaf from the Workspaces panel. */
  onFocusLeaf: (tabId: number, leafId: number) => void;
  /** Rename a pane leaf from the Workspaces panel (same handler as the tab
   *  strip's right-click Rename, so both write the one `customTitle`). */
  onRenameLeaf: (leafId: number, title: string | null) => void;
  /** Close a tab listed in the Workspaces panel (same handler as the tab
   *  strip's X, so both share the busy / unsaved confirms). */
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  /** Currently focused leaf id, to highlight its row in Workspaces. */
  activeLeafId: number | null;
  /** Live SSH status per leaf, so a connected host is green in Workspaces too. */
  sshStatuses: Map<number, SshStatus>;
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab" | "openBoardTab">;

// The reorderable built-in sidebar sections, in canonical order. Extension
// sections (keyed `xsec:<extId>:<sectionId>`) are appended dynamically — they
// exist only while their extension is active.
const BUILTIN_KEYS = ["files", "ssh", "scm", "workspaces"] as const;
type BuiltinKey = (typeof BUILTIN_KEYS)[number];
const BUILTIN_TITLES: Record<BuiltinKey, string> = {
  files: "Files",
  ssh: "Remote",
  scm: "Source Control",
  workspaces: "Workspaces",
};
// Initial split (the panel group normalizes for whichever sections are visible);
// Files gets the most room, like the old layout. Users resize from here.
const BUILTIN_DEFAULT_SIZE: Record<BuiltinKey, string> = {
  files: "45%",
  ssh: "25%",
  scm: "18%",
  workspaces: "12%",
};
const EXT_DEFAULT_SIZE = "20%";

const EXT_KEY_PREFIX = "xsec:";
const extSectionKey = (extensionId: string, sectionId: string): string =>
  `${EXT_KEY_PREFIX}${extensionId}:${sectionId}`;

// Persisted in localStorage (sidebar lives in the main window only).
const ORDER_LS_KEY = "tedi:sidebar:sectionOrder";

/**
 * The left sidebar column. Sections (Files, Remote/SSH, Source Control,
 * Workspaces) are stacked resizable panels, collapsible to their header and
 * drag-reorderable by the grip in that header - all of which lives in the
 * shared `SectionStack`, so the right column behaves identically.
 */
export function AppSidebar({
  sidebarRef,
  explorerRoot,
  hasAnySshLeaf,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
  onRevealInTerminal,
  onAttachToAgent,
  onPreviewInBrowser,
  activeFilePath,
  activeSshContext,
  onOpenRemoteFile,
  showSourceControl,
  sourceControlInRightPanel,
  sshInRightPanel,
  onSwitchWorkspace,
  onCreateWorkspace,
  onCloseWorkspace,
  tabCounts,
  liveTabs,
  cachedTabsByWorkspace,
  onFocusLeaf,
  onRenameLeaf,
  onCloseEntry,
  activeLeafId,
  sshStatuses,
  openGitDiffTab,
  openScmTab,
  openBoardTab,
}: Props) {
  // Extension-contributed sections (present only while their extension is
  // active). Keyed `xsec:<extId>:<sectionId>`, mapped back to their descriptor.
  const extEntries = useRegistry(sidebarSectionsRegistry);
  const extByKey = useMemo(() => {
    const m = new Map<
      string,
      { extensionId: string; section: (typeof extEntries)[number]["item"] }
    >();
    for (const { extensionId, item } of extEntries) {
      m.set(extSectionKey(extensionId, item.id), { extensionId, section: item });
    }
    return m;
  }, [extEntries]);

  const scmVisible = showSourceControl && !sourceControlInRightPanel;
  const sshVisible = hasAnySshLeaf && !sshInRightPanel;
  // Extension sections moved to the right slot (placement === "right") leave the
  // left sidebar; they're reachable from a status-bar icon instead.
  const placement = useSidebarPlacementStore((s) => s.placement);

  // Dock a built-in section (Files / Workspaces) into the right column,
  // mirroring how Source Control / SSH / extension sections move right: persist
  // the placement (so AppSidebar drops it from the left) and open it in the
  // right column via the shared right-panel store.
  const moveSectionRight = (key: BuiltinSectionId) => {
    useSidebarPlacementStore.getState().moveRight(key);
    useRightPanelStore.getState().open(BUILTIN_SECTION_EXT, sectionPanelId(key));
  };

  /**
   * Drag-to-dock: a section handed to the right column by dragging its grip
   * across, rather than by its header's "Move to right panel" button. The rule
   * for WHICH sections may go is read off the same condition that shows that
   * button, so the two routes can never disagree - and the primary Files tree
   * answers false, because a right dock collides with the Secondary Folder Tree
   * extension already living there (see sidebarPlacementStore).
   */
  const canDockRight = (key: string): boolean =>
    key === "workspaces" || !!extByKey.get(key)?.section.movableToRight;
  const dockRight = (key: string): void => {
    if (key === "workspaces") {
      moveSectionRight("workspaces");
      return;
    }
    const ext = extByKey.get(key);
    if (!ext) return;
    // Same pair ExtensionSidebarSection's own move button fires.
    useSidebarPlacementStore.getState().moveRight(key);
    useRightPanelStore.getState().open(ext.extensionId, sectionPanelId(ext.section.id));
  };

  const renderBuiltin = (key: BuiltinKey, controls: ReactNode, collapsed: boolean): ReactNode => {
    // When the panel is collapsed to its header, sections skip rendering the
    // body so the virtualized tree / git status stop doing layout work.
    switch (key) {
      case "files":
        return (
          <FileExplorer
            rootPath={explorerRoot}
            onOpenFile={onOpenFile}
            onPathRenamed={onPathRenamed}
            onPathDeleted={onPathDeleted}
            onRevealInTerminal={onRevealInTerminal}
            onAttachToAgent={onAttachToAgent}
            onPreviewInBrowser={onPreviewInBrowser}
            dragHandle={controls}
            collapsed={collapsed}
            activeFilePath={activeFilePath}
            hideSort
          />
        );
      case "ssh":
        return (
          <Suspense fallback={null}>
            <SshFileExplorer
              sessionId={activeSshContext.sessionId}
              hostLabel={activeSshContext.hostLabel}
              currentCwd={activeSshContext.cwd}
              onOpenFile={onOpenRemoteFile}
              dragHandle={controls}
              collapsed={collapsed}
            />
          </Suspense>
        );
      case "scm":
        return (
          <Suspense fallback={null}>
            <SourceControlPanel
              rootPath={explorerRoot}
              onPathDeleted={onPathDeleted}
              onOpenDiff={openGitDiffTab}
              onOpenInTab={openScmTab}
              dragHandle={controls}
              collapsed={collapsed}
              sshSessionId={activeSshContext.fromActiveLeaf ? activeSshContext.sessionId : null}
              sshCwd={activeSshContext.cwd}
            />
          </Suspense>
        );
      case "workspaces":
        return (
          <WorkspacesPanel
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onClose={onCloseWorkspace}
            tabCounts={tabCounts}
            liveTabs={liveTabs}
            cachedTabsByWorkspace={cachedTabsByWorkspace}
            onFocusLeaf={onFocusLeaf}
            onRenameLeaf={onRenameLeaf}
            onCloseEntry={onCloseEntry}
            onOpenBoard={openBoardTab}
            activeLeafId={activeLeafId}
            sshStatuses={sshStatuses}
            dragHandle={controls}
            onMoveToRight={() => moveSectionRight("workspaces")}
          />
        );
    }
  };

  const sections: StackSection[] = [];
  for (const key of BUILTIN_KEYS) {
    if (key === "scm" && !scmVisible) continue;
    if (key === "ssh" && !sshVisible) continue;
    if (placement[key] === "right") continue;
    sections.push({
      key,
      title: BUILTIN_TITLES[key],
      defaultSize: BUILTIN_DEFAULT_SIZE[key],
      render: (controls, collapsed) => renderBuiltin(key, controls, collapsed),
    });
  }
  for (const [key, ext] of extByKey) {
    if (placement[key] === "right") continue;
    sections.push({
      key,
      title: ext.section.title,
      defaultSize: EXT_DEFAULT_SIZE,
      render: (controls, collapsed) => (
        <ExtensionSidebarSection
          extensionId={ext.extensionId}
          section={ext.section}
          dragHandle={controls}
          collapsed={collapsed}
        />
      ),
    });
  }

  return (
    <ResizablePanel
      id="sidebar"
      panelRef={sidebarRef}
      defaultSize="225px"
      // Percentage, NOT px. react-resizable-panels re-derives a px minSize
      // against the LIVE container, so while a minimize/restore ramps the
      // WebView2 client area down through ~40-400px, "130px" becomes 65%+ and
      // the library snaps this collapsible panel to collapsedSize 0 - which then
      // survives the way back up, because a growing container never revisits the
      // stored percentages. That is what made the sidebar come back shut. A
      // percentage minimum is container-invariant, so a resize can never make
      // `size < minSize` true and the force-collapse is structurally impossible.
      minSize="8%"
      maxSize="450px"
      collapsible
      collapsedSize={0}
    >
      {/* Transparent to the bento tray: each section renders as its own
          1px-bordered `bg-sidebar` card, stacked with a gap, so the tray shows
          between them like the reference layout. */}
      {/* `data-section-column` is the drop target the OTHER stack tests against
          when a drag ends outside its own column. */}
      <div data-section-column="left" className="flex h-full flex-col">
        <SectionStack
          sections={sections}
          orderStorageKey={ORDER_LS_KEY}
          idPrefix="sidebar"
          column="left"
          canMoveColumn={canDockRight}
          onMoveColumn={dockRight}
        />
      </div>
    </ResizablePanel>
  );
}
