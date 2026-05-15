import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { leafIds, leaves, type PaneLeaf } from "@/modules/terminal/lib/panes";
import { MAX_PANES_PER_TAB } from "./lib/useTabs";
import {
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "@/modules/ssh/connections";
import {
  statusDotClass,
  statusLabel,
  type SshStatus,
} from "@/modules/ssh/status";
import {
  Cancel01Icon,
  CloudServerIcon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  Layers01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Rotate01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DropAnimation,
  type Modifier,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "./lib/useTabs";

/**
 * The tab strip lists entries - one per **pane** for pane tabs (so each
 * terminal/editor leaf shows up as its own clickable entry), and one per
 * tab for preview / ai-diff. Clicking a pane entry focuses that pane in
 * its owning tab; clicking a preview/ai-diff entry activates that tab.
 */
type EntryBase = {
  /** Stable composite key (e.g. "tab-3", "leaf-7"). */
  key: string;
  /** Which tab this entry belongs to. */
  tabId: number;
  /** Display label. */
  label: string;
  /** Italic for preview/transient. */
  italic?: boolean;
  /** Yellow dot for unsaved-edit indicator. */
  dirty?: boolean;
};

type PaneEntry = EntryBase & {
  kind: "pane-leaf";
  leafId: number;
  leafKind: "terminal" | "editor";
  /** Set on terminal leaves bound to a saved SSH host. */
  sshConnectionId?: string;
  /** Latest known status for SSH leaves, drives the colored dot. */
  sshStatus?: SshStatus;
};

type StandaloneEntry = EntryBase & {
  kind: "preview" | "ai-diff" | "git-diff";
};

type Entry = PaneEntry | StandaloneEntry;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function entryLabel(
  leaf: PaneLeaf,
  fallbackCwd: string | undefined,
  sshHosts: Map<string, SshConnection>,
): string {
  if (leaf.leafKind === "editor") return basename(leaf.path);
  // SSH leaves: show "ssh:<host>" so the destination is visible at a
  // glance, especially after a split where the tab title falls back to
  // a generic label. Falls back to bare "ssh" if the connection was
  // deleted from the keychain while the leaf is still open.
  if (leaf.sshConnectionId) {
    const host = sshHosts.get(leaf.sshConnectionId);
    return host ? `ssh:${host.host}` : "ssh";
  }
  if (leaf.cwd) {
    const b = basename(leaf.cwd);
    if (b) return b;
  }
  if (fallbackCwd) {
    const b = basename(fallbackCwd);
    if (b) return b;
  }
  return "shell";
}

function buildEntries(
  tabs: Tab[],
  sshHosts: Map<string, SshConnection>,
  sshStatuses?: Map<number, SshStatus>,
): Entry[] {
  const out: Entry[] = [];
  for (const t of tabs) {
    if (t.kind === "pane") {
      for (const leaf of leaves(t.paneTree)) {
        const label = entryLabel(leaf, t.cwd, sshHosts);
        const sshConnectionId =
          leaf.leafKind === "terminal" ? leaf.sshConnectionId : undefined;
        out.push({
          kind: "pane-leaf",
          key: `leaf-${leaf.id}`,
          tabId: t.id,
          leafId: leaf.id,
          leafKind: leaf.leafKind,
          label,
          italic:
            leaf.leafKind === "editor" && (leaf as PaneLeaf & { preview?: boolean }).preview === true,
          dirty:
            leaf.leafKind === "editor" && (leaf as PaneLeaf & { dirty?: boolean }).dirty === true,
          sshConnectionId,
          sshStatus: sshConnectionId
            ? sshStatuses?.get(leaf.id)
            : undefined,
        });
      }
      continue;
    }
    if (t.kind === "preview") {
      out.push({
        kind: "preview",
        key: `tab-${t.id}`,
        tabId: t.id,
        label: t.title,
      });
      continue;
    }
    if (t.kind === "ai-diff") {
      out.push({
        kind: "ai-diff",
        key: `tab-${t.id}`,
        tabId: t.id,
        label: t.title,
      });
      continue;
    }
    // git-diff
    out.push({
      kind: "git-diff",
      key: `tab-${t.id}`,
      tabId: t.id,
      label: t.title,
    });
  }
  return out;
}

type Props = {
  tabs: Tab[];
  activeId: number;
  /**
   * Activate a pane entry. `leafId` is null for standalone (preview / ai-diff)
   * entries - caller should just activate the tab.
   */
  onSelectEntry: (tabId: number, leafId: number | null) => void;
  /**
   * Close a pane leaf or a standalone tab. `leafId` is null for standalone.
   */
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  onNewTerminal: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  /** Promote a preview-editor leaf to persistent on double-click. */
  onPinLeaf: (tabId: number, leafId: number) => void;
  /**
   * Drag-and-drop reorder among *tabs*. We don't support reordering
   * individual pane leaves yet - only top-level tabs swap positions.
   * `beforeTabId` of null means drop at end.
   */
  onReorderTabs?: (fromTabId: number, beforeTabId: number | null) => void;
  /**
   * Move a leaf out of its current tab and graft it as a split into
   * `targetTabId`. Drives the per-entry "Move to group" button (left of the
   * close X). Caller enforces `MAX_PANES_PER_TAB` and surfaces a toast on
   * full / invalid.
   */
  onMoveLeafToGroup?: (leafId: number, targetTabId: number) => void;
  /**
   * Flip the orientation (row ↔ col) of the split node that **directly**
   * contains `leafId`. The icon only renders on entries that belong to a
   * split group (single-pane tabs have nothing to rotate); clicks affect
   * only that leaf's surrounding split, leaving any sibling splits in the
   * tab untouched.
   */
  onRotateLeafSplit?: (leafId: number) => void;
  /**
   * Optional map keyed by leafId carrying the latest SSH session status.
   * Drives the colored dot on the SSH entry icon and the status line in
   * the tab tooltip. Untracked leaves render as "Connecting…".
   */
  sshStatuses?: Map<number, SshStatus>;
  compact?: boolean;
};

/**
 * Snappy-but-soft drop animation. The default ease-out + 250ms felt sluggish
 * after release; 180ms with an ease-out-quint curve lands the tab faster
 * without losing the "ease in to rest" feeling.
 */
const DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

/**
 * Pin the DragOverlay so the pointer stays at the horizontal centre of the
 * dragged tab and the chip never leaves the tab strip's y-line. Header has
 * a top border and the tab strip sits inside an h-10 row - without locking
 * y, the overlay drifts up/down toward whichever border is closer to the
 * cursor and visually "snaps to a line" instead of sitting centred.
 */
const snapCenterAndLockY: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const ev = activatorEvent as PointerEvent;
  const offsetX = ev.clientX - draggingNodeRect.left;
  return {
    ...transform,
    x: transform.x + offsetX - draggingNodeRect.width / 2,
    // y: 0 keeps the overlay glued to the dragged node's original row
    // (the tab strip line). Cursor can drift vertically; the chip won't.
    y: 0,
  };
};

export function TabBar({
  tabs,
  activeId,
  onSelectEntry,
  onCloseEntry,
  onNewTerminal,
  onNewPreview,
  onNewEditor,
  onPinLeaf,
  onReorderTabs,
  onMoveLeafToGroup,
  onRotateLeafSplit,
  sshStatuses,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeDragId, setActiveDragId] = useState<number | null>(null);
  // Load saved SSH hosts once + on change, so we can resolve a leaf's
  // `sshConnectionId` to its `user@host:port` for the tab tooltip.
  const [sshHosts, setSshHosts] = useState<Map<string, SshConnection>>(
    () => new Map(),
  );
  useEffect(() => {
    const load = () =>
      void listConnections().then((list) =>
        setSshHosts(new Map(list.map((c) => [c.id, c]))),
      );
    load();
    const unsub = onConnectionsChanged(load);
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);

  const entries = useMemo(
    () => buildEntries(tabs, sshHosts, sshStatuses),
    [tabs, sshHosts, sshStatuses],
  );

  /**
   * Snapshot of every pane tab keyed by id, used by the per-entry "Move to
   * group" button to enumerate possible targets and tell the user which ones
   * are at the per-tab pane cap. Includes the full ones (rendered disabled)
   * so the menu's contents stay stable - the user can still see what's
   * there, just can't pick it.
   */
  const paneGroupsForMove = useMemo(
    () =>
      tabs.flatMap((t) =>
        t.kind === "pane"
          ? [
              {
                id: t.id,
                title: t.title,
                count: leafIds(t.paneTree).length,
                full: leafIds(t.paneTree).length >= MAX_PANES_PER_TAB,
              },
            ]
          : [],
      ),
    [tabs],
  );

  // Group entries by their owning top-level tab. A tab with split panes
  // contributes multiple consecutive entries (one per leaf); a single-pane
  // tab contributes exactly one. We render each group as a bordered cluster
  // so the user can see which entries belong to the same split.
  const entryGroups = useMemo(() => {
    const groups: { tabId: number; entries: Entry[] }[] = [];
    for (const entry of entries) {
      const last = groups[groups.length - 1];
      if (last && last.tabId === entry.tabId) {
        last.entries.push(entry);
      } else {
        groups.push({ tabId: entry.tabId, entries: [entry] });
      }
    }
    return groups;
  }, [entries]);

  const draggedEntry = useMemo(
    () =>
      activeDragId === null
        ? null
        : entries.find((e) => e.tabId === activeDragId) ?? null,
    [entries, activeDragId],
  );

  // Determine which entry is "active". For pane tabs, follow tab.activeLeafId;
  // for standalone tabs, the single entry IS active when tab matches activeId.
  const activeKey = useMemo<string | null>(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (!active) return null;
    if (active.kind === "pane") return `leaf-${active.activeLeafId}`;
    return `tab-${active.id}`;
  }, [tabs, activeId]);

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active entry visible after activation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeKey) return;
    const target = el.querySelector<HTMLElement>(`[data-entry-key="${activeKey}"]`);
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, entries.length]);

  // Pointer-based DnD via dnd-kit. 5px activation distance prevents
  // accidental drags from interfering with click-to-select.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Sortable list is keyed by top-level tab id - we reorder tabs, not leaves.
  const sortableIds = useMemo(() => tabs.map((t) => t.id), [tabs]);

  const handleDragEnd = (ev: DragEndEvent) => {
    setActiveDragId(null);
    if (!onReorderTabs || !ev.over) return;
    const fromId = Number(ev.active.id);
    const overId = Number(ev.over.id);
    if (fromId === overId) return;
    const fromIdx = tabs.findIndex((t) => t.id === fromId);
    const overIdx = tabs.findIndex((t) => t.id === overId);
    if (fromIdx < 0 || overIdx < 0) return;
    // Drop AFTER when dragging forward, BEFORE when dragging backward -
    // matches what the user sees as siblings shift around the dragged tab.
    const beforeTabId =
      fromIdx < overIdx ? tabs[overIdx + 1]?.id ?? null : overId;
    onReorderTabs(fromId, beforeTabId);
  };

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      // Thin overlay scrollbar pinned to the bottom edge - visible on hover
      // when there are more tabs than fit. Using `overlay` (and the WebKit
      // height of 4px) means the scrollbar paints OVER the row instead of
      // reserving layout space, so the 28px tab strip stays vertically
      // centered against the 40px header buttons. Wheel-scroll still works
      // via the listener above.
      className="group/tabscroll flex h-full min-w-0 shrink items-center overflow-x-auto overflow-y-hidden [scrollbar-color:transparent_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--muted-foreground)_transparent] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/80"
    >
      <div data-tauri-drag-region className="flex w-max items-center gap-0.5">
        <Tabs
          value={activeKey ?? ""}
          onValueChange={(k) => {
            const entry = entries.find((e) => e.key === k);
            if (!entry) return;
            if (entry.kind === "pane-leaf") {
              onSelectEntry(entry.tabId, entry.leafId);
            } else {
              onSelectEntry(entry.tabId, null);
            }
          }}
        >
          <DndContext
            sensors={sensors}
            onDragStart={(ev) => setActiveDragId(Number(ev.active.id))}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
            <TabsList className="h-7 w-max gap-1 bg-transparent p-0">
              <SortableContext
                items={sortableIds}
                strategy={horizontalListSortingStrategy}
              >
                {entryGroups.map((group) => (
                  <SortableTabGroup
                    key={group.tabId}
                    tabId={group.tabId}
                    entries={group.entries}
                    totalEntries={entries.length}
                    compact={compact}
                    sortable={!!onReorderTabs}
                    groupDragging={activeDragId !== null}
                    isDragging={activeDragId === group.tabId}
                    onPinLeaf={onPinLeaf}
                    onCloseEntry={onCloseEntry}
                    sshHosts={sshHosts}
                    onMoveLeafToGroup={onMoveLeafToGroup}
                    onRotateLeafSplit={onRotateLeafSplit}
                    paneGroupsForMove={paneGroupsForMove}
                  />
                ))}
              </SortableContext>
            </TabsList>
            <DragOverlay
              dropAnimation={DROP_ANIMATION}
              modifiers={[snapCenterAndLockY]}
            >
              {draggedEntry && (
                <div
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md bg-accent/95 px-2 text-xs text-foreground shadow-lg ring-1 ring-primary/50 backdrop-blur-sm cursor-grabbing",
                    compact ? "max-w-48" : "max-w-80",
                  )}
                >
                  <EntryIcon entry={draggedEntry} />
                  <span
                    className={cn(
                      "truncate",
                      draggedEntry.italic && "italic",
                    )}
                  >
                    {draggedEntry.label}
                  </span>
                  {draggedEntry.dirty && (
                    <span className="size-1.5 shrink-0 rounded-full bg-yellow-500 dark:bg-yellow-400" />
                  )}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </Tabs>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="New"
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">New</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onNewTerminal()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">{fmtShortcut(MOD_KEY, "T")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Editor</span>
              <span className="text-xs text-muted-foreground">{fmtShortcut(MOD_KEY, "E")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Preview</span>
              <span className="text-xs text-muted-foreground">{fmtShortcut(MOD_KEY, "P")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

type PaneGroupForMove = {
  id: number;
  title: string;
  count: number;
  full: boolean;
};

type SortableTabGroupProps = {
  tabId: number;
  /**
   * Consecutive entries that all belong to the same top-level tab. A length
   * of >1 means the tab has split panes; we render those entries as a
   * bordered cluster so it's visible which entries belong to one split.
   */
  entries: Entry[];
  /** Total entries across all groups - drives "can close" gating. */
  totalEntries: number;
  compact?: boolean;
  sortable: boolean;
  /** True while ANY group is being dragged. */
  groupDragging: boolean;
  /** True when THIS group is the one being dragged. */
  isDragging: boolean;
  onPinLeaf: (tabId: number, leafId: number) => void;
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  /** Resolves a leaf's SSH connection id to its host metadata for tooltip. */
  sshHosts: Map<string, SshConnection>;
  /**
   * Move-to-group support. When `onMoveLeafToGroup` is provided AND there's
   * another pane tab to move into, each pane-leaf entry renders a small
   * layers icon next to its close X. `paneGroupsForMove` lists every pane
   * tab (including this one - the renderer filters out self).
   */
  onMoveLeafToGroup?: (leafId: number, targetTabId: number) => void;
  /** Flip the orientation of the split that directly contains the entry's
   *  leaf (row ↔ col). Shown only on entries inside a split group. */
  onRotateLeafSplit?: (leafId: number) => void;
  paneGroupsForMove: PaneGroupForMove[];
};

/**
 * A group renders all entries belonging to one top-level tab. Drag-handle
 * is on the group container so the entire split (and its leaf entries) move
 * together when reordered.
 */
function SortableTabGroup({
  tabId,
  entries,
  totalEntries,
  compact,
  sortable,
  groupDragging,
  isDragging: isThisDragging,
  onPinLeaf,
  onCloseEntry,
  sshHosts,
  onMoveLeafToGroup,
  onRotateLeafSplit,
  paneGroupsForMove,
}: SortableTabGroupProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: tabId,
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

  const isSplit = entries.length > 1;
  const canClose = totalEntries > 1;

  return (
    <div
      ref={setNodeRef}
      // dnd-kit drives transform/transition per-frame - must stay inline.
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      data-tab-id={tabId}
      data-tauri-drag-region="false"
      className={cn(
        "flex h-7 shrink-0 items-center transition-[border-color,background-color,opacity] duration-150",
        // Split tabs get a bordered cluster so the entries inside are
        // visibly one group. Single-pane tabs stay "naked" - no border.
        isSplit
          ? "rounded-md border border-border/70 bg-muted/20 gap-0 p-0 overflow-hidden"
          : "",
        isSplit && groupDragging && !isThisDragging && "border-border",
        isSplit && isThisDragging && "border-primary/70 bg-accent/30",
        sortable && "cursor-grab active:cursor-grabbing",
        isThisDragging &&
          "opacity-30",
      )}
    >
      {entries.map((e, idx) => {
        const sshHost =
          e.kind === "pane-leaf" && e.sshConnectionId
            ? sshHosts.get(e.sshConnectionId)
            : undefined;
        const trigger = (
          <TabsTrigger
            key={e.key}
            value={e.key}
            data-entry-key={e.key}
            data-tab-id={e.tabId}
            data-tauri-drag-region="false"
            onDoubleClick={() => {
              if (e.kind === "pane-leaf" && e.italic) {
                onPinLeaf(e.tabId, e.leafId);
              }
            }}
            // Drag listeners go on the group node only when this is the
            // **first** entry. Putting them on every leaf would still work
            // (they bubble), but binding once keeps event flow predictable
            // and prevents listeners from intercepting clicks on inner leaves.
            {...(idx === 0 ? attributes : {})}
            {...(idx === 0 ? listeners : {})}
            className={cn(
              // VSCode-style active state: tab adopts the editor background
              // (--background), turns semibold, and gets a 2.5px primary-colored
              // top border so the focused tab visually "lifts" out of the strip.
              // Inactive tabs sit on a dimmer --muted/30 surface (was /60) so
              // the active/inactive contrast is unmistakable at a glance.
              "group relative h-full shrink-0 gap-1.5 bg-muted/30 text-xs text-muted-foreground/80 transition-[background-color,color] duration-150 hover:bg-muted/60 hover:text-foreground/80 justify-between",
              "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:font-semibold",
              "data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:top-0 data-[state=active]:after:h-[2.5px] data-[state=active]:after:bg-primary data-[state=active]:after:content-['']",
              // Inside a split cluster, entries are flat (no rounded corners,
              // no own bg); outside, they keep the original pill look.
              isSplit ? "rounded-none" : "rounded-md",
              compact
                ? "px-2!"
                : totalEntries === 1
                  ? "px-2.5!"
                  : "ps-2.5! pe-1.5!",
              // Intra-group divider on every entry except the first.
              isSplit && idx > 0 &&
                "before:absolute before:left-0 before:top-1 before:bottom-1 before:w-px before:bg-border/70 before:content-[''] data-[state=active]:before:opacity-0",
            )}
          >
            <span
              className={cn(
                "flex items-center gap-1.5 truncate",
                compact ? "max-w-48" : "max-w-80",
              )}
            >
              <EntryIcon entry={e} />
              <span className={cn("truncate", e.italic && "italic")}>
                {e.label}
              </span>
              {e.dirty ? (
                <span
                  aria-label="Unsaved changes"
                  className="size-1.5 shrink-0 rounded-full bg-yellow-500 dark:bg-yellow-400"
                />
              ) : null}
            </span>
            {/* Trailing icons cluster: move-to-group, rotate-split, close.
                `ms-1.5` adds the little breathing room between the tab title
                and these controls so they don't visually crowd the label. */}
            <span className="ms-1.5 flex shrink-0 items-center gap-0.5">
              {e.kind === "pane-leaf" &&
                onMoveLeafToGroup &&
                paneGroupsForMove.some((g) => g.id !== e.tabId) && (
                  <MoveLeafToGroupButton
                    leafId={e.leafId}
                    ownerTabId={e.tabId}
                    groups={paneGroupsForMove}
                    onMove={onMoveLeafToGroup}
                  />
                )}
              {/* Rotate orientation is exposed on EVERY entry inside a
                  split group, but each click only flips the split that
                  THIS leaf directly sits in - sibling splits stay as they
                  were. Single-pane tabs hide the icon. */}
              {isSplit && onRotateLeafSplit && e.kind === "pane-leaf" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      aria-label="Toggle Split Orientation"
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onRotateLeafSplit(e.leafId);
                      }}
                      className="cursor-pointer rounded p-0.5 text-current opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                    >
                      <HugeiconsIcon
                        icon={Rotate01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Toggle Split Orientation
                  </TooltipContent>
                </Tooltip>
              )}
              {canClose && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      aria-label="Close"
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onCloseEntry(
                          e.tabId,
                          e.kind === "pane-leaf" ? e.leafId : null,
                        );
                      }}
                      className="cursor-pointer rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive hover:opacity-100 group-hover:opacity-60"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Close</TooltipContent>
                </Tooltip>
              )}
            </span>
          </TabsTrigger>
        );

        if (!sshHost) return trigger;
        const sshStatus =
          e.kind === "pane-leaf" ? e.sshStatus : undefined;
        return (
          <Tooltip key={e.key}>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="flex flex-col gap-0.5 text-[11px]">
                <span>
                  SSH · {sshHost.user}@{sshHost.host}:{sshHost.port}
                </span>
                {sshStatus ? (
                  <span className="text-muted-foreground">
                    {statusLabel(sshStatus)}
                  </span>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Small layers-icon button on each pane-leaf entry, sitting just to the
 * left of the close X. Clicking opens a dropdown of every other pane tab,
 * picking one moves THIS leaf into the chosen tab as a horizontal split.
 *
 * Tabs at the per-tab pane cap render disabled so the user sees why
 * they're unpickable (and the toast still fires through the parent's
 * `onMove` callback if a stale "ok" target turns into "full" between
 * render and click).
 */
function MoveLeafToGroupButton({
  leafId,
  ownerTabId,
  groups,
  onMove,
}: {
  leafId: number;
  ownerTabId: number;
  groups: PaneGroupForMove[];
  onMove: (leafId: number, targetTabId: number) => void;
}) {
  const others = groups.filter((g) => g.id !== ownerTabId);
  if (others.length === 0) return null;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label="Move To Group"
            // Stop propagation so the TabsTrigger and dnd-kit don't treat the
            // click as a tab activation / drag start, respectively. Mirrors
            // the close-X button's pattern just below.
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => ev.stopPropagation()}
            className="cursor-pointer rounded p-0.5 text-current opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60 data-[state=open]:bg-accent data-[state=open]:opacity-100"
          >
            <HugeiconsIcon icon={Layers01Icon} size={11} strokeWidth={2} />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Move To Group</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        {others.map((g) => (
          <DropdownMenuItem
            key={g.id}
            disabled={g.full}
            onSelect={() => onMove(leafId, g.id)}
          >
            <HugeiconsIcon icon={Layers01Icon} size={13} strokeWidth={1.75} />
            <span className="flex-1 truncate">{g.title}</span>
            <span className="text-xs text-muted-foreground">
              {g.full ? "Full" : `${g.count}/${MAX_PANES_PER_TAB}`}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "pane-leaf") {
    if (entry.leafKind === "editor") {
      const url = fileIconUrl(entry.label);
      return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
    }
    if (entry.sshConnectionId) {
      return (
        <span className="relative inline-flex shrink-0">
          <HugeiconsIcon
            icon={CloudServerIcon}
            size={14}
            strokeWidth={2}
            className="shrink-0 text-sky-600 dark:text-sky-400"
          />
          {entry.sshStatus ? (
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-background",
                statusDotClass(entry.sshStatus),
              )}
            />
          ) : null}
        </span>
      );
    }
    return (
      <HugeiconsIcon
        icon={ComputerTerminal02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (entry.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={GitCompareIcon}
      size={14}
      strokeWidth={2}
      className="shrink-0 text-yellow-600 dark:text-yellow-400"
    />
  );
}
