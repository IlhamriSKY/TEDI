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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { type Tab } from "@/modules/tabs";
import { buildEntries, entryLabelClass, type Entry } from "@/modules/tabs/lib/entries";
import { EntryIcon } from "@/modules/tabs/components/EntryIcon";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { useGitBranch } from "@/modules/scm/branch";
import { useSshHosts, type SshConnection } from "@/modules/ssh/connections";
import { statusLabel, statusLabelClass, type SshStatus } from "@/modules/ssh/status";
import { aiCliLabel, type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
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
import { countSavedTabEntries, restoreTabs } from "./serialize";
import { useWorkspacesStore, type SavedPaneNode, type SavedTab, type Workspace } from "./store";
import {
  ChevronRight,
  Folder,
  GitBranch,
  LayoutDashboard,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
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
  /** Focus a live entry: activates its tab, and the pane inside it for a leaf.
   *  Standalone tabs (SCM, diffs, extension tabs) pass a leaf id no tree holds,
   *  which the tab side already ignores, so they just activate. */
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  /** Rename a live pane leaf, or reset it to the derived name with `null`. Same
   *  handler the tab strip's right-click Rename uses, so both write one field. */
  onRenameLeaf?: (leafId: number, title: string | null) => void;
  /**
   * Close one listed tab / pane. `leafId` is null for a standalone tab (SCM, a
   * diff, an extension tab) - the same signature and the same handler the tab
   * strip's X uses, so a close from here also gets the busy-terminal and
   * unsaved-editor confirms rather than a second, weaker code path.
   */
  onCloseEntry?: (tabId: number, leafId: number | null) => void;
  /** Currently focused leaf id; highlights its row like the file tree. */
  activeLeafId?: number | null;
  /** Live SSH status per leaf. Colors a connected host's label green here
   *  exactly as it does in the tab strip. */
  sshStatuses?: Map<number, SshStatus>;
  /** Drag handle for sidebar-section reordering, injected by the sidebar. */
  dragHandle?: ReactNode;
  /** Left-sidebar instance: move Workspaces to the shared right panel. */
  onMoveToRight?: () => void;
  /** Right-panel instance: dock Workspaces back into the left sidebar. */
  onMoveToLeft?: () => void;
  /** Right-panel instance: close the docked panel (distinct from `onClose`,
   *  which closes a workspace). */
  onClosePanel?: () => void;
};

/**
 * One row under an expanded workspace: a tab-strip entry, verbatim. The panel
 * deliberately carries `Entry` rather than a shape of its own, so a pane's name,
 * icon, ordinal badge and status colour down here are literally the ones the
 * strip shows for it. This list used to derive its own label from the cwd
 * basename, which is how a renamed tab and an `ssh:<host>` pane both read wrong
 * in the panel while reading right in the strip.
 */
type EntryRow = {
  entry: Entry;
  /** Program-set terminal title (OSC 2), e.g. a running agent's task. */
  title?: string;
  /** Live rows can be focused and renamed; a cold workspace's cannot (its ids
   *  are display-only, minted while rehydrating the snapshot). */
  live: boolean;
};

/** Rows for a workspace whose tabs are live (active, or visited this session). */
function liveRows(
  tabs: Tab[],
  sshHosts: Map<string, SshConnection>,
  sshStatuses: Map<number, SshStatus> | undefined,
  aiStatuses: Map<number, AiCliStatus>,
  titles: Record<number, string>,
): EntryRow[] {
  return buildEntries(tabs, sshHosts, sshStatuses, aiStatuses).map((entry) => ({
    entry,
    title: entry.kind === "pane-leaf" ? titles[entry.leafId] : undefined,
    live: true,
  }));
}

/**
 * Rows for a workspace never opened this session: rehydrate the snapshot into
 * throwaway tabs and run them through the same builder, so a cold workspace
 * names its panes exactly like a live one. Ids come from a private NEGATIVE
 * counter - they are display-only, and staying out of the live id space stops
 * them ever matching `activeLeafId` and false-highlighting a row.
 */
function savedRows(tabs: SavedTab[], sshHosts: Map<string, SshConnection>): EntryRow[] {
  let next = -1;
  const allocId = () => next--;
  const entries = buildEntries(restoreTabs(tabs, allocId), sshHosts);
  const titles = savedTitles(tabs);
  return entries.map((entry, i) => ({ entry, title: titles[i], live: false }));
}

/**
 * Persisted OSC titles in the same depth-first order `buildEntries` emits, to be
 * zipped onto a cold workspace's rows. Live terminals read their title from the
 * store by leaf id; a restored one has no live id yet and restore drops the
 * field (it is live state), so position is what's left to pair them by.
 */
function savedTitles(tabs: SavedTab[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  const walk = (node: SavedPaneNode) => {
    if (node.kind === "split") {
      node.children.forEach(walk);
      return;
    }
    out.push(node.leafKind === "terminal" ? node.title : undefined);
  };
  for (const t of tabs) {
    // A non-pane tab (including the legacy "preview" kind, which restores as
    // nothing) still contributes exactly one slot, so the two lists stay aligned.
    if (t.kind === "pane") walk(t.paneTree);
    else out.push(undefined);
  }
  return out;
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
  onRenameLeaf,
  onCloseEntry,
  activeLeafId,
  sshStatuses,
  dragHandle,
  onMoveToRight,
  onMoveToLeft,
  onClosePanel,
}: Props) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const rename = useWorkspacesStore((s) => s.renameWorkspace);
  const setPinned = useWorkspacesStore((s) => s.setWorkspacePinned);
  const reorder = useWorkspacesStore((s) => s.reorderWorkspaces);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Leaf whose row is currently showing its rename field, or null. Separate from
  // `editingId` above (a WORKSPACE name) - the two edit different things and can
  // never be open at once anyway.
  const [renamingLeafId, setRenamingLeafId] = useState<number | null>(null);
  // dnd-kit active drag id (workspace id), or null when not dragging.
  const [dragId, setDragId] = useState<string | null>(null);
  // Which workspace rows are expanded to reveal their tabs (session-only).
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
  // Saved hosts, so an SSH pane reads `ssh:<name>` here as it does in the strip.
  const sshHosts = useSshHosts();
  // The strip's entry builder takes a Map; the store keeps a Record so a status
  // push rewrites one key instead of the whole map.
  const aiStatuses = useMemo(
    () => new Map<number, AiCliStatus>(Object.entries(statuses).map(([id, s]) => [Number(id), s])),
    [statuses],
  );
  // Rows for any workspace: the active one reads the freshest live tabs; an
  // inactive-but-cached one reads its cached live tabs (leaf ids still match
  // running sessions, so status resolves); a cold workspace rehydrates its
  // persisted snapshot, which carries no live status.
  const rowsFor = (w: Workspace): EntryRow[] => {
    if (w.id === activeId && liveTabs)
      return liveRows(liveTabs, sshHosts, sshStatuses, aiStatuses, titles);
    const cached = cachedTabsByWorkspace?.current.get(w.id);
    if (cached && cached.tabs.length > 0)
      return liveRows(cached.tabs, sshHosts, sshStatuses, aiStatuses, titles);
    return savedRows(w.tabs, sshHosts);
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    setDragId(null);
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tedi-panel-header">
        {dragHandle}
        <LayoutDashboard size={13} strokeWidth={2} className="text-muted-foreground shrink-0" />
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">Workspaces</span>
        <span className="tedi-header-divider" aria-hidden />
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
        {onMoveToRight ? (
          <IconTooltip label="Move to right panel" side="bottom">
            <Button
              onClick={onMoveToRight}
              aria-label="Move Workspaces to the right panel"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <PanelRight size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {onMoveToLeft ? (
          <IconTooltip label="Move to left sidebar" side="bottom">
            <Button
              onClick={onMoveToLeft}
              aria-label="Move Workspaces to the left sidebar"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <PanelLeft size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {onClosePanel ? (
          <IconTooltip label="Close panel" side="bottom">
            <Button
              onClick={onClosePanel}
              aria-label="Close Workspaces panel"
              variant="ghost"
              size="icon"
              className={cn(DESTRUCTIVE_ACTION, "size-6")}
            >
              <X size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
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
                  rows={rowsFor(w)}
                  canClose={workspaces.length > 1}
                  // Editing a name needs an interactive input, so suspend drag
                  // for the row - whether it is the workspace name or a tab's.
                  sortable={editingId !== w.id && renamingLeafId === null}
                  onSwitch={onSwitch}
                  onClose={onClose}
                  onStartEdit={startEdit}
                  onSetPinned={setPinned}
                  onDraftChange={setDraft}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                  onToggleExpanded={toggleExpanded}
                  onFocusLeaf={onFocusLeaf}
                  onRenameLeaf={onRenameLeaf}
                  onCloseEntry={onCloseEntry}
                  renamingLeafId={renamingLeafId}
                  onSetRenamingLeaf={setRenamingLeafId}
                  activeLeafId={activeLeafId}
                />
              ))}
            </ul>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {draggedWorkspace && (
              <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-7 cursor-grabbing items-center gap-1.5 rounded px-1.5 text-xs shadow-lg ring-1 backdrop-blur-sm">
                <Folder size={13} strokeWidth={1.75} className="shrink-0" />
                {draggedWorkspace.pinned && (
                  <Pin aria-hidden size={10} strokeWidth={2.25} className="shrink-0 opacity-70" />
                )}
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
  rows: EntryRow[];
  canClose: boolean;
  sortable: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onStartEdit: (id: string, current: string) => void;
  /** Pin or unpin this workspace. Distinct from pinning a TAB inside it;
   *  see the note on Workspace.pinned in the store. */
  onSetPinned: (id: string, pinned: boolean) => void;
  onDraftChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onToggleExpanded: (id: string) => void;
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  onRenameLeaf?: (leafId: number, title: string | null) => void;
  onCloseEntry?: (tabId: number, leafId: number | null) => void;
  renamingLeafId: number | null;
  onSetRenamingLeaf: (leafId: number | null) => void;
  activeLeafId?: number | null;
};

/**
 * One workspace row. The header line is the drag handle (like a tab), so a
 * plain click still switches and a double-click still renames thanks to the
 * sensor's activation distance. The trailing action buttons and the (optional)
 * tab sub-list stop pointer propagation so interacting with them never starts a
 * drag.
 */
function SortableWorkspaceRow({
  workspace: w,
  isActive,
  isEditing,
  isExpanded,
  draft,
  tabCount,
  rows,
  canClose,
  sortable,
  onSwitch,
  onClose,
  onStartEdit,
  onSetPinned,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onToggleExpanded,
  onFocusLeaf,
  onRenameLeaf,
  onCloseEntry,
  renamingLeafId,
  onSetRenamingLeaf,
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
  const hasRows = rows.length > 0;
  const [confirmingClose, setConfirmingClose] = useState(false);
  // Listed tab/pane awaiting its own close confirmation, or null.
  const [confirmingEntry, setConfirmingEntry] = useState<Entry | null>(null);
  /**
   * Whether the listed tabs get a close button. Two conditions, both load-bearing:
   *  - `isActive`: an entry's ids address the LIVE tab strip, which exists only
   *    for the active workspace. Offering the button on an inactive one would
   *    close nothing (or, worse, whatever shares that id in the live tree).
   *  - `rows.length > 1`: the tab strip's own rule (`canClose = totalEntries > 1`
   *    in SortableTabGroup) - never close the last tab, so the window is never
   *    left empty. Read from the same entry list the strip builds, so the two
   *    cannot disagree.
   */
  const canCloseEntry = isActive && !!onCloseEntry && rows.length > 1;

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
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
              // Stop the drag listeners; a click only toggles the tab list.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => hasRows && onToggleExpanded(w.id)}
              aria-label={isExpanded ? "Collapse tabs" : "Expand tabs"}
              aria-expanded={isExpanded}
              disabled={!hasRows}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded transition-colors",
                hasRows ? "hover:bg-foreground/10" : "opacity-0",
              )}
            >
              {/* One chevron that rotates, not two that swap: a ternary between two
              icons replaces the DOM node, so it can never animate. */}
              <ChevronRight
                size={11}
                strokeWidth={2.25}
                className={cn("transition-transform", isExpanded && "rotate-90")}
              />
            </button>
            <Folder size={13} strokeWidth={1.75} className="shrink-0" />
            {/* Always visible, unlike the hover actions: a pin nobody can see
            without hovering does not explain why this workspace sits at the
            top of the list. */}
            {w.pinned && (
              <Pin
                aria-label="Pinned"
                size={10}
                strokeWidth={2.25}
                className="shrink-0 opacity-70"
              />
            )}
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
              <IconTooltip label={w.pinned ? "Unpin workspace" : "Pin workspace"}>
                <Button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSetPinned(w.id, !w.pinned)}
                  aria-label={w.pinned ? "Unpin workspace" : "Pin workspace"}
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground size-5 rounded"
                >
                  {w.pinned ? (
                    <PinOff size={11} strokeWidth={1.75} />
                  ) : (
                    <Pin size={11} strokeWidth={1.75} />
                  )}
                </Button>
              </IconTooltip>
              <IconTooltip label="Rename">
                <Button
                  // Stop the pointerdown from reaching the row's drag listeners.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onStartEdit(w.id, w.name)}
                  aria-label="Rename workspace"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground size-5 rounded"
                >
                  <Pencil size={11} strokeWidth={1.75} />
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
                    className={cn(DESTRUCTIVE_ACTION, "size-5 rounded")}
                  >
                    <X size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
              )}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => onStartEdit(w.id, w.name)}>Rename</ContextMenuItem>
          {/* Says Workspace, not just Pin. The tab strip has its own Pin Tab
              item, and the two mean different things; naming the subject in
              both places is what keeps them apart. */}
          <ContextMenuItem onSelect={() => onSetPinned(w.id, !w.pinned)}>
            {w.pinned ? "Unpin Workspace" : "Pin Workspace"}
          </ContextMenuItem>
          {canClose && <ContextMenuSeparator />}
          {canClose && (
            <ContextMenuItem
              variant="destructive"
              onSelect={() => (tabCount > 0 ? setConfirmingClose(true) : onClose(w.id))}
            >
              Close Workspace
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

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

      {/* One dialog for the whole row rather than one per listed tab: only ever
          a single close is pending, and the rows can number in the dozens. */}
      <AlertDialog
        open={confirmingEntry !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingEntry(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close &quot;{confirmingEntry?.label}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This tab and anything running in it will be closed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const e = confirmingEntry;
                if (e) onCloseEntry?.(e.tabId, e.kind === "pane-leaf" ? e.leafId : null);
                setConfirmingEntry(null);
              }}
            >
              Close tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isExpanded && hasRows && (
        // Not a drag surface: stop pointerdown so scrolling/clicking the list
        // never starts a workspace reorder.
        <ul onPointerDown={(e) => e.stopPropagation()} className="mt-0.5 mb-1 flex flex-col gap-px">
          {rows.map((r) => (
            <EntryRowItem
              key={r.entry.key}
              row={r}
              isActiveLeaf={
                activeLeafId != null &&
                r.live &&
                r.entry.kind === "pane-leaf" &&
                r.entry.leafId === activeLeafId
              }
              renaming={r.live && r.entry.kind === "pane-leaf" && renamingLeafId === r.entry.leafId}
              onOpen={() => {
                if (r.live && onFocusLeaf) {
                  // Standalone tabs have no leaf; -1 matches none, so the tab
                  // side activates the tab and leaves its panes alone.
                  onFocusLeaf(r.entry.tabId, r.entry.kind === "pane-leaf" ? r.entry.leafId : -1);
                } else if (!isActive) onSwitch(w.id);
              }}
              onRename={onRenameLeaf}
              onSetRenaming={onSetRenamingLeaf}
              onRequestClose={canCloseEntry ? () => setConfirmingEntry(r.entry) : undefined}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One tab/pane row under an expanded workspace. Icon, ordinal badge, label and
 * label colour all come from the tab-strip entry so this list and the strip
 * cannot drift; only the layout is the panel's own.
 */
function EntryRowItem({
  row,
  isActiveLeaf,
  renaming,
  onOpen,
  onRename,
  onSetRenaming,
  onRequestClose,
}: {
  row: EntryRow;
  isActiveLeaf: boolean;
  renaming: boolean;
  onOpen: () => void;
  onRename?: (leafId: number, title: string | null) => void;
  onSetRenaming: (leafId: number | null) => void;
  /** Ask the parent row to confirm closing this entry. Absent when closing it
   *  isn't allowed (not the active workspace, or it's the last tab left). */
  onRequestClose?: () => void;
}) {
  const { entry: e, title } = row;
  const isLeaf = e.kind === "pane-leaf";
  // Renaming writes `customTitle` on a LEAF, so a standalone tab (SCM, a diff,
  // an extension tab) has nothing to write to. A cold workspace's ids are
  // display-only, so its rows are read-only too.
  const canRename = row.live && isLeaf && !!onRename;
  const actionCount = (canRename ? 1 : 0) + (onRequestClose ? 1 : 0);
  const cwd = e.kind === "pane-leaf" ? e.cwd : undefined;
  const sshStatus = e.kind === "pane-leaf" ? e.sshStatus : undefined;
  const ai = e.kind === "pane-leaf" ? e.aiCliStatus : undefined;
  const isPrivate = e.kind === "pane-leaf" && e.isPrivate === true;
  // The OSC title repeats the label often enough (a shell that titles itself
  // after its folder) that showing both would just read as a stutter.
  const showTitle = !!title && title !== e.label && title !== cwd;
  // A remote pane reads its branch over its OWN session, so the answer is the
  // branch on that box rather than on this one. An ad-hoc connection has no
  // saved profile but does have a live session, so it resolves here too.
  const sshSessionId = sshStatus?.kind === "connected" ? sshStatus.sessionId : undefined;
  // Only a terminal has a working directory to be "on a branch" in. A LOCAL one
  // answers from its path alone, so an unopened workspace's panes still show
  // their branch when you expand it - the row is only mounted while expanded, so
  // asking is the user's own doing. A pane bound to an SSH host is skipped until
  // its session is up: without one there is nothing to ask, and asking the local
  // git about a remote path would answer about the wrong machine.
  const isSshLeaf = e.kind === "pane-leaf" && !!e.sshConnectionId;
  const isTerminal = e.kind === "pane-leaf" && e.leafKind === "terminal";
  const branch = useGitBranch(
    isTerminal && (!isSshLeaf || sshSessionId !== undefined) ? cwd : undefined,
    sshSessionId,
  );

  // While renaming, the field replaces the row's button entirely: an <input>
  // inside a <button> is invalid, and a click on the field would activate the
  // row underneath it.
  if (renaming && e.kind === "pane-leaf") {
    return (
      <li className="flex h-6 items-center gap-1.5 pr-1.5 pl-7">
        <EntryIcon entry={e} />
        <InlineInput
          // Same seed as the tab strip: the name without the kind tag.
          initial={e.renameSeed}
          placeholder="Tab name"
          onCommit={(value) => {
            onSetRenaming(null);
            // Blank means "back to the derived name", not an empty tab.
            onRename?.(e.leafId, value.trim() ? value : null);
          }}
          onCancel={() => onSetRenaming(null)}
        />
      </li>
    );
  }

  const rowButton = (
    <button
      type="button"
      onClick={onOpen}
      onDoubleClick={() => {
        if (canRename && e.kind === "pane-leaf") onSetRenaming(e.leafId);
      }}
      className={cn(
        "flex w-full flex-col justify-center text-left text-[11px] transition-colors",
        // Make room for the hover actions so they never sit on top of the label.
        // One button reserves 5, both (pencil + close) reserve 10.
        actionCount === 1 && "group-hover/row:pr-5",
        actionCount === 2 && "group-hover/row:pr-10",
        isActiveLeaf
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_var(--ring)]"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/40",
      )}
    >
      <span className="flex h-6 w-full items-center gap-1.5 pr-1.5 pl-7">
        <EntryIcon entry={e} />
        <span className={cn("min-w-0 flex-1 truncate text-left", entryLabelClass(e))}>
          {e.label}
          {showTitle ? <span className="opacity-60"> · {title}</span> : null}
        </span>
        {e.dirty ? <span className="bg-foreground/60 size-1.5 shrink-0 rounded-full" /> : null}
      </span>
      {/* Branch of this pane's working directory. Absent entirely outside a
          repository, rather than a placeholder row saying nothing. Indented to
          the label, so the branch reads as belonging to the row above it. */}
      {branch ? (
        <span className="text-muted-foreground flex w-full items-center gap-1 pr-1.5 pb-0.5 pl-[1.6rem] text-[10px]">
          <GitBranch size={9} strokeWidth={2} className="text-icon-branch shrink-0" />
          <span className="min-w-0 truncate">{branch}</span>
        </span>
      ) : null}
    </button>
  );

  // The action cluster is a SIBLING of the row button, not a child: nesting one
  // button inside another is invalid HTML and the inner one would swallow the
  // row's own click. Same hover-reveal treatment the workspace row above uses.
  return (
    <li className="group/row relative">
      <Tooltip>
        <TooltipTrigger asChild>{rowButton}</TooltipTrigger>
        {/* Styled tooltip, not the native `title` attribute this list used to
            carry: that renders as an unthemed OS box on its own timing, the one
            odd tooltip among all the themed ones in this panel. */}
        <TooltipContent side="right">
          <div className="flex flex-col gap-0.5">
            <span>{e.label}</span>
            {cwd ? <span className="text-muted-foreground">{cwd}</span> : null}
            {sshStatus ? (
              <span className={statusLabelClass(sshStatus) || "text-muted-foreground"}>
                {statusLabel(sshStatus)}
              </span>
            ) : null}
            {ai ? <span className="text-muted-foreground">{aiCliLabel(ai)}</span> : null}
            {isPrivate ? (
              <span className="text-destructive">Not visible to the native AI agent</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
      {actionCount > 0 && (
        // `top-1` (not a centered translate): a row carrying a branch line is
        // two lines tall, and these belong beside the NAME they act on, not
        // floating between the two.
        // `pointer-events-none` until the row is hovered, like the workspace row
        // above: at opacity-0 these are invisible but still hit-testable, and an
        // invisible close X sitting over a tab name is a click away from a
        // close nobody asked for.
        <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100">
          {canRename && (
            <IconTooltip label="Rename" side="right">
              <Button
                onClick={() => {
                  if (e.kind === "pane-leaf") onSetRenaming(e.leafId);
                }}
                aria-label={`Rename ${e.label}`}
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground size-5 rounded"
              >
                <Pencil size={11} strokeWidth={1.75} />
              </Button>
            </IconTooltip>
          )}
          {onRequestClose && (
            <IconTooltip label="Close tab" side="right">
              <Button
                onClick={onRequestClose}
                aria-label={`Close ${e.label}`}
                variant="ghost"
                size="icon-sm"
                className={cn(DESTRUCTIVE_ACTION, "size-5 rounded")}
              >
                <X size={11} strokeWidth={2} />
              </Button>
            </IconTooltip>
          )}
        </span>
      )}
    </li>
  );
}

export const WorkspacesPanel = memo(WorkspacesPanelInner);
