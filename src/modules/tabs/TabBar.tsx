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
import { leaves, type PaneLeaf } from "@/modules/terminal/lib/panes";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
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
 * The tab strip lists entries — one per **pane** for pane tabs (so each
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
};

type StandaloneEntry = EntryBase & {
  kind: "preview" | "ai-diff";
};

type Entry = PaneEntry | StandaloneEntry;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function entryLabel(leaf: PaneLeaf, fallbackCwd: string | undefined): string {
  if (leaf.leafKind === "editor") return basename(leaf.path);
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

function buildEntries(tabs: Tab[]): Entry[] {
  const out: Entry[] = [];
  for (const t of tabs) {
    if (t.kind === "pane") {
      for (const leaf of leaves(t.paneTree)) {
        const label = entryLabel(leaf, t.cwd);
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
    // ai-diff
    out.push({
      kind: "ai-diff",
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
   * entries — caller should just activate the tab.
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
   * individual pane leaves yet — only top-level tabs swap positions.
   * `beforeTabId` of null means drop at end.
   */
  onReorderTabs?: (fromTabId: number, beforeTabId: number | null) => void;
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
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeDragId, setActiveDragId] = useState<number | null>(null);

  const entries = useMemo(() => buildEntries(tabs), [tabs]);

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

  // Sortable list is keyed by top-level tab id — we reorder tabs, not leaves.
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
    // Drop AFTER when dragging forward, BEFORE when dragging backward —
    // matches what the user sees as siblings shift around the dragged tab.
    const beforeTabId =
      fromIdx < overIdx ? tabs[overIdx + 1]?.id ?? null : overId;
    onReorderTabs(fromId, beforeTabId);
  };

  return (
    <div
      ref={scrollRef}
      className="min-w-0 shrink overflow-x-auto overflow-y-hidden pb-1 [scrollbar-color:var(--muted-foreground)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:block [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/70 [&::-webkit-scrollbar-track]:bg-transparent"
    >
      <div className="flex w-max items-center gap-0.5">
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
                  />
                ))}
              </SortableContext>
            </TabsList>
            <DragOverlay dropAnimation={DROP_ANIMATION}>
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

type SortableTabGroupProps = {
  tabId: number;
  /**
   * Consecutive entries that all belong to the same top-level tab. A length
   * of >1 means the tab has split panes; we render those entries as a
   * bordered cluster so it's visible which entries belong to one split.
   */
  entries: Entry[];
  /** Total entries across all groups — drives "can close" gating. */
  totalEntries: number;
  compact?: boolean;
  sortable: boolean;
  /** True while ANY group is being dragged. */
  groupDragging: boolean;
  /** True when THIS group is the one being dragged. */
  isDragging: boolean;
  onPinLeaf: (tabId: number, leafId: number) => void;
  onCloseEntry: (tabId: number, leafId: number | null) => void;
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
      // dnd-kit drives transform/transition per-frame — must stay inline.
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      data-tab-id={tabId}
      data-tauri-drag-region="false"
      className={cn(
        "flex h-7 shrink-0 items-center transition-[border-color,background-color,opacity] duration-150",
        // Split tabs get a bordered cluster so the entries inside are
        // visibly one group. Single-pane tabs stay "naked" — no border.
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
      {entries.map((e, idx) => (
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
            "group relative h-full shrink-0 gap-1.5 text-xs text-muted-foreground transition-[background-color,color] duration-150 data-[state=active]:bg-accent data-[state=active]:text-foreground hover:bg-muted/40 hover:text-foreground/80 justify-between",
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
          {canClose && (
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
              className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </span>
          )}
        </TabsTrigger>
      ))}
    </div>
  );
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "pane-leaf") {
    if (entry.leafKind === "editor") {
      const url = fileIconUrl(entry.label);
      return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
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
