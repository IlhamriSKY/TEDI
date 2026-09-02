import { ResizablePanel } from "@/components/ui/resizable";
import { FileExplorer } from "@/modules/explorer";
import {
  ExtensionSidebarSection,
  sidebarSectionsRegistry,
  useRegistry,
  useSidebarPlacementStore,
} from "@/modules/extensions";
import { type SshStatus } from "@/modules/ssh/status";
import { type Tab } from "@/modules/tabs";
import { WorkspacesPanel } from "@/modules/workspaces";
import { Suspense, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { type TabsApi } from "../hooks/tabsApi";
import { canDockRight, dockRight } from "../lib/sectionDock";
import { aiStackSection } from "./aiSection";
import { SectionDropRail, useExpandOnSectionArrival } from "./SectionDropRail";
import { SourceControlPanel, SshFileExplorer } from "./lazyPanels";
import { SectionStack, type StackSection } from "./SectionStack";
import { expandIfShut } from "@/app/lib/panelSize";

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
  /** The AI panel docks to either column now. These three are the same values
   *  `AppRightSlot` gates it on; whichever column the placement names renders
   *  it, and the other drops it. */
  aiPanelOpen: boolean;
  aiKeysLoaded: boolean;
  hasComposer: boolean;
  onAddProviderKey: () => void;
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab">;

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
 * Workspaces, plus the AI panel when it is docked here) are stacked resizable
 * panels, collapsible to their header and drag-reorderable by the grip in that
 * header - all of which lives in the shared `SectionStack`, so the right column
 * behaves identically. Which column a section sits in is `lib/sectionDock`'s
 * call, and the whole column minimizes via `sidebarRef`.
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
  aiPanelOpen,
  aiKeysLoaded,
  hasComposer,
  onAddProviderKey,
  openGitDiffTab,
  openScmTab,
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
  // The AI panel is the one surface whose HOME is the right column, so it takes
  // the opposite default: it appears here only once explicitly docked left.
  const aiInSidebar = placement.ai === "left" && aiKeysLoaded && aiPanelOpen;

  // With AI docked here, opening it from the status bar while the sidebar is
  // shut would otherwise do nothing visible. Expand for that one transition
  // only - NOT on any section appearing: Remote and Source Control show up on
  // their own when a host connects or a repo opens, and popping the sidebar back
  // open for those would fight a user who deliberately closed it.
  const aiWasInSidebar = useRef(aiInSidebar);
  useEffect(() => {
    const panel = sidebarRef.current;
    if (aiInSidebar && !aiWasInSidebar.current) expandIfShut(panel);
    aiWasInSidebar.current = aiInSidebar;
  }, [aiInSidebar, sidebarRef]);
  // A section dragged in from the right column opens the sidebar if it is shut,
  // so the drop is never invisible. Same rule the right column follows.
  useExpandOnSectionArrival("left", sidebarRef);

  /**
   * Drag-to-dock: a section handed to the right column by dragging its grip
   * across, rather than by its header's "Move to right panel" button. Both routes
   * now run through `lib/sectionDock`, so they cannot disagree about which
   * sections may go or about what moving one means. The only rule this component
   * still owns is an extension section's own `movableToRight` opt-in, which is
   * in its manifest and only reachable from the registry here.
   */
  const canDrag = (key: string): boolean =>
    canDockRight(key, (k) => !!extByKey.get(k)?.section.movableToRight);

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
            onMoveToRight={() => dockRight("files")}
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
            activeLeafId={activeLeafId}
            sshStatuses={sshStatuses}
            dragHandle={controls}
            onMoveToRight={() => dockRight("workspaces")}
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
  // The AI panel, when the user has docked it left. Its open/closed state is the
  // chat store's `panelOpen`, shared with the right column, so only the
  // placement decides which side it appears on.
  if (aiInSidebar) sections.push(aiStackSection(hasComposer, onAddProviderKey));

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
          when a drag ends outside its own column. Zero-width while the sidebar
          is minimized shut, which is not aimable - `SectionDropRail` stands in
          for exactly that case, so a drag from the right lands somewhere. */}
      <SectionDropRail column="left" />
      <div data-section-column="left" className="flex h-full flex-col">
        <SectionStack
          sections={sections}
          orderStorageKey={ORDER_LS_KEY}
          idPrefix="sidebar"
          column="left"
          canMoveColumn={canDrag}
          onMoveColumn={dockRight}
        />
      </div>
    </ResizablePanel>
  );
}
