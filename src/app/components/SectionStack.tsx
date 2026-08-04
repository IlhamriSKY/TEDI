import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { readSectionOrder, reconcileSectionOrder, writeSectionOrder } from "../lib/sectionOrder";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";

/** One section in the stack. `render` receives the controls node (drag grip +
 *  collapse chevron) that the section is expected to place in its own header,
 *  plus whether it is currently minimized so it can skip body work. */
export type StackSection = {
  key: string;
  title: string;
  /** Initial share of the column. The group normalizes across whatever is
   *  currently rendered, so these need not sum to 100%. */
  defaultSize: string;
  /** Height when minimized. Defaults to a 32px (h-8) header plus the card's
   *  borders; surfaces with a taller header (the right column's h-11 ones) must
   *  say so or their header is clipped when collapsed. */
  collapsedSize?: string;
  render: (controls: ReactNode, collapsed: boolean) => ReactNode;
};

// Collapsed (minimized) panel size: the h-8 header (32px) plus the section
// card's 1px top+bottom border, so a minimized bento card shows its full header
// without clipping.
const SECTION_COLLAPSED_SIZE = "34px";
/** For a surface whose header is `h-11` (the right column's panels). */
export const TALL_HEADER_COLLAPSED_SIZE = "46px";
/** Stays px on purpose. The sidebar panel's own minSize had to become a
 *  percentage (see AppSidebar) to survive a minimize, but the same change here
 *  would cap the column at 100/N sections, and N grows with every extension
 *  section. A px minimum scales with window height instead, which is what makes
 *  a tall window able to show them all. */
const SECTION_MIN_SIZE = "100px";

/**
 * A column of stacked sections: real resizable panels (same
 * `react-resizable-panels` model as the editor/terminal splits), each
 * collapsible to its header, and drag-reorderable by the grip in that header.
 * The order persists to localStorage under `orderStorageKey`.
 *
 * Both sidebars render through this. The left column ships the bento card
 * itself (`chrome`); the right column's surfaces already draw their own, so it
 * passes `chrome={false}` and the wrapper contributes only the drag/collapse
 * behaviour.
 */
/**
 * Did this drag finish over the OTHER column's box?
 *
 * The two columns are separate `DndContext`s (each owns its own reorder), so a
 * drag that leaves one is invisible to the other and `over` still names a
 * sibling in the column it started in - `closestCenter` always finds a nearest
 * item, however far away the cursor went. Position is therefore the only honest
 * signal, and it has to be the POINTER: `active.rect` is the whole dragged
 * section, whose centre sits far from the cursor on a tall panel.
 *
 * The pointer is reconstructed from the activator event plus the drag delta,
 * because `DragEndEvent` carries no final coordinates of its own.
 */
