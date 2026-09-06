import { memo, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import { useSshRightPanelStore } from "@/modules/ssh/sshRightPanelStore";
import type { SshRouteHop } from "@/modules/ssh/status";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setStatusBarCompact, setStatusBarLayout } from "@/modules/settings/store";
import { cn } from "@/lib/utils";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { OsPill } from "./OsPill";
import {
  STATUS_ZONES,
  ZONE_LABELS,
  moveItem,
  resolveZones,
  visibleInCompact,
  type StatusZone,
  type ZoneItem,
} from "./layout";
import { useStatusBarEntries } from "./useStatusBarEntries";
import { GitBranch, Server } from "lucide-react";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onOpenMini: () => void;
  /** Whether any SSH leaf is connected. Gates the right-slot Remote toggle so
   *  it appears only alongside a live session, mirroring the left sidebar. */
  hasAnySshLeaf: boolean;
  /** SFTP session id of the active SSH leaf (set only when it is connected).
   *  Lets the breadcrumb browse subfolders remotely instead of hitting the
   *  local filesystem with a remote path, and tells the OS pill whose
   *  `/etc/os-release` to read. */
  sshSessionId?: number | null;
  /** ProxyJump chain of the active SSH leaf, when it has one. Colours the OS
   *  pill while the chain comes up, and spells itself out in its tooltip. */
  sshRoute?: SshRouteHop[];
  /** Name of the host the active SSH leaf is on. Names a DIRECT connection,
   *  which has no route to name it. */
  sshHostLabel?: string | null;
};

