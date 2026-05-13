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
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "@/modules/ssh/connections";
import {
  Cancel01Icon,
  CloudServerIcon,
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

  const entries = useMemo(() => buildEntries(tabs, sshHosts), [tabs, sshHosts]);

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
      // Thin overlay scrollbar pinned to the bottom edge - visible on hover
      // when there are more tabs than fit. Using `overlay` (and the WebKit
      // height of 4px) means the scrollbar paints OVER the row instead of
      // reserving layout space, so the 28px tab strip stays vertically
      // centered against the 40px header buttons. Wheel-scroll still works
      // via the listener above.
      className="group/tabscroll flex h-full min-w-0 shrink items-center overflow-x-auto overflow-y-hidden [scrollbar-color:transparent_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--muted-foreground)_transparent] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/80"
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
                    sshHosts={sshHosts}
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
              // (--background) and gets a 2px primary-colored top border so the
              // focused tab visually "lifts" out of the strip. Inactive tabs sit
              // on the slightly darker --muted surface for clear contrast.
              "group relative h-full shrink-0 gap-1.5 bg-muted/60 text-xs text-muted-foreground transition-[background-color,color] duration-150 hover:bg-muted hover:text-foreground/80 justify-between",
              "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:font-medium",
              "data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:top-0 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-primary data-[state=active]:after:content-['']",
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
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive hover:opacity-100 group-hover:opacity-60"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </span>
            )}
          </TabsTrigger>
        );

        if (!sshHost) return trigger;
        return (
          <Tooltip key={e.key}>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="bottom" className="font-mono text-[10.5px]">
              SSH · {sshHost.user}@{sshHost.host}:{sshHost.port}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
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
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={14}
          strokeWidth={2}
          className="shrink-0 text-sky-600 dark:text-sky-400"
        />
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
