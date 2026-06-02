import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import {
  Cancel01Icon,
  DashboardSquare02Icon,
  Folder01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
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
import { CSS } from "@dnd-kit/utilities";
import { memo, useMemo, useState } from "react";
import { useWorkspacesStore, type Workspace } from "./store";

type Props = {
  /** Pick a workspace. Caller must snapshot current tabs and rehydrate the new one. */
  onSwitch: (workspaceId: string) => void;
  /** Plus button. Caller seeds a new tab strip. */
  onCreate: () => void;
  /** Close a workspace. Caller discards its live tabs and rehydrates the neighbor. */
  onClose: (workspaceId: string) => void;
  /**
   * Live open-tab count per workspace id (every tab kind, including the
   * session-only diff / scm / extension tabs the persisted snapshot drops).
   * Covers every workspace visited this session. Workspaces not present here
   * (restored from disk, not yet opened) fall back to their persisted
   * `tabs.length`.
   */
  tabCounts?: Record<string, number>;
};

// Memoized. Props are stable callbacks plus the counts map, so shallow equality skips re-renders.
function WorkspacesPanelInner({ onSwitch, onCreate, onClose, tabCounts }: Props) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const rename = useWorkspacesStore((s) => s.renameWorkspace);
  const reorder = useWorkspacesStore((s) => s.reorderWorkspaces);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // dnd-kit active drag id (workspace id), or null when not dragging.
  const [dragId, setDragId] = useState<string | null>(null);

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

  // 5px activation distance so a plain click still switches / a double-click
  // still renames; only a real drag starts the reorder. Mirrors the tab strip.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const sortableIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const draggedWorkspace = dragId ? (workspaces.find((w) => w.id === dragId) ?? null) : null;

  const handleDragEnd = (ev: DragEndEvent) => {
    setDragId(null);
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <HugeiconsIcon
          icon={DashboardSquare02Icon}
          size={13}
          strokeWidth={2}
          className="text-muted-foreground shrink-0"
        />
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
            <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
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
            <ul className="p-1">
              {workspaces.map((w) => (
                <SortableWorkspaceRow
                  key={w.id}
                  workspace={w}
                  isActive={w.id === activeId}
                  isEditing={editingId === w.id}
                  draft={draft}
                  tabCount={tabCounts?.[w.id] ?? w.tabs.length}
                  canClose={workspaces.length > 1}
                  // Editing a name needs an interactive input, so suspend drag for that row.
                  sortable={editingId !== w.id}
                  onSwitch={onSwitch}
                  onClose={onClose}
                  onStartEdit={startEdit}
                  onDraftChange={setDraft}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                />
              ))}
            </ul>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {draggedWorkspace && (
              <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-7 cursor-grabbing items-center gap-1.5 rounded px-1.5 text-xs shadow-lg ring-1 backdrop-blur-sm">
                <HugeiconsIcon
                  icon={Folder01Icon}
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
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
  draft: string;
  tabCount: number;
  canClose: boolean;
  sortable: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onStartEdit: (id: string, current: string) => void;
  onDraftChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
};

/**
 * One workspace row. The whole row is the drag handle (like a tab), so a plain
 * click still switches and a double-click still renames thanks to the sensor's
 * activation distance. The trailing action buttons stop pointer propagation so
 * clicking them never starts a drag.
 */
function SortableWorkspaceRow({
  workspace: w,
  isActive,
  isEditing,
  draft,
  tabCount,
  canClose,
  sortable,
  onSwitch,
  onClose,
  onStartEdit,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
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

  return (
    <li
      ref={setNodeRef}
      // dnd-kit drives transform/transition per frame. Must stay inline.
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "group relative flex h-7 items-center gap-1.5 rounded px-1.5 text-xs",
        sortable && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-30",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
      )}
    >
      <HugeiconsIcon icon={Folder01Icon} size={13} strokeWidth={1.75} className="shrink-0" />
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
            <HugeiconsIcon icon={PencilEdit02Icon} size={11} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
        {canClose && (
          <IconTooltip label="Close workspace">
            <Button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onClose(w.id)}
              aria-label="Close workspace"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-5 rounded"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </Button>
          </IconTooltip>
        )}
      </span>
    </li>
  );
}

export const WorkspacesPanel = memo(WorkspacesPanelInner);
