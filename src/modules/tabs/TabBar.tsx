import { Tabs, TabsList } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DragChip } from "@/components/DragChip";
import { leafIds } from "@/modules/terminal/lib/panes";
import { MAX_PANES_PER_TAB } from "./lib/useTabs";
import {
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "@/modules/ssh/connections";
import { type SshStatus } from "@/modules/ssh/status";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { useIconsReady } from "@/lib/iconRegistry";
import { useExplorerIconsReady } from "@/modules/explorer/lib/iconResolver";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DropAnimation,
  type Modifier,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "./lib/useTabs";
import { type Entry, type PaneEntry, buildEntries } from "./lib/entries";
import { EntryIcon } from "./components/EntryIcon";
import { NewTabMenu } from "./components/NewTabMenu";
import { SortableTabGroup } from "./components/SortableTabGroup";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Activate a pane entry. `leafId` is null for standalone tabs. */
  onSelectEntry: (tabId: number, leafId: number | null) => void;
  /** Close a pane leaf or standalone tab. `leafId` is null for standalone. */
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  onNewTerminal: () => void;
  /** Open a new local terminal tab pre-flagged as private. */
  onNewPrivateTerminal?: () => void;
  onNewPreview: () => void;
  /** `+` -> Agent...: open the agent picker dialog. */
  onOpenAgents: () => void;
  /** Flip the `private` flag on a single leaf (per-tab in the strip, not the whole split group). */
  onTogglePrivate?: (leafId: number) => void;
  /** Set a leaf's tab name, or `null` to fall back to the derived one (folder
   *  basename, file name, page title). Backs the right-click Rename. */
  onRenameLeaf?: (leafId: number, title: string | null) => void;
  /** Pin a preview-editor leaf on double-click. */
  onPinLeaf: (tabId: number, leafId: number) => void;
  /** Reorder tabs. `beforeTabId` null appends. */
  onReorderTabs?: (fromTabId: number, beforeTabId: number | null) => void;
  /** Reorder a leaf within its split group. `beforeLeafId` null appends. Cross-group drops are ignored; use `onMoveLeafToGroup`. */
  onReorderLeafInGroup?: (leafId: number, beforeLeafId: number | null) => void;
  /** Move a leaf into `targetTabId` as a split. Caller enforces `MAX_PANES_PER_TAB` and toasts on full/invalid. */
  onMoveLeafToGroup?: (leafId: number, targetTabId: number) => void;
  /** Extract a leaf into a new top-level pane tab. Returns `"invalid"` for single-leaf tabs. */
  onMoveLeafToNewTab?: (leafId: number) => "ok" | "invalid";
  /** Flip the orientation of the split containing `leafId`. Rendered only on entries inside a split. */
  onRotateLeafSplit?: (leafId: number) => void;
  /** Split the active pane. Wired into the `+` dropdown next to New Terminal. */
  onSplit?: (dir: "row" | "col") => void;
  /** Disable the split-pane items when the active tab is at its split cap. */
  canSplit?: boolean;
  /** Map of leafId to SSH session status. Drives the colored dot and tooltip. */
  sshStatuses?: Map<number, SshStatus>;
  /** Map of leafId to AI CLI status. Drives the icon dot and tooltip. */
  aiCliStatuses?: Map<number, AiCliStatus>;
  compact?: boolean;
};

/** Drop animation. 180ms ease-out-quint lands the tab quickly without losing the rest feel. */
const DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

/**
 * Scope collision detection by kind. Tab drags only see tabs; leaf drags only
 * see leaves. Without this filter, dragging a tab past the last entry can
 * flicker onto a leaf in another group's split.
 */
function makeScopedCollisionDetection(): CollisionDetection {
  return (args) => {
    const activeId = String(args.active.id);
    const prefix = activeId.startsWith("tab:")
      ? "tab:"
      : activeId.startsWith("leaf:")
        ? "leaf:"
        : "";
    if (!prefix) return closestCenter(args);
    const filtered = args.droppableContainers.filter((d) => String(d.id).startsWith(prefix));
    return closestCenter({ ...args, droppableContainers: filtered });
  };
}

/** Pin the DragOverlay to the horizontal center of the tab and lock y to the tab strip. */
const snapCenterAndLockY: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const ev = activatorEvent as PointerEvent;
  const offsetX = ev.clientX - draggingNodeRect.left;
  return {
    ...transform,
    x: transform.x + offsetX - draggingNodeRect.width / 2,
    // y: 0 glues the overlay to the original row.
    y: 0,
  };
};

