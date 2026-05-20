import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { statusDotClass, statusLabel, type SshStatus } from "@/modules/ssh/status";
import {
  aiCliLabel,
  aiCliStateChipClass,
  aiCliStateWord,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import {
  Cancel01Icon,
  CloudServerIcon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
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
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  /**
   * 1-based number stamped on every terminal leaf in current tab order.
   * Surfaces as a small badge in the TabBar AND is the same identifier the
   * AI sees via `<env>`. So "terminal 3" in the user's prompt matches the
   * badge directly.
   */
  terminalOrdinal?: number;
  /** Set on terminal leaves bound to a saved SSH host. */
  sshConnectionId?: string;
  /** Latest known status for SSH leaves, drives the colored dot. */
  sshStatus?: SshStatus;
  /**
   * Latest known AI CLI status for local terminal leaves. When the user
   * runs `claude`, `codex`, `opencode`, etc., the detector in
   * `useTerminalSession` populates this; null when no AI CLI is active.
   */
  aiCliStatus?: AiCliStatus;
};

type StandaloneEntry = EntryBase & {
  kind: "preview" | "ai-diff" | "git-diff";
};

type Entry = PaneEntry | StandaloneEntry;

/**
 * Per-type background colour for the accent stripe on the left edge of the
 * active tab. Each tab kind gets its own colour so users can tell at a
 * glance what kind of thing is focused - emerald for a local shell, sky
 * for SSH, brand-blue for a file editor, cyan for an in-app browser
 * preview, violet for an AI diff, amber for a git diff.
 *
 * The stripe is rendered as a real `<span>` child of the tab trigger (see
 * the JSX below) - *not* via `::after` - because the underlying primitive
 * `TabsTrigger` already wires up its own `::after` for a different purpose
 * with `group-data-horizontal/tabs:` variants that have equal CSS
 * specificity to ours. That collision made the stripe blink in/out
 * depending on tab count / split layout (the only thing that shifted CSS
 * source order). A separate element sidesteps the fight entirely.
 *
 * Keep the strings as full literals so Tailwind's JIT can see them.
 */
function tabAccentClass(e: Entry): string {
  if (e.kind === "pane-leaf") {
    if (e.leafKind === "terminal") {
      return e.sshConnectionId
        ? "bg-sky-500 dark:bg-sky-400"
        : "bg-emerald-500 dark:bg-emerald-400";
    }
    return "bg-[#0057fe] dark:bg-[#0057fe]";
  }
  if (e.kind === "preview") return "bg-cyan-500 dark:bg-cyan-400";
  if (e.kind === "ai-diff") return "bg-violet-500 dark:bg-violet-400";
  return "bg-amber-500 dark:bg-amber-400";
}

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
  aiCliStatuses?: Map<number, AiCliStatus>,
): Entry[] {
  const out: Entry[] = [];
  // Running 1-based ordinal across all terminal leaves in current tab order.
  // The same numbering is exposed to the AI via `<env>` so a badge "3" on a
  // tab matches what the user can write ("terminal 3") and what the AI sees.
  let terminalOrdinal = 0;
  for (const t of tabs) {
    if (t.kind === "pane") {
      for (const leaf of leaves(t.paneTree)) {
        const label = entryLabel(leaf, t.cwd, sshHosts);
        const sshConnectionId = leaf.leafKind === "terminal" ? leaf.sshConnectionId : undefined;
        const ord = leaf.leafKind === "terminal" ? ++terminalOrdinal : undefined;
        out.push({
          kind: "pane-leaf",
          key: `leaf-${leaf.id}`,
          tabId: t.id,
          leafId: leaf.id,
          leafKind: leaf.leafKind,
          label,
          terminalOrdinal: ord,
          italic:
            leaf.leafKind === "editor" &&
            (leaf as PaneLeaf & { preview?: boolean }).preview === true,
          dirty:
            leaf.leafKind === "editor" && (leaf as PaneLeaf & { dirty?: boolean }).dirty === true,
          sshConnectionId,
          sshStatus: sshConnectionId ? sshStatuses?.get(leaf.id) : undefined,
          aiCliStatus:
            leaf.leafKind === "terminal" && !sshConnectionId
              ? aiCliStatuses?.get(leaf.id)
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
  /**
   * Optional map keyed by leafId carrying the latest AI CLI status (claude,
   * codex, opencode, copilot, pi). Drives the dot overlay on the terminal
   * icon + the tooltip line on the tab.
   */
  aiCliStatuses?: Map<number, AiCliStatus>;
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
const snapCenterAndLockY: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
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
  aiCliStatuses,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeDragId, setActiveDragId] = useState<number | null>(null);
  // Load saved SSH hosts once + on change, so we can resolve a leaf's
  // `sshConnectionId` to its `user@host:port` for the tab tooltip.
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
    () => (activeDragId === null ? null : (entries.find((e) => e.tabId === activeDragId) ?? null)),
    [entries, activeDragId],
  );

  // The very last entry in the strip is the one nothing can be "closed to
  // the right of" - used to hide the menu item rather than show a no-op.
  const lastEntryKey = entries.length > 0 ? entries[entries.length - 1].key : null;

  // Close every entry visually to the right of `entry` in the strip. Each
  // call routes through the same `onCloseEntry` the X button uses, so the
  // dirty-editor confirmation flow still fires when applicable.
  const closeEntriesAfter = (entry: Entry) => {
    const idx = entries.findIndex((e) => e.key === entry.key);
    if (idx < 0) return;
    for (let i = idx + 1; i < entries.length; i++) {
      const target = entries[i];
      onCloseEntry(target.tabId, target.kind === "pane-leaf" ? target.leafId : null);
    }
  };

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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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
    const beforeTabId = fromIdx < overIdx ? (tabs[overIdx + 1]?.id ?? null) : overId;
    onReorderTabs(fromId, beforeTabId);
  };

  return (
    <div
      ref={scrollRef}
      // Opt out of the Tauri drag region. Without this, mousedown on the
      // native scrollbar (or on any empty pixel inside the strip) bubbles
      // up to the header's drag handler and starts dragging the window
      // when the user just wanted to grab the thumb.
      data-tauri-drag-region="false"
      // Inherits the unified 10px boxy scrollbar from globals.css so the
      // bar at the bottom matches every other scrollable surface in the
      // app. The `pt-2.5` (10px) offsets the tab content downward by
      // exactly the height the scrollbar reserves at the bottom, so the
      // 28px tab triggers stay vertically centred against the icon buttons
      // on either side of the 48px header. Wheel-scroll still works via
      // the listener above. We intentionally do NOT set `scrollbar-width`
      // or `scrollbar-color` - doing so would flip Chromium to the modern
      // CSS scrollbar UI and bypass the global webkit rules.
      className="flex h-full min-w-0 shrink items-center overflow-x-auto overflow-y-hidden pt-2.5"
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
            onDragStart={(ev) => setActiveDragId(Number(ev.active.id))}
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
                    groupDragging={activeDragId !== null}
                    isDragging={activeDragId === group.tabId}
                    onPinLeaf={onPinLeaf}
                    onCloseEntry={onCloseEntry}
                    onCloseEntriesAfter={closeEntriesAfter}
                    sshHosts={sshHosts}
                    onMoveLeafToGroup={onMoveLeafToGroup}
                    onRotateLeafSplit={onRotateLeafSplit}
                    paneGroupsForMove={paneGroupsForMove}
                  />
                ))}
              </SortableContext>
            </TabsList>
            <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[snapCenterAndLockY]}>
              {draggedEntry && (
                <div
                  className={cn(
                    "bg-accent/95 text-foreground ring-primary/50 flex h-7 cursor-grabbing items-center gap-1.5 rounded-md px-2 text-xs shadow-lg ring-1 backdrop-blur-sm",
                    compact ? "max-w-48" : "max-w-80",
                  )}
                >
                  <EntryIcon entry={draggedEntry} />
                  {draggedEntry.kind === "pane-leaf" && draggedEntry.terminalOrdinal ? (
                    <TerminalOrdinalBadge ordinal={draggedEntry.terminalOrdinal} />
                  ) : null}
                  <span className={cn("truncate", draggedEntry.italic && "italic")}>
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
                  className="text-muted-foreground hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md"
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
              <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Terminal</span>
              <span className="text-muted-foreground text-xs">{fmtShortcut(MOD_KEY, "T")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Editor</span>
              <span className="text-muted-foreground text-xs">{fmtShortcut(MOD_KEY, "E")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Preview</span>
              <span className="text-muted-foreground text-xs">{fmtShortcut(MOD_KEY, "P")}</span>
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
  /**
   * The currently active entry's composite key. Used to render the per-
   * type coloured accent stripe - we compare entry.key against this rather
   * than relying on `data-state="active"` from Radix, because Tailwind
   * variant collisions with the primitive `TabsTrigger`'s built-in
   * `::after` rules made CSS-only detection flaky in multi-tab layouts.
   */
  activeKey: string | null;
  /**
   * Key of the visually last entry in the strip. Drives the right-click
   * "Close tabs to the right" item - when an entry IS the last one, the
   * item is hidden because there's nothing to its right to close.
   */
  lastEntryKey: string | null;
  compact?: boolean;
  sortable: boolean;
  /** True while ANY group is being dragged. */
  groupDragging: boolean;
  /** True when THIS group is the one being dragged. */
  isDragging: boolean;
  onPinLeaf: (tabId: number, leafId: number) => void;
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  /**
   * Close every entry to the right of `entry` in the strip. Implemented in
   * TabBar so it sees the full flattened entries list across all groups.
   */
  onCloseEntriesAfter: (entry: Entry) => void;
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
  activeKey,
  lastEntryKey,
  compact,
  sortable,
  groupDragging,
  isDragging: isThisDragging,
  onPinLeaf,
  onCloseEntry,
  onCloseEntriesAfter,
  sshHosts,
  onMoveLeafToGroup,
  onRotateLeafSplit,
  paneGroupsForMove,
}: SortableTabGroupProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
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
        isSplit ? "border-border/70 bg-muted/20 gap-0 overflow-hidden rounded-md border p-0" : "",
        isSplit && groupDragging && !isThisDragging && "border-border",
        isSplit && isThisDragging && "border-primary/70 bg-accent/30",
        sortable && "cursor-grab active:cursor-grabbing",
        isThisDragging && "opacity-30",
      )}
    >
      {entries.map((e, idx) => {
        const sshHost =
          e.kind === "pane-leaf" && e.sshConnectionId ? sshHosts.get(e.sshConnectionId) : undefined;
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
              // Active state: tab adopts the brand-tinted --accent surface
              // (light blue in light mode, deep blue in dark mode) so the
              // per-kind stripe on the left can carry the categorical hue
              // without colliding with the background. `h-full!` overrides
              // the primitive's `h-[calc(100%-1px)]` so trigger height is
              // an even integer (28 or 26px) - keeps the stripe's centered
              // position pixel-perfect across split/non-split contexts.
              "group bg-muted/30 text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80 relative h-full! shrink-0 justify-between gap-1.5 text-xs transition-[background-color,color] duration-150",
              "data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:font-semibold",
              // Inside a split cluster, entries are flat (no rounded corners,
              // no own bg); outside, they keep the original pill look.
              isSplit ? "rounded-none" : "rounded-md",
              compact ? "px-2!" : totalEntries === 1 ? "px-2.5!" : "ps-2.5! pe-1.5!",
              // Intra-group divider on every entry except the first.
              isSplit &&
                idx > 0 &&
                "before:bg-border/70 before:absolute before:top-1 before:bottom-1 before:left-0 before:w-px before:content-[''] data-[state=active]:before:opacity-0",
            )}
          >
            {/* 2.5px accent stripe on the left edge - only painted on the
                active entry. We compute activeness in JS (e.key === activeKey)
                instead of relying on a CSS group variant: the primitive
                `TabsTrigger` already attaches its own `::after` with
                `group-data-horizontal/tabs:` variants that share specificity
                with anything we'd write, and tailwind-merge can reorder our
                rule below theirs depending on what other classes are present
                (which is why a 2nd tab silently broke the stripe). Doing the
                conditional in JS is bulletproof - no class wins/loses based
                on Tailwind's emitted CSS order. */}
            {e.key === activeKey && (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute top-1/2 left-1 h-4 w-[3px] -translate-y-1/2",
                  tabAccentClass(e),
                )}
              />
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 truncate",
                compact ? "max-w-48" : "max-w-80",
              )}
            >
              <EntryIcon entry={e} />
              {e.kind === "pane-leaf" && e.terminalOrdinal ? (
                <TerminalOrdinalBadge ordinal={e.terminalOrdinal} />
              ) : null}
              <span className={cn("truncate", e.italic && "italic")}>{e.label}</span>
              {e.kind === "pane-leaf" && e.aiCliStatus ? (
                <AiCliChip status={e.aiCliStatus} />
              ) : null}
              {e.dirty ? (
                <span
                  aria-label="Unsaved changes"
                  className="size-1.5 shrink-0 rounded-full bg-yellow-500 dark:bg-yellow-400"
                />
              ) : null}
            </span>
            {/* Trailing icon: close. Rotate-split and move-to-group used to
                live here as inline buttons; both now live in the right-click
                context menu (built below) so the strip stays uncluttered. */}
            <span className="ms-1.5 flex shrink-0 items-center gap-0.5">
              {canClose && (
                <TrailingIconButton
                  icon={Cancel01Icon}
                  label="Close"
                  variant="danger"
                  onClick={() => onCloseEntry(e.tabId, e.kind === "pane-leaf" ? e.leafId : null)}
                />
              )}
            </span>
          </TabsTrigger>
        );

        // Right-click actions: rotate the split this leaf sits in, move the
        // leaf into another pane group, and close every entry to the right.
        // Rotate/move are pane-leaf only; close-tabs-to-right works for any
        // entry as long as something is actually to its right.
        const isPaneLeaf = e.kind === "pane-leaf";
        const moveTargets =
          isPaneLeaf && onMoveLeafToGroup ? paneGroupsForMove.filter((g) => g.id !== e.tabId) : [];
        const canRotate = isPaneLeaf && isSplit && !!onRotateLeafSplit;
        const canMove = moveTargets.length > 0;
        const canCloseToRight = lastEntryKey !== null && e.key !== lastEntryKey;

        // Compose: tooltip wrap (SSH-only) → context-menu wrap (when actions
        // exist). Order matters: ContextMenuTrigger must be the outermost
        // wrapper so right-click on the tab still fires.
        let node: ReactNode = trigger;
        if (sshHost) {
          const sshStatus = isPaneLeaf ? e.sshStatus : undefined;
          node = (
            <Tooltip>
              <TooltipTrigger asChild>{node}</TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="flex flex-col gap-0.5 text-[11px]">
                  <span>
                    SSH · {sshHost.user}@{sshHost.host}:{sshHost.port}
                  </span>
                  {sshStatus ? (
                    <span className="text-muted-foreground">{statusLabel(sshStatus)}</span>
                  ) : null}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        } else if (isPaneLeaf && e.aiCliStatus) {
          // Local terminal with a running AI CLI - show tool + state in tooltip.
          const ai = e.aiCliStatus;
          node = (
            <Tooltip>
              <TooltipTrigger asChild>{node}</TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="text-[11px]">{aiCliLabel(ai)}</div>
              </TooltipContent>
            </Tooltip>
          );
        }
        if (!canRotate && !canMove && !canCloseToRight) {
          return <Fragment key={e.key}>{node}</Fragment>;
        }
        const hasLeafActions = canRotate || canMove;
        return (
          <ContextMenu key={e.key}>
            <ContextMenuTrigger asChild>{node}</ContextMenuTrigger>
            <ContextMenuContent className="min-w-44">
              {canRotate && (
                <ContextMenuItem onSelect={() => onRotateLeafSplit!(e.leafId)}>
                  Toggle Split Orientation
                </ContextMenuItem>
              )}
              {canMove && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>Move to Group</ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {moveTargets.map((g) => (
                      <ContextMenuItem
                        key={g.id}
                        disabled={g.full}
                        onSelect={() => {
                          if (e.kind === "pane-leaf") onMoveLeafToGroup!(e.leafId, g.id);
                        }}
                      >
                        <span className="flex-1 truncate">{g.title}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {g.full ? "Full" : `${g.count}/${MAX_PANES_PER_TAB}`}
                        </span>
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              {canCloseToRight && hasLeafActions && <ContextMenuSeparator />}
              {canCloseToRight && (
                <ContextMenuItem onSelect={() => onCloseEntriesAfter(e)}>
                  Close Tabs to the Right
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}

/**
 * Shared styling for the small icon button(s) on the trailing edge of each
 * tab entry. Only "close" lives here now - rotate-split and move-to-group
 * moved into the right-click context menu (see `SortableTabGroup`).
 * Keeping the container square at a fixed size makes the hover background
 * a tidy 1:1 pill. `TRAILING_ICON_SIZE` is tuned for ~2-3px padding.
 */
const TRAILING_BTN_BASE =
  "inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-60";

const TRAILING_BTN_VARIANT = {
  default: "text-current hover:bg-accent hover:opacity-100",
  danger: "hover:bg-destructive/10 hover:text-destructive hover:opacity-100",
} as const;

const TRAILING_ICON_SIZE = 9;

function TrailingIconButton({
  icon,
  label,
  onClick,
  variant = "default",
}: {
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
  variant?: keyof typeof TRAILING_BTN_VARIANT;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          aria-label={label}
          // Stop propagation so the TabsTrigger doesn't treat the click as a
          // tab activation and dnd-kit doesn't start a drag.
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.stopPropagation();
            onClick();
          }}
          className={cn(TRAILING_BTN_BASE, TRAILING_BTN_VARIANT[variant])}
        >
          <HugeiconsIcon icon={icon} size={TRAILING_ICON_SIZE} strokeWidth={2} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * State chip rendered next to the tab label for terminal leaves running a
 * known AI CLI. Wrapped in try/catch so a corrupt status object (or a
 * future state value we don't know about yet) can never crash the tab bar.
 */
function AiCliChip({ status }: { status: NonNullable<AiCliStatus> }) {
  let chipClass = "";
  let word = "";
  let label = "";
  try {
    chipClass = aiCliStateChipClass(status);
    word = aiCliStateWord(status);
    label = aiCliLabel(status);
  } catch {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center self-center rounded px-1.5 py-[3px] text-[10px] leading-none font-medium tracking-wide uppercase",
        chipClass,
      )}
      aria-label={label}
    >
      {word}
    </span>
  );
}

/**
 * Tiny monospaced "T<n>" badge stamped next to terminal entries. The same
 * ordinal is surfaced to the AI in the per-turn `<env>` block, so users can
 * say "send to terminal 3" and the AI maps it directly to this badge.
 */
function TerminalOrdinalBadge({ ordinal }: { ordinal: number }) {
  return (
    <span
      aria-label={`Terminal ${ordinal}`}
      className="border-border/60 bg-muted/60 text-muted-foreground inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm border px-[3px] font-mono text-[9px] leading-none font-semibold tabular-nums"
    >
      {ordinal}
    </span>
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
                "ring-background absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1",
                statusDotClass(entry.sshStatus),
              )}
            />
          ) : null}
        </span>
      );
    }
    return (
      <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} strokeWidth={2} className="shrink-0" />
    );
  }
  if (entry.kind === "preview") {
    return <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={2} className="shrink-0" />;
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
