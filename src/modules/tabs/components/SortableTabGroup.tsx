import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type SshConnection } from "@/modules/ssh/connections";
import { MoreVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo } from "react";
import { type Entry, type PaneEntry } from "../lib/entries";
import { type PaneGroupForMove, type RenderEntryArgs, renderEntryBody } from "./renderEntryBody";

type SortableTabGroupProps = {
  tabId: number;
  /** Consecutive entries belonging to one tab. Length > 1 means split panes; rendered as a bordered cluster. */
  entries: Entry[];
  /** Total entries across all groups. Drives can-close gating. */
  totalEntries: number;
  /** Active entry's composite key. Compared in JS instead of via CSS to avoid Tailwind variant collisions with Radix's `::after`. */
  activeKey: string | null;
  /** Composite key of the last entry. Drives the "Close tabs to the right" menu item. */
  lastEntryKey: string | null;
  compact?: boolean;
  sortable: boolean;
  /** True when per-leaf reorder is wired up. Drives whether the inner SortableContext mounts. */
  leafSortable: boolean;
  /** True while any group is being dragged. */
  groupDragging: boolean;
  /** True when this group is being dragged. */
  isDragging: boolean;
  onPinLeaf: (tabId: number, leafId: number) => void;
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  /** Close every entry to the right of `entry`. Lives in TabBar for the flattened entry list. */
  onCloseEntriesAfter: (entry: Entry) => void;
  /** Resolves SSH connection id to host metadata for tooltips. */
  sshHosts: Map<string, SshConnection>;
  /** Move a leaf into another pane tab. */
  onMoveLeafToGroup?: (leafId: number, targetTabId: number) => void;
  /** Extract a leaf into a new top-level pane tab. */
  onMoveLeafToNewTab?: (leafId: number) => "ok" | "invalid";
  /** Flip the orientation of the split containing this leaf. */
  onRotateLeafSplit?: (leafId: number) => void;
  /** Toggle privacy on a single leaf. */
  onTogglePrivate?: (leafId: number) => void;
  paneGroupsForMove: PaneGroupForMove[];
};

/**
 * Renders all entries of one tab. Single-leaf tabs use the entry as the drag
 * handle. Split groups put the handle on a dedicated grip so the entries can
 * drive per-leaf reorder via an inner `SortableContext`.
 */