export function TabBar({
  tabs,
  activeId,
  onSelectEntry,
  onCloseEntry,
  onNewTerminal,
  onNewPrivateTerminal,
  onNewPreview,
  onOpenAgents,
  onTogglePrivate,
  onRenameLeaf,
  onPinLeaf,
  onReorderTabs,
  onReorderLeafInGroup,
  onMoveLeafToGroup,
  onMoveLeafToNewTab,
  onRotateLeafSplit,
  onSplit,
  canSplit = false,
  sshStatuses,
  aiCliStatuses,
  compact,
}: Props) {
  // Which leaf's tab label is currently an edit field. Lives here rather than in
  // the entry renderer, which is a plain function with nowhere to keep state.
  // Leaf ids are never reused, so a stale id after a close simply matches nothing.
  const [renamingLeafId, setRenamingLeafId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Re-render once the lazy icon chunk and catppuccin file-icon set finish
  // loading so extension tab icons + editor-tab file icons swap from the
  // fallback glyph to the real one. Both hooks return true immediately when
  // already cached and flip on load completion.
  useIconsReady();
  useExplorerIconsReady();
  // dnd-kit drag id. `tab:<n>` for whole-group, `leaf:<n>` for in-group reorder. Prefix routes `handleDragEnd`.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Load SSH hosts on mount and on change so leaf `sshConnectionId` resolves for the tooltip.
  const [sshHosts, setSshHosts] = useState<Map<string, SshConnection>>(() => new Map());
  useEffect(() => {
    const load = () =>
      void listConnections().then((list) => setSshHosts(new Map(list.map((c) => [c.id, c]))));
    load();
    const unsub = onConnectionsChanged(load);
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);

  const entries = useMemo(
    () => buildEntries(tabs, sshHosts, sshStatuses, aiCliStatuses),
    [tabs, sshHosts, sshStatuses, aiCliStatuses],
  );

  /** Snapshot of pane tabs for the Move to Group menu. Full tabs are listed but disabled so the menu stays stable. */
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

  // Group entries by owning tab. Split tabs contribute multiple consecutive entries.
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

  const draggedEntry = useMemo<Entry | null>(() => {
    if (activeDragId === null) return null;
    if (activeDragId.startsWith("tab:")) {
      const tabId = Number(activeDragId.slice(4));
      return entries.find((e) => e.tabId === tabId) ?? null;
    }
    if (activeDragId.startsWith("leaf:")) {
      const leafId = Number(activeDragId.slice(5));
      return (
        entries.find((e): e is PaneEntry => e.kind === "pane-leaf" && e.leafId === leafId) ?? null
      );
    }
    return null;
  }, [entries, activeDragId]);

  // The last entry has no "close to the right" target, so the menu item is hidden.
  const lastEntryKey = entries.length > 0 ? entries[entries.length - 1].key : null;

  // Close every entry to the right of `entry`. Routes through `onCloseEntry` so dirty-editor confirms still fire.
  const closeEntriesAfter = (entry: Entry) => {
    const idx = entries.findIndex((e) => e.key === entry.key);
    if (idx < 0) return;
    for (let i = idx + 1; i < entries.length; i++) {
      const target = entries[i];
      onCloseEntry(target.tabId, target.kind === "pane-leaf" ? target.leafId : null);
    }
  };

  // Active entry: pane tab follows `activeLeafId`; standalone tab is active when its id matches.
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

  // Track scroll position so the nav arrows enable, disable, or hide.
  const [overflow, setOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const ovr = el.scrollWidth > el.clientWidth + 1;
      setOverflow(ovr);
      setCanScrollLeft(ovr && el.scrollLeft > 0);
      // 1px tolerance prevents flicker at max scroll.
      setCanScrollRight(ovr && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Watch the inner content too. Tab add/remove/relabel changes scrollWidth without firing on the container.
    const content = el.firstElementChild as HTMLElement | null;
    if (content) ro.observe(content);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [entries.length]);

  const scrollByDelta = (dx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dx, behavior: "smooth" });
  };

  // Pointer DnD via dnd-kit. 5px activation distance prevents click-to-select drags.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Memoize so DndContext keeps a stable reference.
  const collisionDetection = useMemo(() => makeScopedCollisionDetection(), []);

  // Outer SortableContext: one item per top-level tab. String ids coexist with inner `leaf:<n>` ids.
  const sortableIds = useMemo(() => tabs.map((t) => `tab:${t.id}`), [tabs]);

  const handleDragEnd = (ev: DragEndEvent) => {
    setActiveDragId(null);
    if (!ev.over) return;
    const activeId = String(ev.active.id);
    const overId = String(ev.over.id);
    if (activeId === overId) return;

    if (activeId.startsWith("leaf:") && overId.startsWith("leaf:")) {
      if (!onReorderLeafInGroup) return;
      const fromLeaf = Number(activeId.slice(5));
      const overLeaf = Number(overId.slice(5));
      // Restrict to siblings of the same tab. The inner SortableContext usually prevents this, but check anyway.
      const fromTabId = entries.find(
        (e): e is PaneEntry => e.kind === "pane-leaf" && e.leafId === fromLeaf,
      )?.tabId;
      const overTabId = entries.find(
        (e): e is PaneEntry => e.kind === "pane-leaf" && e.leafId === overLeaf,
      )?.tabId;
      if (fromTabId === undefined || fromTabId !== overTabId) return;
      const groupLeaves = entries.filter(
        (e): e is PaneEntry => e.kind === "pane-leaf" && e.tabId === fromTabId,
      );
      const fromIdx = groupLeaves.findIndex((e) => e.leafId === fromLeaf);
      const overIdx = groupLeaves.findIndex((e) => e.leafId === overLeaf);
      if (fromIdx < 0 || overIdx < 0) return;
      // Dragging forward lands after the target; backward lands before.
      const beforeLeafId =
        fromIdx < overIdx ? (groupLeaves[overIdx + 1]?.leafId ?? null) : overLeaf;
      onReorderLeafInGroup(fromLeaf, beforeLeafId);
      return;
    }

    if (activeId.startsWith("tab:") && overId.startsWith("tab:")) {
      if (!onReorderTabs) return;
      const fromId = Number(activeId.slice(4));
      const overTab = Number(overId.slice(4));
      const fromIdx = tabs.findIndex((t) => t.id === fromId);
      const overIdx = tabs.findIndex((t) => t.id === overTab);
      if (fromIdx < 0 || overIdx < 0) return;
      // Drop after when dragging forward, before when dragging backward.
      const beforeTabId = fromIdx < overIdx ? (tabs[overIdx + 1]?.id ?? null) : overTab;
      onReorderTabs(fromId, beforeTabId);
    }
  };

  return (
    <div data-tauri-drag-region="false" className="flex h-full min-w-0 shrink items-center">
      {/* Scroll arrows. Shown only when the strip overflows. */}
      {overflow && (
        <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-0.5 pr-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Scroll tabs left"
                onClick={() => scrollByDelta(-200)}
                disabled={!canScrollLeft}
                // h-7 (28px) to match the tab triggers.
                className="border-border/70 bg-muted/30 text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80 disabled:hover:bg-muted/30 disabled:hover:text-muted-foreground/80 flex size-7 shrink-0 items-center justify-center rounded-md border transition-[background-color,color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={14} strokeWidth={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Scroll tabs left</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Scroll tabs right"
                onClick={() => scrollByDelta(200)}
                disabled={!canScrollRight}
                className="border-border/70 bg-muted/30 text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80 disabled:hover:bg-muted/30 disabled:hover:text-muted-foreground/80 flex size-7 shrink-0 items-center justify-center rounded-md border transition-[background-color,color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight size={14} strokeWidth={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Scroll tabs right</TooltipContent>
          </Tooltip>
        </div>
      )}

      <div
        ref={scrollRef}
        // Opt out of the Tauri drag region. Otherwise mousedown on empty strip pixels would drag the window.
        data-tauri-drag-region="false"
        // `.no-scrollbar` hides the scrollbar; arrows and wheel scroll handle nav.
        // `overflow-x-auto` stays so `scrollIntoView` keeps working.
        className="no-scrollbar flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden"
      >
        <div data-tauri-drag-region="false" className="flex w-max items-center gap-0.5">
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
              // Scoped `closestCenter`. See `makeScopedCollisionDetection`.
              collisionDetection={collisionDetection}
              onDragStart={(ev) => setActiveDragId(String(ev.active.id))}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveDragId(null)}
            >
              <TabsList className="h-7 w-max gap-1 bg-transparent p-0">
                <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
                  {entryGroups.map((group) => (
                    <SortableTabGroup
                      key={group.tabId}
                      tabId={group.tabId}
                      entries={group.entries}
                      totalEntries={entries.length}
                      activeKey={activeKey}
                      lastEntryKey={lastEntryKey}
                      compact={compact}
                      sortable={!!onReorderTabs}
                      leafSortable={!!onReorderLeafInGroup}
                      groupDragging={activeDragId !== null}
                      isDragging={activeDragId === `tab:${group.tabId}`}
                      onPinLeaf={onPinLeaf}
                      onCloseEntry={onCloseEntry}
                      onCloseEntriesAfter={closeEntriesAfter}
                      sshHosts={sshHosts}
                      onMoveLeafToGroup={onMoveLeafToGroup}
                      onMoveLeafToNewTab={onMoveLeafToNewTab}
                      onRotateLeafSplit={onRotateLeafSplit}
                      onTogglePrivate={onTogglePrivate}
                      renamingLeafId={renamingLeafId}
                      onSetRenaming={setRenamingLeafId}
                      onRename={onRenameLeaf}
                      paneGroupsForMove={paneGroupsForMove}
                    />
                  ))}
                </SortableContext>
              </TabsList>
              <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[snapCenterAndLockY]}>
                {draggedEntry && (
                  <DragChip
                    icon={<EntryIcon entry={draggedEntry} />}
                    label={draggedEntry.label}
                    className={compact ? "max-w-32" : "max-w-44"}
                    italic={draggedEntry.italic}
                    isPrivate={draggedEntry.kind === "pane-leaf" && draggedEntry.isPrivate === true}
                    dirty={draggedEntry.dirty}
                  />
                )}
              </DragOverlay>
            </DndContext>
          </Tabs>
          <NewTabMenu
            onNewTerminal={onNewTerminal}
            onNewPrivateTerminal={onNewPrivateTerminal}
            onNewPreview={onNewPreview}
            onOpenAgents={onOpenAgents}
            onSplit={onSplit}
            canSplit={canSplit}
          />
        </div>
      </div>
    </div>
  );
}
