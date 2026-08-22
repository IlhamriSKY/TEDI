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
  type DragMoveEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { readSectionOrder, reconcileSectionOrder, writeSectionOrder } from "../lib/sectionOrder";
import { ChevronRight, GripVertical } from "lucide-react";
import { useSectionDragStore, type SectionColumn } from "@/lib/sectionDrag";

export type { SectionColumn };

/** One section in the stack. `render` receives the controls node (drag grip +
 *  collapse chevron) that the section is expected to place in its own header,
 *  plus whether it is currently minimized so it can skip body work. */
export type StackSection = {
  key: string;
  title: string;
  /** Initial share of the column. The group normalizes across whatever is
   *  currently rendered, so these need not sum to 100%. */
  defaultSize: string;
  /** Overrides the stack's own `chrome` for this one section. Set false for a
   *  surface that already draws its own bento card (the AI panel does, in
   *  either column), so the left sidebar doesn't wrap a second border round it. */
  chrome?: boolean;
  render: (controls: ReactNode, collapsed: boolean) => ReactNode;
};

// Collapsed (minimized) panel size: the header (32px) plus the section card's
// 1px top+bottom border, so a minimized bento card shows its full header without
// clipping. ONE value for every surface: they all draw `.tedi-panel-header`
// now, which fixes that height in CSS, so the per-section override this used to
// need (a 46px twin for the right column's taller headers) is gone.
const SECTION_COLLAPSED_SIZE = "34px";
/** Stays px on purpose. The sidebar panel's own minSize had to become a
 *  percentage (see AppSidebar) to survive a minimize, but the same change here
 *  would cap the column at 100/N sections, and N grows with every extension
 *  section. A px minimum scales with window height instead, which is what makes
 *  a tall window able to show them all.
 *
 *  60px, not the 100px it started at, because N * minSize is a floor on the
 *  column's height: a column holding the four built-ins plus the AI panel and a
 *  couple of extension sections wanted 800px, which a 768p laptop does not have
 *  once the header, tab strip and status bar are out. 60px still shows a 32px
 *  header plus a row of content, so a section at its minimum is never mistakable
 *  for a minimized one. */
const SECTION_MIN_SIZE = "60px";