export function SortableTabGroup({
  tabId,
  entries,
  totalEntries,
  activeKey,
  lastEntryKey,
  compact,
  sortable,
  leafSortable,
  groupDragging,
  isDragging: isThisDragging,
  onPinLeaf,
  onCloseEntry,
  onCloseEntriesAfter,
  sshHosts,
  onMoveLeafToGroup,
  onMoveLeafToNewTab,
  onRotateLeafSplit,
  onTogglePrivate,
  paneGroupsForMove,
}: SortableTabGroupProps) {
  const isSplit = entries.length > 1;
  // Group-level drag is wired on every tab. Single-leaf tabs use the first
  // entry as the drag handle. Split groups get a dedicated grip; the inner
  // entries handle per-leaf reorder.
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: `tab:${tabId}`,
    disabled: !sortable,
    transition: {
      duration: 200,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const canClose = totalEntries > 1;

  // Inner sortable items. Only consulted when `isSplit && leafSortable`; other tabs skip the inner SortableContext.
  const leafItems = useMemo(
    () =>
      entries.filter((e): e is PaneEntry => e.kind === "pane-leaf").map((e) => `leaf:${e.leafId}`),
    [entries],
  );

  const renderedEntries = entries.map((e, idx) => {
    // Split group: each leaf carries its own drag handle. Single-leaf tab:
    // the first entry inherits the group-level drag listeners.
    if (isSplit && leafSortable && e.kind === "pane-leaf") {
      return (
        <SortableLeafEntry
          key={e.key}
          entry={e}
          idx={idx}
          isSplit={isSplit}
          totalEntries={totalEntries}
          activeKey={activeKey}
          lastEntryKey={lastEntryKey}
          compact={compact}
          canClose={canClose}
          onPinLeaf={onPinLeaf}
          onCloseEntry={onCloseEntry}
          onCloseEntriesAfter={onCloseEntriesAfter}
          sshHosts={sshHosts}
          onMoveLeafToGroup={onMoveLeafToGroup}
          onMoveLeafToNewTab={onMoveLeafToNewTab}
          onRotateLeafSplit={onRotateLeafSplit}
          onTogglePrivate={onTogglePrivate}
          paneGroupsForMove={paneGroupsForMove}
        />
      );
    }
    // Single-leaf tabs reuse the group's drag handlers on the sole entry.
    // Split groups defer to the dedicated grip, so no drag handlers here.
    const isGroupDragHandle = !isSplit && idx === 0;
    return renderEntryBody({
      entry: e,
      idx,
      isSplit,
      totalEntries,
      activeKey,
      lastEntryKey,
      compact,
      canClose,
      dragAttrs: isGroupDragHandle ? attributes : undefined,
      dragListeners: isGroupDragHandle ? listeners : undefined,
      onPinLeaf,
      onCloseEntry,
      onCloseEntriesAfter,
      sshHosts,
      onMoveLeafToGroup,
      onMoveLeafToNewTab,
      onRotateLeafSplit,
      onTogglePrivate,
      paneGroupsForMove,
    });
  });

  return (
    <div
      ref={setNodeRef}
      // dnd-kit drives transform/transition per frame. Must stay inline.
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      data-tab-id={tabId}
      data-tauri-drag-region="false"
      className={cn(
        "flex h-7 shrink-0 items-center transition-[border-color,background-color,opacity] duration-150",
        // Split tabs get a bordered cluster. Single-pane tabs stay borderless.
        isSplit ? "border-border/70 bg-muted/20 gap-0 overflow-hidden rounded-md border p-0" : "",
        isSplit && groupDragging && !isThisDragging && "border-border",
        isSplit && isThisDragging && "border-primary/70 bg-accent/30",
        sortable && !isSplit && "cursor-grab active:cursor-grabbing",
        isThisDragging && "opacity-30",
      )}
    >
      {isSplit && sortable && (
        // Grip for whole-group drag. Sits inside the cluster but carries the
        // group sortable's listeners. Leaf entries below use the inner per-leaf sortable.
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              {...attributes}
              {...listeners}
              aria-label="Drag group"
              data-tauri-drag-region="false"
              className={cn(
                "text-muted-foreground/60 hover:text-foreground/80 hover:bg-muted/50 flex h-full shrink-0 cursor-grab items-center justify-center self-stretch px-0.5 transition-colors active:cursor-grabbing",
                isThisDragging && "cursor-grabbing",
              )}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} size={12} strokeWidth={2} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Drag group</TooltipContent>
        </Tooltip>
      )}
      {isSplit && leafSortable ? (
        <SortableContext items={leafItems} strategy={horizontalListSortingStrategy}>
          {renderedEntries}
        </SortableContext>
      ) : (
        renderedEntries
      )}
    </div>
  );
}

/** Per-leaf sortable wrapper. Inside a split group's inner SortableContext; renders via `renderEntryBody`. */
type SortableLeafEntryProps = Omit<
  RenderEntryArgs,
  "dragAttrs" | "dragListeners" | "dragRef" | "dragStyle" | "selfDragging"
> & {
  entry: PaneEntry;
};

function SortableLeafEntry(props: SortableLeafEntryProps) {
  const { entry, ...rest } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `leaf:${entry.leafId}`,
    transition: {
      duration: 200,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return renderEntryBody({
    entry,
    ...rest,
    dragAttrs: attributes,
    dragListeners: listeners,
    dragRef: setNodeRef,
    dragStyle: style,
    selfDragging: isDragging,
  });
}
