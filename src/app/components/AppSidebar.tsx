import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { FileExplorer } from "@/modules/explorer";
import { type Tab } from "@/modules/tabs";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { WorkspacesPanel } from "@/modules/workspaces";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  DragDropVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  Fragment,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { type TabsApi } from "../hooks/tabsApi";
import { SourceControlPanel, SshFileExplorer } from "./lazyPanels";

type Props = {
  sidebarRef: RefObject<PanelImperativeHandle | null>;
  /** Reports the sidebar panel's size on every resize (drag + window resize),
   *  so App can snapshot the user's width and restore it after a minimize. */
  onSidebarResize: (size: PanelSize) => void;
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
  };
  onOpenRemoteFile: (path: string, sessionId: number, hostLabel: string | null) => void;
  showSourceControl: boolean;
  sourceControlInRightPanel: boolean;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onCloseWorkspace: (workspaceId: string) => void;
  tabCounts: Record<string, number>;
  /** Live tabs of the active workspace, for the Workspaces panel's terminal list. */
  liveTabs: Tab[];
  /** Live AI CLI status per terminal leaf id. */
  aiCliStatuses: Map<number, AiCliStatus>;
  /** Focus a live terminal leaf from the Workspaces panel. */
  onFocusLeaf: (tabId: number, leafId: number) => void;
  /** Currently focused leaf id, to highlight its terminal row in Workspaces. */
  activeLeafId: number | null;
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab">;

// The reorderable sidebar sections, in canonical order.
const SECTION_KEYS = ["files", "ssh", "scm", "workspaces"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];
const SECTION_TITLES: Record<SectionKey, string> = {
  files: "Files",
  ssh: "Remote",
  scm: "Source Control",
  workspaces: "Workspaces",
};
// Initial split (the panel group normalizes for whichever sections are visible);
// Files gets the most room, like the old layout. Users resize from here.
const SECTION_DEFAULT_SIZE: Record<SectionKey, string> = {
  files: "45%",
  ssh: "25%",
  scm: "18%",
  workspaces: "12%",
};

// Collapsed (minimized) panel size: exactly the h-8 header (border-box), so a
// minimized section shows only its header. Min size while expanded keeps a few
// rows of content visible and tidy.
const SECTION_COLLAPSED_SIZE = "32px";
const SECTION_MIN_SIZE = "100px";

// Persisted in localStorage (sidebar lives in the main window only).
const ORDER_LS_KEY = "tedi:sidebar:sectionOrder";

function readOrder(): SectionKey[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ORDER_LS_KEY) ?? "null");
    if (Array.isArray(raw)) {
      const known = SECTION_KEYS as readonly string[];
      const out = raw.filter((k): k is SectionKey => known.includes(k));
      // Backfill any missing key at its canonical position so an older value
      // (e.g. without "ssh") still renders everything in a sensible spot.
      for (const k of SECTION_KEYS) {
        if (out.includes(k)) continue;
        const canonical = SECTION_KEYS.indexOf(k);
        let at = out.length;
        for (let i = 0; i < out.length; i++) {
          if (SECTION_KEYS.indexOf(out[i]) > canonical) {
            at = i;
            break;
          }
        }
        out.splice(at, 0, k);
      }
      if (out.length === SECTION_KEYS.length) return out;
    }
  } catch {
    // Corrupt value: fall through to canonical order.
  }
  return [...SECTION_KEYS];
}

/**
 * The left sidebar column. Sections (Files, Remote/SSH, Source Control,
 * Workspaces) are real resizable panels - same `react-resizable-panels` model
 * as the editor/terminal split panes: drag the divider between two sections to
 * move the boundary. Each panel is collapsible, so its header chevron minimizes
 * it down to just the header (`collapsedSize`); while expanded it stays at least
 * `minSize` so its data is always visible. Sections are drag-reorderable via the
 * grip in each header (order persists to localStorage).
 */
