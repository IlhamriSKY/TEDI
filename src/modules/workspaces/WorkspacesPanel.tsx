import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal/lib/panes";
import { aiCliIconClass, aiCliLabel, type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
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
import { CSS } from "@dnd-kit/utilities";
import { memo, useMemo, useState, type ReactNode, type RefObject } from "react";
import { countSavedTabEntries } from "./serialize";
import { useWorkspacesStore, type SavedPaneNode, type SavedTab, type Workspace } from "./store";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  LayoutDashboard,
  Plus,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";

type Props = {
  /** Pick a workspace. Caller must snapshot current tabs and rehydrate the new one. */
  onSwitch: (workspaceId: string) => void;
  /** Plus button. Caller seeds a new tab strip. */
  onCreate: () => void;
  /** Close a workspace. Caller discards its live tabs and rehydrates the neighbor. */
  onClose: (workspaceId: string) => void;
  /**
   * Live tab-strip entry count per workspace id (one per pane leaf, so a split
   * group tab counts its panes; plus every standalone/session-only diff / scm /
   * extension tab the persisted snapshot drops). Covers every workspace visited
   * this session. Workspaces not present here (restored from disk, not yet
   * opened) fall back to `countSavedTabEntries` over their persisted tabs.
   */
  tabCounts?: Record<string, number>;
  /**
   * Live tabs of the ACTIVE workspace (the runtime tab strip). Used to list the
   * active workspace's open terminals with live status when its row is
   * expanded. Inactive workspaces read their persisted `tabs` instead.
   */
  liveTabs?: Tab[];
  /**
   * Live tab trees of every workspace visited this session, keyed by workspace
   * id (the App-owned cache). Lets an inactive-but-cached workspace list its
   * terminals with live AI CLI status, since its leaf ids still match running
   * sessions. A cold (never-opened) workspace is absent here and falls back to
   * its persisted snapshot, which carries no live status.
   */
  cachedTabsByWorkspace?: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
  /** Focus a specific live terminal leaf (active workspace only). */
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  /** Currently focused leaf id; highlights its terminal row like the file tree. */
  activeLeafId?: number | null;
  /** Drag handle for sidebar-section reordering, injected by the sidebar. */
  dragHandle?: ReactNode;
};

/** One terminal entry shown under an expanded workspace row. */
type TermRow = {
  key: string;
  ordinal?: number;
  cwd?: string;
  /** Program-set terminal title (OSC 2), e.g. a running agent's title. Live only. */
  title?: string;
  /** Per-leaf privacy flag; reddens the ordinal badge, matching the tab strip. */
  private?: boolean;
  /** Live AI CLI status. Always null for inactive (persisted) workspaces. */
  status: AiCliStatus;
  /** Focus target for live terminals; null for persisted ones (click switches). */
  live: { tabId: number; leafId: number } | null;
};

/** Trailing path segment, splitting on both separators (Windows + POSIX). */
function basename(p?: string): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Enumerate the active workspace's live terminal leaves with status + title. */
function liveTermRows(
  tabs: Tab[],
  statuses?: Record<number, NonNullable<AiCliStatus>>,
  titles?: Record<number, string>,
): TermRow[] {
  const rows: TermRow[] = [];
  for (const t of tabs) {
    if (t.kind !== "pane") continue;
    for (const leaf of leaves(t.paneTree)) {
      if (leaf.leafKind !== "terminal") continue;
      rows.push({
        key: `live-${leaf.id}`,
        ordinal: leaf.terminalOrdinal,
        cwd: leaf.cwd,
        title: titles?.[leaf.id],
        private: leaf.private,
        status: statuses?.[leaf.id] ?? null,
        live: { tabId: t.id, leafId: leaf.id },
      });
    }
  }
  return rows;
}

/** Enumerate a persisted workspace's saved terminal leaves (no live status). */
function savedTermRows(tabs: SavedTab[]): TermRow[] {
  const rows: TermRow[] = [];
  const walk = (node: SavedPaneNode) => {
    if (node.kind === "split") {
      node.children.forEach(walk);
      return;
    }
    if (node.leafKind === "terminal") {
      rows.push({
        key: `saved-${rows.length}`,
        ordinal: node.terminalOrdinal,
        cwd: node.cwd,
        title: node.title,
        private: node.private,
        status: null,
        live: null,
      });
    }
  };
  for (const t of tabs) if (t.kind === "pane") walk(t.paneTree);
  return rows;
}

// Memoized. Props are stable callbacks plus the counts map, so shallow equality skips re-renders.
function WorkspacesPanelInner({
  onSwitch,
  onCreate,
  onClose,
  tabCounts,
  liveTabs,
  cachedTabsByWorkspace,
  onFocusLeaf,
  activeLeafId,
  dragHandle,
}: Props) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const rename = useWorkspacesStore((s) => s.renameWorkspace);
  const reorder = useWorkspacesStore((s) => s.reorderWorkspaces);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // dnd-kit active drag id (workspace id), or null when not dragging.
  const [dragId, setDragId] = useState<string | null>(null);
  // Which workspace rows are expanded to reveal their terminals (session-only).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const startEdit = (id: string, current: string) => {
    setEditingId(id);
    setDraft(current);
  };
  const commitEdit = () => {
    if (editingId && draft.trim()) rename(editingId, draft.trim());
    setEditingId(null);
    setDraft("");
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 5px activation distance so a plain click still switches / a double-click
  // still renames; only a real drag starts the reorder. Mirrors the tab strip.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const sortableIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const draggedWorkspace = dragId ? (workspaces.find((w) => w.id === dragId) ?? null) : null;

  // Per-leaf terminal titles (OSC 2), e.g. a running agent's title.
  const titles = useTerminalTitles((s) => s.titles);
  // Live AI CLI status per leaf, written by every running session's detector
  // regardless of attach state - so a hidden workspace's spinner survives.
  const statuses = useAiCliStatuses((s) => s.statuses);
  // Terminal rows for any workspace: the active one reads the freshest live
  // tabs; an inactive-but-cached one reads its cached live tabs (leaf ids still
  // match running sessions, so status resolves); a cold workspace falls back to
  // its persisted snapshot, which carries no live status.
  const termRowsFor = (w: Workspace): TermRow[] => {
    if (w.id === activeId && liveTabs) return liveTermRows(liveTabs, statuses, titles);
    const cached = cachedTabsByWorkspace?.current.get(w.id);
    if (cached && cached.tabs.length > 0) return liveTermRows(cached.tabs, statuses, titles);
    return savedTermRows(w.tabs);
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    setDragId(null);
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        {dragHandle}
        <LayoutDashboard size={13} strokeWidth={2} className="text-muted-foreground shrink-0" />
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">Workspaces</span>
        <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
        <IconTooltip label="New workspace" side="bottom">
          <Button
            onClick={onCreate}
            aria-label="New workspace"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
          >
            <Plus size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(ev) => setDragId(String(ev.active.id))}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragId(null)}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {/* pr-2.5 reserves the 10px Radix ScrollArea overlay-thumb width so the
                row's rename/close buttons and tab-count pill clear the scrollbar. */}
            <ul className="p-1 pr-2.5">
              {workspaces.map((w) => (
                <SortableWorkspaceRow
                  key={w.id}
                  workspace={w}
                  isActive={w.id === activeId}
                  isEditing={editingId === w.id}
                  isExpanded={expanded.has(w.id)}
                  draft={draft}
                  tabCount={tabCounts?.[w.id] ?? countSavedTabEntries(w.tabs)}
                  terminals={termRowsFor(w)}
                  canClose={workspaces.length > 1}
                  // Editing a name needs an interactive input, so suspend drag for that row.
                  sortable={editingId !== w.id}
                  onSwitch={onSwitch}
                  onClose={onClose}
                  onStartEdit={startEdit}
                  onDraftChange={setDraft}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                  onToggleExpanded={toggleExpanded}
                  onFocusLeaf={onFocusLeaf}
                  activeLeafId={activeLeafId}
                />
              ))}
            </ul>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {draggedWorkspace && (
              <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-7 cursor-grabbing items-center gap-1.5 rounded px-1.5 text-xs shadow-lg ring-1 backdrop-blur-sm">
                <Folder size={13} strokeWidth={1.75} className="shrink-0" />
                <span className="truncate">{draggedWorkspace.name}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </ScrollArea>
    </div>
  );
}