/**
 * Is the pointer over the OTHER column's box?
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
function otherColumnEl(column: SectionColumn): HTMLElement | null {
  const sel = `[data-section-column="${column === "left" ? "right" : "left"}"]`;
  // FIRST NON-EMPTY match, not the first match. A column that is minimized shut
  // is still in the DOM at zero width, and it comes before the drop rail that
  // stands in for it (the rail is portalled to `body`, the column lives in the
  // panel group). Taking `querySelector`'s first hit would therefore pick the
  // unaimable one and the drag would die exactly when the rail exists to save
  // it - which is the whole reason a collapsed column could not be dropped into.
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

function overOther(
  ev: { activatorEvent: Event; delta: { x: number; y: number } },
  column: SectionColumn,
): boolean {
  const activator = ev.activatorEvent as Partial<PointerEvent> | undefined;
  if (typeof activator?.clientX !== "number" || typeof activator.clientY !== "number") return false;
  const x = activator.clientX + ev.delta.x;
  const y = activator.clientY + ev.delta.y;
  const other = otherColumnEl(column);
  // Absent when that column has nothing open, so it renders nothing to aim at.
  if (!other) return false;
  const r = other.getBoundingClientRect();
  // Zero-sized when the left sidebar is collapsed shut, which is not a target.
  if (r.width === 0 || r.height === 0) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

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
   *  BUTTON, or drag and button will disagree (an extension section that never
   *  opted into `movableToRight` must answer false). */
  canMoveColumn?: (key: string) => boolean;
  /** Hand `key` to the other column. Absent = this stack keeps its sections. */
  onMoveColumn?: (key: string) => void;
}) {
  const [order, setOrder] = useState<string[]>(() => readSectionOrder(orderStorageKey));
  const [dragKey, setDragKey] = useState<string | null>(null);
  // The section currently hovered as the drop target, so a thin insertion line
  // can preview where the dragged section will land before release.
  const [overKey, setOverKey] = useState<string | null>(null);
  // True while the pointer is over the other column with a movable section in
  // hand. Suppresses this column's own insertion line, which would otherwise
  // promise a reorder that is not going to happen.
  const [overOtherColumn, setOverOtherColumn] = useState(false);
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
    if (ref.isCollapsed()) {
      ref.expand();
      return;
    }
    // Collapsing pushes the freed space onto the NEXT panel, and when that one
    // is itself collapsed the library pops it back open to absorb - which is why
    // minimizing sections one at a time used to stall with the last one stuck
    // open. Re-assert the whole set that should be minimized until it sticks;
    // with FILLER_PANEL at the end of the group there is always somewhere for
    // the leftover to go, so the set converges instead of fighting itself.
    //
    // Three passes because each collapse can disturb at most one neighbour, and
    // the loop exits as soon as nothing changed - it is not a spin.
    const desired = visible.filter((k) => panelRefs.current[k]?.isCollapsed());
    desired.push(key);
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const k of desired) {
        const panel = panelRefs.current[k];
        if (panel && !panel.isCollapsed()) {
          panel.collapse();
          changed = true;
        }
      }
      if (!changed) break;
    }
  };

  // Track the hovered drop target. Fires only when `over` changes (not per
  // pixel), and we bail out on no-op updates, so the preview stays cheap.
  const handleDragOver = (ev: DragOverEvent) => {
    const next = ev.over ? (ev.over.id as string) : null;
    setOverKey((prev) => (prev === next ? prev : next));
  };

  /**
   * Ring the OTHER column while the pointer is over it, so a cross-column drag
   * says where it will land instead of only acting on release.
   *
   * The attribute is written straight to that column's DOM node rather than
   * lifted into React state, for two reasons: the node belongs to a sibling
   * component (AppSidebar / AppRightSlot) with no shared ancestor holding drag
   * state, and this fires per pointer move, where re-rendering two whole columns
   * would cost far more than one attribute write. It is cleared on drag end and
   * cancel, and the drag cannot outlive the pointer, so it never sticks.
   */
  const markDropTarget = (on: boolean) => {
    const el = column ? otherColumnEl(column) : null;
    if (!el) return;
    if (on) el.setAttribute("data-drop-target", "");
    else el.removeAttribute("data-drop-target");
  };

  const handleDragMove = (ev: DragMoveEvent) => {
    if (!column || !onMoveColumn) return;
    const key = String(ev.active.id);
    // Only promise a landing the drop will honour: an ineligible section must
    // not light the column up and then stay put.
    const over = overOther(ev, column) && (canMoveColumn?.(key) ?? true);
    markDropTarget(over);
    setOverOtherColumn((prev) => (prev === over ? prev : over));
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    // Read the pointer against the other column BEFORE tearing the drag down.
    // An empty column's target is a rail that exists only while a drag is in
    // hand (see AppRightSlot), so clearing the drag state first would be racing
    // its own drop target out of the DOM.
    const droppedOnOtherColumn = column ? overOther(ev, column) : false;
    setDragKey(null);
    setOverKey(null);
    setOverOtherColumn(false);
    markDropTarget(false);
    useSectionDragStore.getState().setColumn(null);
    const { active, over } = ev;
    // Column change wins over reorder, and is tested FIRST: a drag that ended in
    // the other column still reports an `over` from this one (see
    // droppedOnOtherColumn), so checking `over` first would silently reorder
    // instead of handing the section over.
    if (column && onMoveColumn && droppedOnOtherColumn) {
      const key = String(active.id);
      if (canMoveColumn?.(key) ?? true) {
        onMoveColumn(key);
        // Tell the receiving column to open itself if it is shut.
        // dockRight / dockLeft already reveal the destination column, so the
        // stack does not have to - see app/lib/sectionDock.
        return;
      }
      // Not movable: fall through so the drag still reorders within this
      // column rather than doing nothing at all.
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
      onDragStart={(ev) => {
        setDragKey(ev.active.id as string);
        // Lets an EMPTY other column put up a drop rail; it has no box of its
        // own to aim at otherwise.
        if (column) useSectionDragStore.getState().setColumn(column);
      }}
      onDragOver={handleDragOver}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragKey(null);
        setOverKey(null);
        setOverOtherColumn(false);
        markDropTarget(false);
        useSectionDragStore.getState().setColumn(null);
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
            const showDrop =
              !overOtherColumn && dragIdx >= 0 && overIdx >= 0 && dragIdx !== overIdx;
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
                    collapsedSize={SECTION_COLLAPSED_SIZE}
                    panelRef={getPanelRefSetter(key)}
                    onResize={() => syncCollapsed(key)}
                  >
                    <SortableSection
                      sectionKey={key}
                      title={section.title}
                      collapsed={!!collapsed[key]}
                      onToggleCollapse={() => toggleCollapse(key)}
                      dropEdge={dropEdge}
                      chrome={section.chrome ?? chrome}
                    >
                      {(controls) => section.render(controls, !!collapsed[key])}
                    </SortableSection>
                  </ResizablePanel>
                </Fragment>
              );
            });
          })()}
          {/* Somewhere for the leftover to go when EVERY section is minimized.
              A panel group must fill 100% of its container, so with only real
              sections in it the library had to keep one of them open to absorb
              the space that N * 34px of headers leaves over - which is exactly
              why the last section could never be minimized. This panel has no
              `ResizableHandle` before it, so the user can never drag against it,
              and `defaultSize={0}` / `minSize={0}` mean it takes nothing at all
              while any section is still open.

              One visible consequence, kept deliberately: minimizing the BOTTOM
              section leaves the space it freed here rather than growing the
              section above it. It reads as tray whitespace under the stack, and
              it comes back the moment anything is expanded or resized. */}
          <ResizablePanel id={`${idPrefix}-filler`} defaultSize={0} minSize={0}>
            <span aria-hidden />
          </ResizablePanel>
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
        className="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center rounded transition-colors"
      >
        {/* One chevron that rotates, not two that swap: a ternary between two
            icons replaces the DOM node, so it can never animate. */}
        <ChevronRight
          size={11}
          strokeWidth={2.25}
          className={cn("transition-transform", !collapsed && "rotate-90")}
        />
      </button>
    </span>
  );
  return (
    <div
      ref={setNodeRef}
      // Minimized. Read only by CSS, which strips a header back to its label row
      // (see `.tedi-header-divider` in globals.css) - that is why the AI panel
      // and the extension panel host never need a `collapsed` prop of their own.
      data-section-collapsed={collapsed ? "" : undefined}
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