export function AppSidebar({
  sidebarRef,
  onSidebarResize,
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
  onSwitchWorkspace,
  onCreateWorkspace,
  onCloseWorkspace,
  tabCounts,
  liveTabs,
  aiCliStatuses,
  onFocusLeaf,
  activeLeafId,
  openGitDiffTab,
  openScmTab,
}: Props) {
  const [order, setOrder] = useState<SectionKey[]>(() => readOrder());
  const [dragKey, setDragKey] = useState<SectionKey | null>(null);
  // Per-section panel handles + their collapsed state (driven by onResize, the
  // only collapse signal this version of react-resizable-panels exposes).
  const panelRefs = useRef<Partial<Record<SectionKey, PanelImperativeHandle | null>>>({});
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionKey, boolean>>>({});
  // Stable per-section ref callbacks so the panel handle isn't detached and
  // reattached on every render (an inline `panelRef={...}` would be).
  const panelRefSetters = useMemo(() => {
    const setters = {} as Record<SectionKey, (r: PanelImperativeHandle | null) => void>;
    for (const k of SECTION_KEYS) {
      setters[k] = (r) => {
        panelRefs.current[k] = r;
      };
    }
    return setters;
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const scmVisible = showSourceControl && !sourceControlInRightPanel;
  const visible = order.filter(
    (k) => (k !== "scm" || scmVisible) && (k !== "ssh" || hasAnySshLeaf),
  );

  const syncCollapsed = (key: SectionKey) => {
    const isCollapsed = panelRefs.current[key]?.isCollapsed() ?? false;
    setCollapsed((prev) => (prev[key] === isCollapsed ? prev : { ...prev, [key]: isCollapsed }));
  };
  const toggleCollapse = (key: SectionKey) => {
    const ref = panelRefs.current[key];
    if (!ref) return;
    if (ref.isCollapsed()) ref.expand();
    else ref.collapse();
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    setDragKey(null);
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id as SectionKey);
    const to = order.indexOf(over.id as SectionKey);
    if (from < 0 || to < 0) return;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    try {
      localStorage.setItem(ORDER_LS_KEY, JSON.stringify(next));
    } catch {
      // localStorage may be unavailable; order is non-critical, ignore.
    }
  };

  const renderSection = (key: SectionKey, controls: ReactNode): ReactNode => {
    // When the panel is collapsed to its header, skip rendering the body so the
    // virtualized tree / git status stop doing layout work behind the clip.
    const isCollapsed = !!collapsed[key];
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
            collapsed={isCollapsed}
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
              collapsed={isCollapsed}
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
              collapsed={isCollapsed}
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
            aiCliStatuses={aiCliStatuses}
            onFocusLeaf={onFocusLeaf}
            activeLeafId={activeLeafId}
            dragHandle={controls}
          />
        );
    }
  };

  return (
    <ResizablePanel
      id="sidebar"
      panelRef={sidebarRef}
      onResize={onSidebarResize}
      defaultSize="225px"
      minSize="130px"
      maxSize="450px"
      collapsible
      collapsedSize={0}
    >
      <div className="border-border/60 bg-card flex h-full flex-col border-r">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(ev) => setDragKey(ev.active.id as SectionKey)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragKey(null)}
        >
          <SortableContext items={visible} strategy={verticalListSortingStrategy}>
            <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
              {visible.map((key, i) => (
                <Fragment key={key}>
                  {i > 0 && <ResizableHandle withHandle />}
                  <ResizablePanel
                    id={`sidebar-${key}`}
                    defaultSize={SECTION_DEFAULT_SIZE[key]}
                    minSize={SECTION_MIN_SIZE}
                    collapsible
                    collapsedSize={SECTION_COLLAPSED_SIZE}
                    panelRef={panelRefSetters[key]}
                    onResize={() => syncCollapsed(key)}
                  >
                    <SortableSection
                      sectionKey={key}
                      title={SECTION_TITLES[key]}
                      collapsed={!!collapsed[key]}
                      onToggleCollapse={() => toggleCollapse(key)}
                    >
                      {(controls) => renderSection(key, controls)}
                    </SortableSection>
                  </ResizablePanel>
                </Fragment>
              ))}
            </ResizablePanelGroup>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {dragKey && (
              <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium shadow-lg ring-1 backdrop-blur-sm">
                <HugeiconsIcon icon={DragDropVerticalIcon} size={12} strokeWidth={2} />
                <span className="truncate">{SECTION_TITLES[dragKey]}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </ResizablePanel>
  );
}

/**
 * Wraps a section's content. Provides a `controls` node (drag grip + a collapse
 * chevron) that the section renders in its own header via `dragHandle`. The grip
 * drag-reorders the section; the chevron minimizes it to its header. `setNodeRef`
 * marks the sortable node for collision detection (the transform is intentionally
 * not applied so it never fights the resizable panel - the DragOverlay carries
 * the visual). `overflow-hidden` clips the body when the panel is collapsed so a
 * minimized section never bleeds over the one below it.
 */
function SortableSection({
  sectionKey,
  title,
  collapsed,
  onToggleCollapse,
  children,
}: {
  sectionKey: SectionKey;
  title: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: (controls: ReactNode) => ReactNode;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useSortable({ id: sectionKey });
  const controls = (
    <span className="-ml-0.5 flex shrink-0 items-center">
      <button
        type="button"
        {...listeners}
        {...attributes}
        aria-label={`Reorder ${title} section`}
        className="text-muted-foreground/40 hover:text-foreground flex size-4 cursor-grab items-center justify-center rounded active:cursor-grabbing"
      >
        <HugeiconsIcon icon={DragDropVerticalIcon} size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? `Expand ${title}` : `Minimize ${title}`}
        aria-expanded={!collapsed}
        className="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center rounded"
      >
        <HugeiconsIcon
          icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
          size={11}
          strokeWidth={2.25}
        />
      </button>
    </span>
  );
  return (
    <div ref={setNodeRef} className={cn("h-full overflow-hidden", isDragging && "opacity-40")}>
      {children(controls)}
    </div>
  );
}