function droppedOnOtherColumn(ev: DragEndEvent, column: SectionColumn): boolean {
  const activator = ev.activatorEvent as Partial<PointerEvent> | undefined;
  if (typeof activator?.clientX !== "number" || typeof activator.clientY !== "number") return false;
  const x = activator.clientX + ev.delta.x;
  const y = activator.clientY + ev.delta.y;
  const other = document.querySelector<HTMLElement>(
    `[data-section-column="${column === "left" ? "right" : "left"}"]`,
  );
  // Absent when that column has nothing open, so it renders nothing to aim at.
  if (!other) return false;
  const r = other.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export type SectionColumn = "left" | "right";

export function SectionStack({
  sections,
  orderStorageKey,
  idPrefix,
  chrome = true,
  column,
  canMoveColumn,
  onMoveColumn,
}: {
  sections: StackSection[];
  orderStorageKey: string;
  /** Namespace for the panel ids. Both columns render a stack, and some section
   *  keys collide ("scm" lives in either, and in both at once when Source
   *  Control is docked right while an SSH one is left). */
  idPrefix: string;
  chrome?: boolean;
  /** Which column this stack is. Set it (on BOTH stacks, along with the
   *  `data-section-column` attribute on their containers) to let a section
   *  change columns by dragging it across instead of by the header's move
   *  button. */
  column?: SectionColumn;
  /** Whether `key` may change columns at all. Mirror whatever decides the move
   *  BUTTON, or drag and button will disagree; the primary Files tree is
   *  left-only and must answer false. */
  canMoveColumn?: (key: string) => boolean;
  /** Hand `key` to the other column. Absent = this stack keeps its sections. */
  onMoveColumn?: (key: string) => void;
}) {
  const [order, setOrder] = useState<string[]>(() => readSectionOrder(orderStorageKey));
  const [dragKey, setDragKey] = useState<string | null>(null);
  // The section currently hovered as the drop target, so a thin insertion line
  // can preview where the dragged section will land before release.
  const [overKey, setOverKey] = useState<string | null>(null);
  // Per-section panel handles + their collapsed state (driven by onResize, the
  // only collapse signal this version of react-resizable-panels exposes).
  const panelRefs = useRef<Record<string, PanelImperativeHandle | null>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const byKey = useMemo(() => new Map(sections.map((s) => [s.key, s])), [sections]);
  const visible = useMemo(() => reconcileSectionOrder(order, [...byKey.keys()]), [order, byKey]);

  // Stable per-section ref callbacks (keyed by string) so a panel handle isn't
  // detached/reattached every render. Cached lazily since keys are dynamic.
  // Lazily initialized (the repo's idiom, see AiInputBar's recall cache): a
  // `useRef(new Map())` builds and throws away a Map on every render.
  const panelRefSetterCache = useRef<Map<string, (r: PanelImperativeHandle | null) => void>>(
    undefined!,
  );
  if (!panelRefSetterCache.current) panelRefSetterCache.current = new Map();
  const getPanelRefSetter = (key: string) => {
    let fn = panelRefSetterCache.current.get(key);
    if (!fn) {
      fn = (r) => {
        panelRefs.current[key] = r;
      };
      panelRefSetterCache.current.set(key, fn);
    }
    return fn;
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const syncCollapsed = (key: string) => {
    const isCollapsed = panelRefs.current[key]?.isCollapsed() ?? false;
    setCollapsed((prev) => (prev[key] === isCollapsed ? prev : { ...prev, [key]: isCollapsed }));
  };
  const toggleCollapse = (key: string) => {
    const ref = panelRefs.current[key];
    if (!ref) return;
    if (ref.isCollapsed()) ref.expand();
    else ref.collapse();
  };

  // Track the hovered drop target. Fires only when `over` changes (not per
  // pixel), and we bail out on no-op updates, so the preview stays cheap.
  const handleDragOver = (ev: DragOverEvent) => {
    const next = ev.over ? (ev.over.id as string) : null;
    setOverKey((prev) => (prev === next ? prev : next));
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    setDragKey(null);
    setOverKey(null);
    const { active, over } = ev;
    // Column change wins over reorder, and is tested FIRST: a drag that ended in
    // the other column still reports an `over` from this one (see
    // droppedOnOtherColumn), so checking `over` first would silently reorder
    // instead of handing the section over.
    if (column && onMoveColumn && droppedOnOtherColumn(ev, column)) {
      const key = String(active.id);
      if (canMoveColumn?.(key) ?? true) {
        onMoveColumn(key);
        return;
      }
      // Not movable (the primary Files tree): fall through so the drag still
      // reorders within this column rather than doing nothing at all.
    }
    if (!over || active.id === over.id) return;
    const from = visible.indexOf(active.id as string);
    const to = visible.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    const next = visible.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    writeSectionOrder(orderStorageKey, next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(ev) => setDragKey(ev.active.id as string)}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragKey(null);
        setOverKey(null);
      }}
    >
      <SortableContext items={visible} strategy={verticalListSortingStrategy}>
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1 gap-1.5">
          {(() => {
            // Insertion preview: the dragged section keeps its slot (no reflow,
            // so the resizable layout is untouched); instead a thin line marks
            // the boundary it will drop at. Direction mirrors handleDragEnd:
            // dragging down lands after the target (bottom edge), dragging up
            // lands before it (top edge).
            const dragIdx = dragKey ? visible.indexOf(dragKey) : -1;
            const overIdx = overKey ? visible.indexOf(overKey) : -1;
            const showDrop = dragIdx >= 0 && overIdx >= 0 && dragIdx !== overIdx;
            return visible.map((key, i) => {
              const section = byKey.get(key);
              if (!section) return null;
              const dropEdge: "top" | "bottom" | null =
                showDrop && key === overKey ? (dragIdx < overIdx ? "bottom" : "top") : null;
              return (
                <Fragment key={key}>
                  {i > 0 && <ResizableHandle withHandle />}
                  <ResizablePanel
                    id={`${idPrefix}-${key}`}
                    defaultSize={section.defaultSize}
                    minSize={SECTION_MIN_SIZE}
                    collapsible
                    collapsedSize={section.collapsedSize ?? SECTION_COLLAPSED_SIZE}
                    panelRef={getPanelRefSetter(key)}
                    onResize={() => syncCollapsed(key)}
                  >
                    <SortableSection
                      sectionKey={key}
                      title={section.title}
                      collapsed={!!collapsed[key]}
                      onToggleCollapse={() => toggleCollapse(key)}
                      dropEdge={dropEdge}
                      chrome={chrome}
                    >
                      {(controls) => section.render(controls, !!collapsed[key])}
                    </SortableSection>
                  </ResizablePanel>
                </Fragment>
              );
            });
          })()}
        </ResizablePanelGroup>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {dragKey && (
          <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium shadow-lg ring-1 backdrop-blur-sm">
            <GripVertical size={12} strokeWidth={2} />
            <span className="truncate">{byKey.get(dragKey)?.title ?? ""}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
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
  dropEdge,
  chrome,
  children,
}: {
  sectionKey: string;
  title: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** When this section is the hovered drop target, which edge the dragged
   *  section will land at. `null` otherwise (and for the dragged section). */
  dropEdge: "top" | "bottom" | null;
  chrome: boolean;
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
        <GripVertical size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? `Expand ${title}` : `Minimize ${title}`}
        aria-expanded={!collapsed}
        className="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center rounded"
      >
        {collapsed ? (
          <ChevronRight size={11} strokeWidth={2.25} />
        ) : (
          <ChevronDown size={11} strokeWidth={2.25} />
        )}
      </button>
    </span>
  );
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative h-full overflow-hidden",
        chrome && "bg-background tedi-glass-panel rounded-md border",
        isDragging && "opacity-40",
      )}
    >
      {dropEdge && (
        // Insertion line: a thin primary bar pinned to the target edge. Purely
        // decorative and pointer-transparent so it never interferes with the
        // drag, and absolutely positioned so it adds no layout cost.
        <span
          aria-hidden
          className={cn(
            "bg-primary shadow-primary/60 pointer-events-none absolute inset-x-0 z-20 h-0.5 shadow-[0_0_4px]",
            dropEdge === "top" ? "top-0" : "bottom-0",
          )}
        />
      )}
      {children(controls)}
    </div>
  );
}
