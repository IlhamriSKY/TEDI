import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import {
  BUILTIN_SECTION_EXT,
  panelsRegistry,
  parseSectionPanelId,
  RightPanelHost,
  sidebarSectionsRegistry,
  useRegistry,
  useRightPanelStore,
  useSidebarPlacementStore,
  type ActivePanel,
  type BuiltinSectionId,
} from "@/modules/extensions";
import { FileExplorer } from "@/modules/explorer";
import { WorkspacesPanel } from "@/modules/workspaces";
import { type SshStatus } from "@/modules/ssh/status";
import { type Tab } from "@/modules/tabs";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { expandIfShut } from "@/app/lib/panelSize";
import { Suspense, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { type TabsApi } from "../hooks/tabsApi";
import { canDockLeft, dockLeft as dockSectionLeft } from "../lib/sectionDock";
import { aiStackSection } from "./aiSection";
import { SectionDropRail, useExpandOnSectionArrival } from "./SectionDropRail";
import { SourceControlPanel, SshFileExplorer } from "./lazyPanels";
import { SectionStack, type StackSection } from "./SectionStack";

type Props = {
  /** Handle on the whole column, so the header/shortcut can minimize it shut
   *  the way the sidebar toggle does the left one. */
  rightSlotRef: RefObject<PanelImperativeHandle | null>;
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
  /** Files-section props, so a right-docked Files section renders in the column
   *  (same values App passes to AppSidebar). */
  filesSection: {
    onOpenFile: (path: string, pin?: boolean) => void;
    onPathRenamed: (from: string, to: string) => void;
    onRevealInTerminal: (path: string) => void;
    onAttachToAgent: (path: string) => void;
    onPreviewInBrowser: (path: string) => void;
    activeFilePath: string | null;
  };
  /** Workspaces-section props, for a right-docked Workspaces section. */
  workspacesSection: {
    onSwitch: (id: string) => void;
    onCreate: () => void;
    onCloseWorkspace: (id: string) => void;
    tabCounts: Record<string, number>;
    liveTabs: Tab[];
    cachedTabsByWorkspace: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
    onFocusLeaf: (tabId: number, leafId: number) => void;
    onRenameLeaf: (leafId: number, title: string | null) => void;
    onCloseEntry: (tabId: number, leafId: number | null) => void;
    activeLeafId: number | null;
    sshStatuses: Map<number, SshStatus>;
  };
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab">;

// Persisted in localStorage, alongside the left sidebar's own order key.
const ORDER_LS_KEY = "tedi:right:sectionOrder";
// Everything but the AI panel starts compact (the AI panel's own share lives in
// `aiSection`). Normalized by the group for whatever is actually open.
const PANEL_DEFAULT_SIZE = "25%";

/**
 * The right column: the AI panel, Source Control, Remote, right-docked sidebar
 * sections and extension panels, STACKED rather than mutually exclusive.
 *
 * It renders through the same `SectionStack` as the left sidebar, so every
 * surface here is resizable against its neighbours, minimizable to its header,
 * and drag-reorderable by the grip in that header. Each surface already draws
 * its own bento card, hence `chrome={false}`.
 *
 * The column itself minimizes too, via `rightSlotRef` (the header's toggle and
 * Mod+Alt+B), the twin of the sidebar's. When nothing is docked here it renders
 * only a drop rail, and only while the sidebar is dragging a section across.
 */
export function AppRightSlot({
  rightSlotRef,
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
  filesSection,
  workspacesSection,
  openGitDiffTab,
  openScmTab,
}: Props) {
  // Titles for the stack's drag overlay + aria labels. Extension panels and
  // right-docked extension sections both name themselves in their manifest.
  const extPanels = useRegistry(panelsRegistry);
  const extSections = useRegistry(sidebarSectionsRegistry);

  // The AI panel docks either side now, so this column only shows it while it
  // is placed here. Its open/closed state is the chat store's, shared by both.
  const placement = useSidebarPlacementStore((s) => s.placement);

  const sections: StackSection[] = [];

  if (keysLoaded && panelOpen && placement.ai !== "left") {
    sections.push(aiStackSection(hasComposer, onAddProviderKey));
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
    // A built-in section (Files / Workspaces) docked into the column is flagged
    // by the sentinel extensionId; it is a plain React panel, not an extension one.
    const builtin =
      panel.extensionId === BUILTIN_SECTION_EXT
        ? (parseSectionPanelId(panel.panelId) as BuiltinSectionId | null)
        : null;
    if (builtin === "files") {
      sections.push({
        key: "files",
        title: "Files",
        defaultSize: PANEL_DEFAULT_SIZE,
        render: (controls, collapsed) => (
          <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
            <FileExplorer
              rootPath={explorerRoot}
              onOpenFile={filesSection.onOpenFile}
              onPathRenamed={filesSection.onPathRenamed}
              onPathDeleted={onPathDeleted}
              onRevealInTerminal={filesSection.onRevealInTerminal}
              onAttachToAgent={filesSection.onAttachToAgent}
              onPreviewInBrowser={filesSection.onPreviewInBrowser}
              activeFilePath={filesSection.activeFilePath}
              dragHandle={controls}
              collapsed={collapsed}
              onMoveToLeft={() => dockSectionLeft("files")}
              onClose={() =>
                useRightPanelStore.getState().close(BUILTIN_SECTION_EXT, panel.panelId)
              }
              hideSort
            />
          </div>
        ),
      });
      continue;
    }
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
              onRenameLeaf={workspacesSection.onRenameLeaf}
              onCloseEntry={workspacesSection.onCloseEntry}
              activeLeafId={workspacesSection.activeLeafId}
              sshStatuses={workspacesSection.sshStatuses}
              dragHandle={controls}
              onMoveToLeft={() => dockSectionLeft("workspaces")}
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
    // No collapsed-height override any more: every one of these draws
    // `.tedi-panel-header`, which is one fixed height, so the stack's single
    // collapsed size fits them all.
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
      render: (controls: ReactNode) => (
        <RightPanelHost
          extensionId={panel.extensionId}
          panelId={panel.panelId}
          dragHandle={controls}
        />
      ),
    });
  }

  // A minimized column must not swallow a surface the user just opened: with the
  // column collapsed, clicking the AI button or docking a section would else do
  // nothing visible at all. Re-expand whenever the section count RISES, which
  // keeps the toggle a minimize rather than a mute. Declared before the early
  // return below so the hook order never changes.
  useOpenExpandsColumn(sections.length, rightSlotRef);
  // And when a section is DRAGGED in, which is not a count rise this column can
  // tell apart from a panel opening on its own.
  useExpandOnSectionArrival("right", rightSlotRef);

  // Nothing docked here: the column renders no panel at all, so there is nothing
  // for a drag to aim at. `SectionDropRail` stands in while the sidebar has a
  // section in hand (it covers the minimized-shut case too, which is why it is
  // rendered below as well as here).
  if (sections.length === 0) return <SectionDropRail column="right" />;

  return (
    <>
      <SectionDropRail column="right" />
      <ResizableHandle withHandle />
      <ResizablePanel
        id="right-slot"
        panelRef={rightSlotRef}
        defaultSize="22%"
        // Percentage, NOT px, for the same reason the sidebar's is one: a px
        // minimum is re-derived against the LIVE container, so a minimize /
        // restore ramp can make `size < minSize` true and force this collapsible
        // panel shut for good. See the note in AppSidebar.
        //
        // And the SAME percentage as the sidebar's, because the library snaps a
        // collapsible panel shut at the MIDPOINT between collapsedSize and
        // minSize (`const l = (i + r) / 2` in its clamp). A larger minimum here
        // than on the left therefore means the right handle has to be dragged
        // relatively further before it closes, and springs back out anywhere
        // short of that - which reads as "the right column refuses to close the
        // way the left one does". Same floor, same snap.
        minSize="8%"
        maxSize="50%"
        collapsible
        collapsedSize={0}
      >
        <div data-section-column="right" className="flex h-full flex-col">
          <SectionStack
            sections={sections}
            orderStorageKey={ORDER_LS_KEY}
            idPrefix="right"
            chrome={false}
            column="right"
            canMoveColumn={canDockLeft}
            onMoveColumn={dockSectionLeft}
          />
        </div>
      </ResizablePanel>
    </>
  );
}

/** Expands a minimized column when `count` rises. See the call site. */
function useOpenExpandsColumn(count: number, ref: RefObject<PanelImperativeHandle | null>): void {
  const prev = useRef(count);
  useEffect(() => {
    const panel = ref.current;
    // `expandIfShut` also covers the case this used to crash on: the first
    // section both MOUNTS the panel and bumps `count`, so the ref is set while
    // the group still has no layout for it, and a bare getSize() threw.
    if (count > prev.current) expandIfShut(panel);
    prev.current = count;
  }, [count, ref]);
}