type RowProps = {
  workspace: Workspace;
  isActive: boolean;
  isEditing: boolean;
  isExpanded: boolean;
  draft: string;
  tabCount: number;
  terminals: TermRow[];
  canClose: boolean;
  sortable: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onStartEdit: (id: string, current: string) => void;
  onDraftChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onToggleExpanded: (id: string) => void;
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  activeLeafId?: number | null;
};

/**
 * One workspace row. The header line is the drag handle (like a tab), so a
 * plain click still switches and a double-click still renames thanks to the
 * sensor's activation distance. The trailing action buttons and the (optional)
 * terminal sub-list stop pointer propagation so interacting with them never
 * starts a drag.
 */
function SortableWorkspaceRow({
  workspace: w,
  isActive,
  isEditing,
  isExpanded,
  draft,
  tabCount,
  terminals,
  canClose,
  sortable,
  onSwitch,
  onClose,
  onStartEdit,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onToggleExpanded,
  onFocusLeaf,
  activeLeafId,
}: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: w.id,
    disabled: !sortable,
    transition: { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const hasTerminals = terminals.length > 0;
  const [confirmingClose, setConfirmingClose] = useState(false);

  return (
    <li
      ref={setNodeRef}
      // dnd-kit drives transform/transition per frame. Must stay inline.
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      {...attributes}
      {...listeners}
      className={cn("flex flex-col", sortable && "cursor-grab active:cursor-grabbing")}
    >
      <div
        className={cn(
          "group relative flex h-7 items-center gap-1 rounded px-1.5 text-xs",
          isDragging && "opacity-30",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
        )}
      >
        <button
          type="button"
          // Stop the drag listeners; a click only toggles the terminal list.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => hasTerminals && onToggleExpanded(w.id)}
          aria-label={isExpanded ? "Collapse terminals" : "Expand terminals"}
          aria-expanded={isExpanded}
          disabled={!hasTerminals}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded",
            hasTerminals ? "hover:bg-foreground/10" : "opacity-0",
          )}
        >
          {isExpanded ? (
            <ChevronDown size={11} strokeWidth={2.25} />
          ) : (
            <ChevronRight size={11} strokeWidth={2.25} />
          )}
        </button>
        <Folder size={13} strokeWidth={1.75} className="shrink-0" />
        {isEditing ? (
          <input
            autoFocus
            aria-label="Workspace name"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitEdit();
              else if (e.key === "Escape") onCancelEdit();
            }}
            onBlur={onCommitEdit}
            className="border-border/60 bg-background focus:border-primary/40 min-w-0 flex-1 rounded border px-1 text-xs outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!isActive) onSwitch(w.id);
            }}
            onDoubleClick={() => onStartEdit(w.id, w.name)}
            className="min-w-0 flex-1 truncate text-left"
          >
            {w.name}
          </button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "bg-muted/50 shrink-0 rounded px-1 text-[10px] tabular-nums transition-opacity",
                isActive ? "text-accent-foreground/80" : "text-muted-foreground",
                "group-hover:opacity-0",
              )}
              aria-label={`${tabCount} tabs open`}
            >
              {tabCount}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            {`${tabCount} ${tabCount === 1 ? "tab" : "tabs"} open`}
          </TooltipContent>
        </Tooltip>
        <span className="pointer-events-none absolute right-1.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <IconTooltip label="Rename">
            <Button
              // Stop the pointerdown from reaching the row's drag listeners.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onStartEdit(w.id, w.name)}
              aria-label="Rename workspace"
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-5 rounded")}
            >
              <SquarePen size={11} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
          {canClose && (
            <IconTooltip label="Close workspace">
              <Button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => (tabCount > 0 ? setConfirmingClose(true) : onClose(w.id))}
                aria-label="Close workspace"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-5 rounded"
              >
                <X size={11} strokeWidth={2} />
              </Button>
            </IconTooltip>
          )}
        </span>
      </div>

      <AlertDialog open={confirmingClose} onOpenChange={setConfirmingClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close workspace &quot;{w.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {tabCount} open {tabCount === 1 ? "tab" : "tabs"} and any running terminals will
              be closed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onClose(w.id)}>
              Close workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isExpanded && hasTerminals && (
        // Not a drag surface: stop pointerdown so scrolling/clicking the list
        // never starts a workspace reorder.
        <ul onPointerDown={(e) => e.stopPropagation()} className="mt-0.5 mb-1 flex flex-col gap-px">
          {terminals.map((t) => {
            const isActiveTerminal = activeLeafId != null && t.live?.leafId === activeLeafId;
            return (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => {
                    if (t.live && onFocusLeaf) onFocusLeaf(t.live.tabId, t.live.leafId);
                    else if (!isActive) onSwitch(w.id);
                  }}
                  title={t.status ? `${t.cwd ?? "~"} · ${aiCliLabel(t.status)}` : t.cwd}
                  className={cn(
                    "relative flex h-6 w-full items-center gap-1.5 pr-1.5 pl-7 text-left text-[11px] transition-colors",
                    isActiveTerminal
                      ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_var(--ring)]"
                      : "text-sidebar-foreground/85 hover:bg-sidebar-accent/40",
                  )}
                >
                  <SquareTerminal
                    size={11}
                    strokeWidth={1.75}
                    className={cn("shrink-0", t.status ? aiCliIconClass(t.status) : "opacity-70")}
                  />
                  {t.ordinal != null && (
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center rounded px-1 py-[2px] font-mono text-[9px] leading-none font-semibold tabular-nums",
                        t.private
                          ? "bg-destructive text-background"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {t.ordinal}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">
                    {basename(t.cwd) || "~"}
                    {t.title && t.title !== basename(t.cwd) && t.title !== t.cwd ? (
                      <span className="opacity-60"> · {t.title}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export const WorkspacesPanel = memo(WorkspacesPanelInner);