// Memoized. Callbacks are stable and props are primitives, so shallow equality
// skips re-render on unrelated parent updates.
function StatusBarInner({
  cwd,
  filePath,
  home,
  onCd,
  onOpenMini,
  hasAnySshLeaf,
  sshSessionId,
  sshRoute,
  sshHostLabel,
}: Props) {
  const compact = usePreferencesStore((s) => s.statusBarCompact);
  const layout = usePreferencesStore((s) => s.statusBarLayout);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Where the item would land if you let go now. */
  const [preview, setPreview] = useState<{ id: string; zone: StatusZone; index: number } | null>(
    null,
  );

  const entries = useStatusBarEntries({
    onOpenMini,
    scm: <ScmRightOpenButton />,
    ssh: <SshRightOpenButton hasAnySshLeaf={hasAnySshLeaf} />,
  });

  // PLACEMENT IS SPLIT FROM DRAWING, and that split is load-bearing.
  //
  // `entries` is a fresh array of fresh elements on every render, and it has to
  // be: the nodes carry live props (an elapsed timer, an open/closed toggle).
  // Deriving the zone arrays from it therefore rebuilt them every render too,
  // and dnd-kit re-registers and re-measures its droppables whenever the arrays
  // it is handed change identity. That measurement runs in a LAYOUT EFFECT that
  // sets state, so the churn fed itself: React gave up with "Maximum update
  // depth exceeded" inside DndContext and the error boundary swallowed the bar.
  //
  // So the layout is computed from the item SET - ids, home zone, pinned - and
  // keyed on a signature of it, which only changes when an item actually
  // appears, disappears or moves. The nodes are looked up by id at render time,
  // so they stay as fresh as they ever were.
  const signature = entries.map((e) => `${e.id}:${e.defaultZone}:${e.pinned ? 1 : 0}`).join("|");
  const items = useMemo(
    () => entries.map(({ id, defaultZone, pinned }) => ({ id, defaultZone, pinned })),
    // Keyed on `signature`, not on `entries`: the signature IS `entries`,
    // compared by value instead of by reference.
    [signature],
  );
  const nodes = new Map(entries.map((e) => [e.id, e.node]));

  // The preview is the real move, applied to a throwaway layout. A sortable
  // only slides its OWN context's items aside, so dragging across zones would
  // otherwise show a floating copy and no hint of where it goes; putting the
  // item into the target zone as you hover makes the bar itself the preview.
  // Running it through `moveItem` is what guarantees the preview and the drop
  // cannot disagree: the drop persists exactly this layout.
  const previewLayout = useMemo(
    () => (preview ? moveItem(items, layout, preview.id, preview.zone, preview.index) : layout),
    [items, layout, preview],
  );
  const zones = useMemo(() => resolveZones(items, previewLayout), [items, previewLayout]);

  const sensors = useSensors(
    // Same 5 px as the tab strip. Every item here is a button, so a drag that
    // started on press would eat the click that is the item's whole purpose.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  /**
   * What the pointer is over, as a slot. `zone:<n>` is the zone's own empty
   * space (the only way to reach an empty zone); anything else is an item, and
   * dropping on an item takes ITS slot - a horizontal sortable reads that as
   * pushing it aside rather than landing behind it.
   */
  const dropTarget = (overId: string | null): { zone: StatusZone; index: number } | null => {
    if (!overId) return null;
    const zoneMatch = /^zone:(\d)$/.exec(overId);
    if (zoneMatch) return { zone: Number(zoneMatch[1]) as StatusZone, index: -1 };
    for (const z of STATUS_ZONES) {
      const at = zones[z].findIndex((i) => i.id === overId);
      if (at >= 0) return { zone: z, index: at };
    }
    return null;
  };

  const onDragOver = (ev: DragOverEvent) => {
    const id = String(ev.active.id);
    const target = dropTarget(ev.over ? String(ev.over.id) : null);
    if (!target) return;
    // Re-setting the same slot on every pointer move would re-render the whole
    // bar mid-drag for nothing.
    setPreview((p) =>
      p && p.id === id && p.zone === target.zone && p.index === target.index
        ? p
        : { id, ...target },
    );
  };

  const onDragEnd = () => {
    setDragging(null);
    // Persist exactly what was on screen a moment ago. Recomputing the target
    // here instead would be a second chance to disagree with the preview.
    if (preview) void setStatusBarLayout(previewLayout);
    setPreview(null);
  };

  const draggingEntry = dragging ? entries.find((e) => e.id === dragging) : null;

  return (
    <footer
      className={cn(
        "border-border/60 bg-card/60 flex h-8 shrink-0 items-center justify-between gap-3 border-t px-3 text-[11px]",
        dragging && "sb-dragging",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        {/* Whose filesystem the breadcrumb is showing, as one logo. Route is
            passed even while the chain is still coming up (before the session
            connects), so a stalled or broken jump still colours the pill. */}
        <OsPill sshSessionId={sshSessionId} sshRoute={sshRoute} sshHostLabel={sshHostLabel} />
        <CwdBreadcrumb
          cwd={cwd}
          filePath={filePath}
          home={home}
          onCd={onCd}
          sshSessionId={sshSessionId}
        />
      </div>
      {/* Three zones, left to right: what this is costing you, what is going on
          elsewhere, and what you can press. Every item can be dragged into any
          of them and the arrangement is saved, so the only fixed thing on this
          side is the fold button - it is the control, and a control that moves
          is a control you have to hunt for. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(ev: DragStartEvent) => setDragging(String(ev.active.id))}
          onDragOver={onDragOver}
          onDragCancel={() => {
            setDragging(null);
            setPreview(null);
          }}
          onDragEnd={onDragEnd}
        >
          {STATUS_ZONES.map((z) => (
            <Zone key={z} zone={z} items={zones[z]} nodes={nodes} compact={compact} />
          ))}
          {/* The overlay is what the cursor carries; without it the item would
              be dragged out of a row that immediately reflows around the hole. */}
          <DragOverlay dropAnimation={null}>
            {draggingEntry ? (
              <div className="bg-popover/90 flex items-center rounded-md px-1 py-0.5 shadow-lg ring-1 ring-black/10">
                {draggingEntry.node}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        <div className="sb-group flex shrink-0 items-center gap-1.5">
          <span className="sb-item flex items-center">
            <CompactToggle compact={compact} />
          </span>
        </div>
      </div>
    </footer>
  );
}

export const StatusBar = memo(StatusBarInner);

/**
 * One zone: a sortable row that is also a drop target, so an item can be
 * dropped into a zone that is currently empty (which is the only way to move
 * the last item out of one).
 *
 * Compact mode filters the items rather than the zone, because the rule is per
 * item: zone 0 stays whole, and the pinned AI items stay wherever they were
 * dragged.
 */
function Zone({
  zone,
  items,
  nodes,
  compact,
}: {
  zone: StatusZone;
  items: ZoneItem[];
  /** What to draw per id. Rebuilt every render on purpose - see `StatusBarInner`. */
  nodes: Map<string, React.ReactNode>;
  compact: boolean;
}) {
  // Memoised for the same reason the zones are: these two arrays are what
  // SortableContext keys its own memos on, and a fresh one per render puts the
  // sortables back into the re-registration churn the zones just came out of.
  const visible = useMemo(
    () => (compact ? items.filter((i) => visibleInCompact(i, zone)) : items),
    [compact, items, zone],
  );
  const ids = useMemo(() => visible.map((i) => i.id), [visible]);
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${zone}` });
  return (
    <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
      <div
        ref={setNodeRef}
        data-over={isOver}
        aria-label={ZONE_LABELS[zone]}
        className="sb-group sb-zone flex shrink-0 items-center gap-1.5"
      >
        {visible.map((item) => (
          <SortableItem key={item.id} id={item.id}>
            {nodes.get(item.id)}
          </SortableItem>
        ))}
      </div>
    </SortableContext>
  );
}

/**
 * One draggable item. The wrapper is what makes an item addressable, and it is
 * deliberately a bare inline-flex span with no padding of its own: the bar's
 * spacing is the zone's `gap`, and a wrapper with a box would double it.
 *
 * `:empty` on this span is also how the CSS knows a zone has nothing to show -
 * an item whose component returns null leaves the span childless.
 */
function SortableItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    // Same curve as the tab strip, so a status item and a tab slide alike.
    transition: { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  });
  return (
    <span
      ref={setNodeRef}
      // THE drop preview: without the transform the neighbours never move and a
      // drag is a floating copy with no indication of where it would land. With
      // it, the items slide aside to open the slot the item would take - the
      // gap IS the preview, and the overlay under the cursor is the thing going
      // into it.
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("sb-item flex items-center", isDragging && "is-dragging")}
      {...attributes}
      {...listeners}
      // The item's own control keeps the keyboard; dnd-kit would otherwise make
      // the wrapper a second tab stop in front of every button in the bar.
      tabIndex={-1}
    >
      {children}
    </span>
  );
}

/**
 * Folds the status bar down to the readouts zone plus TEDI's own AI, wherever
 * that was dragged to. Sits at the far right, outside the zones, so the groups
 * it hides collapse away from it and the button itself never moves.
 */
function CompactToggle({ compact }: { compact: boolean }) {
  const label = compact ? "Show all status bar items" : "Compact status bar";
  return (
    <IconTooltip label={label} side="top">
      <button
        type="button"
        onClick={() => void setStatusBarCompact(!compact)}
        aria-label={label}
        aria-pressed={compact}
        className="text-muted-foreground hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
      >
        {/* Three bars that morph: spread apart they read as a menu glyph
            (items hidden, click to bring them back), folded together and
            crossed they read as an X (click to fold the bars away). Drawn as
            spans rather than swapping two lucide icons so the transition is a
            continuous motion instead of a cross-fade. The geometry copies
            lucide at size 15 / strokeWidth 1.75 so it sits at the same weight
            as the glyphs beside it: 10.5px long (Menu's 16/24, and X's arm is
            12*sqrt(2)/24 - near enough the same), 1.1px thick (1.75*15/24),
            spread +-3.75px (Menu's y=6/18 of 24). */}
        <span className="relative block size-[15px] shrink-0">
          <span className={cn(BAR, compact ? "-translate-y-[3.75px]" : "rotate-45")} />
          <span className={cn(BAR, !compact && "scale-x-0 opacity-0")} />
          <span className={cn(BAR, compact ? "translate-y-[3.75px]" : "-rotate-45")} />
        </span>
      </button>
    </IconTooltip>
  );
}

// The transition names `translate`/`rotate`/`scale` and NOT `transform`:
// Tailwind v4's translate-* / rotate-* / scale-* utilities set the INDIVIDUAL
// transform properties, so `transition-transform` would leave every one of them
// snapping and animate nothing.
const BAR =
  "absolute top-[6.95px] left-[2.25px] h-[1.1px] w-[10.5px] rounded-full bg-current transition-[translate,rotate,scale,opacity] duration-200 ease-out motion-reduce:transition-none";

/**
 * Source Control status-bar toggle. Shown whenever the user has opted in to the
 * right-panel SCM layout (and SCM is enabled); it stays in place whether open or
 * closed (clicking toggles, the open state shows as active) so the status-bar
 * row never reflows. Icon-only chrome matches `AiOpenButton` and the extension
 * panel toggles so the right cluster reads as a single row of glyphs.
 */
function ScmRightOpenButton() {
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  const sourceControlInRightPanel = usePreferencesStore((s) => s.sourceControlInRightPanel);
  const open = useScmRightPanelStore((s) => s.open);
  const toggle = useScmRightPanelStore((s) => s.toggle);
  if (!showSourceControl || !sourceControlInRightPanel) return null;
  return (
    <IconTooltip label={`${open ? "Close" : "Open"} Source Control`} side="top">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${open ? "Close" : "Open"} Source Control`}
        aria-pressed={open}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          open ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <GitBranch size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}

/**
 * SSH (Remote) status-bar toggle. Mirrors `ScmRightOpenButton`: shown whenever
 * the user has docked the Remote explorer to the right AND a session is live
 * (the left sidebar hides SSH the same way when no leaf is connected). Clicking
 * toggles the right-slot panel; the open state shows as active.
 */
function SshRightOpenButton({ hasAnySshLeaf }: { hasAnySshLeaf: boolean }) {
  const sshInRightPanel = usePreferencesStore((s) => s.sshInRightPanel);
  const open = useSshRightPanelStore((s) => s.open);
  const toggle = useSshRightPanelStore((s) => s.toggle);
  if (!sshInRightPanel || !hasAnySshLeaf) return null;
  return (
    <IconTooltip label={`${open ? "Close" : "Open"} Remote`} side="top">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${open ? "Close" : "Open"} Remote`}
        aria-pressed={open}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          open ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Server size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}
