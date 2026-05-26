import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { fileIconUrl, useExplorerIconsReady } from "@/modules/explorer/lib/iconResolver";
import { leafIds, leaves, type PaneLeaf } from "@/modules/terminal/lib/panes";
import { MAX_PANES_PER_TAB } from "./lib/useTabs";
import {
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "@/modules/ssh/connections";
import { statusLabel, statusLabelClass, type SshStatus } from "@/modules/ssh/status";
import {
  aiCliIconClass,
  aiCliLabel,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import { tryGetHugeIcon, useHugeIconsReady } from "@/lib/hugeIconsBarrel";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CloudServerIcon,
  ComputerTerminal02Icon,
  Database01Icon,
  GitCompareIcon,
  Globe02Icon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  LockedIcon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
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
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Tab } from "./lib/useTabs";

/**
 * Tab strip entries: one per pane for pane tabs, one per tab for preview
 * and ai-diff. Clicking a pane entry focuses that pane; clicking a
 * preview/ai-diff entry activates that tab.
 */
type EntryBase = {
  /** Composite key like "tab-3" or "leaf-7". */
  key: string;
  /** Owning tab id. */
  tabId: number;
  /** Display label. */
  label: string;
  /** Italic for preview/transient. */
  italic?: boolean;
  /** Yellow dot for unsaved edits. */
  dirty?: boolean;
};

type PaneEntry = EntryBase & {
  kind: "pane-leaf";
  leafId: number;
  leafKind: "terminal" | "editor";
  /** 1-based FIFO badge number. Same identifier the AI sees in `<env>`. */
  terminalOrdinal?: number;
  /** Set on terminal leaves bound to a saved SSH host. */
  sshConnectionId?: string;
  /** Latest SSH session status. Drives the colored dot. */
  sshStatus?: SshStatus;
  /** Latest AI CLI status for terminal leaves. Null when no AI CLI is active. */
  aiCliStatus?: AiCliStatus;
  /** Set on editor leaves backed by SFTP. Flips the file icon to a remote variant. */
  remoteHost?: string;
  /** Inherited from the owning tab. Drives the red badge + lock icon. */
  isPrivate?: boolean;
};

type StandaloneEntry = EntryBase & {
  kind: "preview" | "ai-diff" | "git-diff";
};

type ExtensionEntry = EntryBase & {
  kind: "ext";
  extensionId: string;
  panelId: string;
  /** Icon hint from the extension. Either `hugeicon:<Name>` for an
   *  inline HugeIcon or a relative asset path. */
  icon?: string;
};

type Entry = PaneEntry | StandaloneEntry | ExtensionEntry;

/**
 * Background color for the per-tab accent stripe. Emerald for local shell,
 * sky for SSH, brand blue for editor, cyan for preview, violet for AI diff,
 * amber for git diff. Rendered as a `<span>` (not `::after`) because the
 * primitive `TabsTrigger` already uses `::after` with equal specificity.
 * Keep strings as full literals for Tailwind's JIT.
 */
function tabAccentClass(e: Entry): string {
  if (e.kind === "pane-leaf") {
    // Private tabs win the accent regardless of leaf kind so the red stripe
    // is the dominant signal. AI cannot see this tab.
    if (e.isPrivate) return "bg-icon-blocked";
    if (e.leafKind === "terminal") {
      return e.sshConnectionId
        ? "bg-[color:var(--tedi-tab-ssh)]"
        : "bg-[color:var(--tedi-tab-terminal)]";
    }
    return "bg-[color:var(--tedi-tab-editor)]";
  }
  if (e.kind === "preview") return "bg-[color:var(--tedi-tab-preview)]";
  if (e.kind === "ai-diff") return "bg-[color:var(--tedi-tab-ai-diff)]";
  if (e.kind === "git-diff") return "bg-[color:var(--tedi-tab-git-diff)]";
  // Extension tab. Reuse the SSH accent (sky blue) so workbench-style
  // extensions read as "remote-ish dev tools" next to terminal tabs.
  return "bg-[color:var(--tedi-tab-ssh)]";
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
  // SSH leaves: show "ssh:<host>". Falls back to bare "ssh" if the connection was deleted.
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
  for (const t of tabs) {
    if (t.kind === "pane") {
      for (const leaf of leaves(t.paneTree)) {
        const label = entryLabel(leaf, t.cwd, sshHosts);
        const sshConnectionId = leaf.leafKind === "terminal" ? leaf.sshConnectionId : undefined;
        // FIFO ordinal assigned at leaf creation. Preserved through drag,
        // reorder, move-to-group, and workspace restarts. Same number the AI
        // sees in the per-turn `<env>` block.
        const ord =
          leaf.leafKind === "terminal" && typeof leaf.terminalOrdinal === "number"
            ? leaf.terminalOrdinal
            : undefined;
        const remoteHost =
          leaf.leafKind === "editor" && leaf.sshSessionId !== undefined
            ? (leaf.sshHostLabel ?? "remote")
            : undefined;
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
          // AI CLI status on SSH leaves too. Detector runs on the byte stream regardless of PTY locality.
          aiCliStatus:
            leaf.leafKind === "terminal" ? aiCliStatuses?.get(leaf.id) : undefined,
          remoteHost,
          isPrivate: leaf.private === true,
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
    if (t.kind === "git-diff") {
      out.push({
        kind: "git-diff",
        key: `tab-${t.id}`,
        tabId: t.id,
        label: t.title,
      });
      continue;
    }
    // ext: extension-owned tab. Carry icon + ext id forward for rendering.
    out.push({
      kind: "ext",
      key: `tab-${t.id}`,
      tabId: t.id,
      label: t.title,
      extensionId: t.extensionId,
      panelId: t.panelId,
      icon: t.icon,
    });
  }
  return out;
}

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
  onNewEditor: () => void;
  /** Flip the `private` flag on a single leaf (per-tab in the strip, not the whole split group). */
  onTogglePrivate?: (leafId: number) => void;
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
  onNewEditor,
  onTogglePrivate,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Re-render once the HugeIcons barrel and catppuccin file-icon set finish
  // loading so extension tab icons + editor-tab file icons swap from the
  // fallback glyph to the real one. Both hooks return true immediately when
  // already cached and flip on load completion.
  useHugeIconsReady();
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
        entries.find(
          (e): e is PaneEntry => e.kind === "pane-leaf" && e.leafId === leafId,
        ) ?? null
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
    <div
      data-tauri-drag-region="false"
      className="flex h-full min-w-0 shrink items-center"
    >
      {/* Scroll arrows. Shown only when the strip overflows. */}
      {overflow && (
        <div
          data-tauri-drag-region="false"
          className="flex shrink-0 items-center gap-0.5 pr-1"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Scroll tabs left"
                onClick={() => scrollByDelta(-200)}
                disabled={!canScrollLeft}
                // h-7 (28px) to match the tab triggers.
                className="border-border/70 bg-muted/30 text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-[background-color,color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-muted/30 disabled:hover:text-muted-foreground/80"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={2} />
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
                className="border-border/70 bg-muted/30 text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-[background-color,color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-muted/30 disabled:hover:text-muted-foreground/80"
              >
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} />
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
                    paneGroupsForMove={paneGroupsForMove}
                  />
                ))}
              </SortableContext>
            </TabsList>
            <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[snapCenterAndLockY]}>
              {draggedEntry && (
                <div
                  className={cn(
                    "bg-accent/95 text-accent-foreground ring-primary/50 flex h-7 cursor-grabbing items-center gap-1.5 rounded-md px-2 text-xs shadow-lg ring-1 backdrop-blur-sm",
                    compact ? "max-w-48" : "max-w-80",
                  )}
                >
                  <EntryIcon entry={draggedEntry} />
                  <span className={cn("truncate", draggedEntry.italic && "italic")}>
                    {draggedEntry.label}
                  </span>
                  {draggedEntry.dirty && (
                    <span className="size-1.5 shrink-0 rounded-full bg-icon-working" />
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
                  className="text-muted-foreground hover:bg-accent hover:text-accent-foreground size-7 shrink-0 rounded-md"
                  aria-label="New"
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">New</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-auto min-w-64">
            <DropdownMenuItem onSelect={() => onNewTerminal()}>
              <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1 whitespace-nowrap">Terminal</span>
              <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuItem>
            {onNewPrivateTerminal ? (
              <DropdownMenuItem onSelect={() => onNewPrivateTerminal()}>
                <HugeiconsIcon
                  icon={LockedIcon}
                  size={14}
                  strokeWidth={1.75}
                  className="text-destructive"
                />
                <span className="flex-1 whitespace-nowrap">Private Terminal</span>
                <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                  {fmtShortcut(MOD_KEY, "Shift", "T")}
                </span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1 whitespace-nowrap">Editor</span>
              <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                {fmtShortcut(MOD_KEY, "E")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1 whitespace-nowrap">Preview</span>
              <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                {fmtShortcut(MOD_KEY, "P")}
              </span>
            </DropdownMenuItem>
            {onSplit ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canSplit} onSelect={() => onSplit("row")}>
                  <HugeiconsIcon icon={LayoutTwoColumnIcon} size={14} strokeWidth={1.75} />
                  <span className="flex-1 whitespace-nowrap">Split right</span>
                  <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                    {fmtShortcut(MOD_KEY, "D")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canSplit} onSelect={() => onSplit("col")}>
                  <HugeiconsIcon icon={LayoutTwoRowIcon} size={14} strokeWidth={1.75} />
                  <span className="flex-1 whitespace-nowrap">Split down</span>
                  <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                    {fmtShortcut(MOD_KEY, "Shift", "D")}
                  </span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
function SortableTabGroup({
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
      entries
        .filter((e): e is PaneEntry => e.kind === "pane-leaf")
        .map((e) => `leaf:${e.leafId}`),
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

/** Shared render args. Kept as one object to avoid 15-arg signatures. */
type RenderEntryArgs = {
  entry: Entry;
  idx: number;
  isSplit: boolean;
  totalEntries: number;
  activeKey: string | null;
  lastEntryKey: string | null;
  compact?: boolean;
  canClose: boolean;
  /** dnd-kit attributes for the trigger as drag handle. */
  dragAttrs?: ReturnType<typeof useSortable>["attributes"];
  dragListeners?: ReturnType<typeof useSortable>["listeners"];
  /** Per-leaf sortable ref and style. Undefined for group-level drag (uses the outer wrapper). */
  dragRef?: (node: HTMLElement | null) => void;
  dragStyle?: React.CSSProperties;
  /** True when this entry is being dragged. Drives ghost opacity. */
  selfDragging?: boolean;
  onPinLeaf: (tabId: number, leafId: number) => void;
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  onCloseEntriesAfter: (entry: Entry) => void;
  sshHosts: Map<string, SshConnection>;
  onMoveLeafToGroup?: (leafId: number, targetTabId: number) => void;
  onMoveLeafToNewTab?: (leafId: number) => "ok" | "invalid";
  onRotateLeafSplit?: (leafId: number) => void;
  onTogglePrivate?: (leafId: number) => void;
  paneGroupsForMove: PaneGroupForMove[];
};

/** Render one entry. Extracted so both group-level and leaf-level drag share the same JSX. */
function renderEntryBody(args: RenderEntryArgs): ReactNode {
  const {
    entry: e,
    idx,
    isSplit,
    totalEntries,
    activeKey,
    lastEntryKey,
    compact,
    canClose,
    dragAttrs,
    dragListeners,
    dragRef,
    dragStyle,
    selfDragging,
    onPinLeaf,
    onCloseEntry,
    onCloseEntriesAfter,
    sshHosts,
    onMoveLeafToGroup,
    onMoveLeafToNewTab,
    onRotateLeafSplit,
    onTogglePrivate,
    paneGroupsForMove,
  } = args;
  const sshHost =
    e.kind === "pane-leaf" && e.sshConnectionId ? sshHosts.get(e.sshConnectionId) : undefined;
  const trigger = (
    <TabsTrigger
      key={e.key}
      ref={dragRef}
      value={e.key}
      data-entry-key={e.key}
      data-tab-id={e.tabId}
      data-tauri-drag-region="false"
      onDoubleClick={() => {
        if (e.kind === "pane-leaf" && e.italic) {
          onPinLeaf(e.tabId, e.leafId);
        }
      }}
      // Drag attrs/listeners supplied by caller. Nullish spreads preserve default click semantics when absent.
      {...(dragAttrs ?? {})}
      {...(dragListeners ?? {})}
      // Inline style set by per-leaf sortables. Undefined for non-leaf paths (wrapper carries the transform).
      // eslint-disable-next-line react/forbid-dom-props
      style={dragStyle}
      className={cn(
        // Active state uses the brand --accent surface. `h-full!` overrides
        // the primitive's calc so trigger height stays an even integer.
        "group bg-muted/30 text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80 relative h-full! shrink-0 justify-between gap-1.5 text-xs transition-[background-color,color] duration-150",
        "data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:font-semibold",
        // Inside a split cluster, entries are flat; outside they keep the pill look.
        isSplit ? "rounded-none" : "rounded-md",
        compact ? "px-2!" : totalEntries === 1 ? "px-2.5!" : "ps-2.5! pe-1.5!",
        // Divider on every entry except the first in a split group.
        isSplit &&
          idx > 0 &&
          "before:bg-border/70 before:absolute before:top-1 before:bottom-1 before:left-0 before:w-px before:content-[''] data-[state=active]:before:opacity-0",
        // Fade the dragged entry so the overlay chip reads as the real thing.
        selfDragging && "opacity-30",
        // Grab cursor on leaves in a split group; non-split tabs inherit it from the wrapper.
        dragListeners && isSplit && "cursor-grab active:cursor-grabbing",
      )}
    >
      {/* Accent stripe, painted only on the active entry. Computed in JS to
          avoid Tailwind variant collisions with the primitive's `::after`. */}
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
          // No `truncate` here; its `overflow:hidden` would clip the ordinal
          // badge. `min-w-0` keeps flex-shrink so the inner label can ellipsize.
          "flex min-w-0 items-center gap-1.5",
          compact ? "max-w-48" : "max-w-80",
        )}
      >
        <EntryIcon entry={e} />
        <span
          className={cn(
            "truncate",
            e.italic && "italic",
            // SSH status colors the label text: pulse yellow while connecting,
            // emerald when connected, red on disconnect/error. Icon stays sky.
            e.kind === "pane-leaf" && e.sshConnectionId
              ? statusLabelClass(e.sshStatus)
              : null,
          )}
        >
          {e.label}
        </span>
        {e.dirty ? (
          <span
            aria-label="Unsaved changes"
            className="size-1.5 shrink-0 rounded-full bg-icon-working"
          />
        ) : null}
      </span>
      {/* Trailing close button. Rotate-split and move-to-group are in the right-click menu. */}
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

  // Right-click actions: rotate split, leave group, join group, close right.
  // Rotate/leave-group only for leaves inside a split. Move-to-group needs another tab.
  const isPaneLeaf = e.kind === "pane-leaf";
  const isPrivate = isPaneLeaf && e.isPrivate === true;
  const moveTargets =
    isPaneLeaf && onMoveLeafToGroup ? paneGroupsForMove.filter((g) => g.id !== e.tabId) : [];
  const canRotate = isPaneLeaf && isSplit && !!onRotateLeafSplit;
  const canLeaveGroup = isPaneLeaf && isSplit && !!onMoveLeafToNewTab;
  const canMove = moveTargets.length > 0;
  const canTogglePrivate = isPaneLeaf && !!onTogglePrivate;
  const canCloseToRight = lastEntryKey !== null && e.key !== lastEntryKey;
  const hasContextActions =
    canRotate || canLeaveGroup || canMove || canTogglePrivate || canCloseToRight;
  const hasLeafActions = canRotate || canLeaveGroup || canMove || canTogglePrivate;
  // Private tabs always get a tooltip explaining the AI-visibility implication;
  // SSH / AI-CLI tooltips win the slot when both apply and append the private
  // note as an extra line.
  const tooltipMode: "ssh" | "ai" | "private" | null = sshHost
    ? "ssh"
    : isPaneLeaf && e.aiCliStatus
      ? "ai"
      : isPrivate
        ? "private"
        : null;
  const PRIVATE_HINT = "Not visible to the native AI agent";

  // Build innermost-out. TabsTrigger must be the DOM child of every asChild
  // trigger so Radix' Slot can merge handlers. Tooltip is a Provider, not a
  // DOM element, so wrapping it first would drop the context-menu handler.
  let inner: ReactNode = trigger;
  if (tooltipMode) inner = <TooltipTrigger asChild>{inner}</TooltipTrigger>;
  if (hasContextActions) inner = <ContextMenuTrigger asChild>{inner}</ContextMenuTrigger>;

  let wrapped: ReactNode = inner;
  if (hasContextActions) {
    wrapped = (
      <ContextMenu>
        {wrapped}
        <ContextMenuContent className="min-w-44">
          {canRotate && (
            <ContextMenuItem onSelect={() => onRotateLeafSplit!(e.leafId)}>
              Toggle Split Orientation
            </ContextMenuItem>
          )}
          {canLeaveGroup && (
            <ContextMenuItem
              onSelect={() => {
                if (e.kind === "pane-leaf") onMoveLeafToNewTab!(e.leafId);
              }}
            >
              Move to New Tab
            </ContextMenuItem>
          )}
          {canMove && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Join Group</ContextMenuSubTrigger>
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
          {canTogglePrivate && (
            <ContextMenuItem
              onSelect={() => {
                if (e.kind === "pane-leaf") onTogglePrivate!(e.leafId);
              }}
            >
              <span className="flex-1">
                {isPrivate ? "Mark as Public" : "Mark as Private"}
              </span>
            </ContextMenuItem>
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
  }
  if (tooltipMode === "ssh") {
    const sshStatus = isPaneLeaf ? e.sshStatus : undefined;
    const ai = isPaneLeaf ? e.aiCliStatus : undefined;
    wrapped = (
      <Tooltip>
        {wrapped}
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-0.5 text-[11px]">
            <span>
              SSH · {sshHost!.user}@{sshHost!.host}:{sshHost!.port}
            </span>
            {sshStatus ? (
              <span className="text-muted-foreground">{statusLabel(sshStatus)}</span>
            ) : null}
            {ai ? <span className="text-muted-foreground">{aiCliLabel(ai)}</span> : null}
            {isPrivate ? (
              <span className="text-destructive">{PRIVATE_HINT}</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  } else if (tooltipMode === "ai") {
    const ai = (e as PaneEntry).aiCliStatus!;
    wrapped = (
      <Tooltip>
        {wrapped}
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-0.5 text-[11px]">
            <span>{aiCliLabel(ai)}</span>
            {isPrivate ? (
              <span className="text-destructive">{PRIVATE_HINT}</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  } else if (tooltipMode === "private") {
    wrapped = (
      <Tooltip>
        {wrapped}
        <TooltipContent side="bottom">
          <div className="text-destructive text-[11px] text-destructive">{PRIVATE_HINT}</div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <Fragment key={e.key}>{wrapped}</Fragment>;
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

/** Trailing icon button styling. Only close lives here; rotate and move are in the right-click menu. */
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
          // Stop propagation so click doesn't activate the tab or start a drag.
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
 * Pill badge stamped next to terminal entries. Same ordinal the AI sees in
 * `<env>`. Public tabs use the muted palette so the emerald/yellow/red
 * palette stays reserved for the AI CLI icon tint. Private tabs override
 * the badge to solid red so the number-going-red is the headline signal
 * that the AI cannot see this tab.
 */
function TerminalOrdinalBadge({
  ordinal,
  isPrivate,
}: {
  ordinal: number;
  isPrivate?: boolean;
}) {
  return (
    <span
      aria-label={
        isPrivate ? `Terminal ${ordinal} (private, hidden from AI)` : `Terminal ${ordinal}`
      }
      className={cn(
        "inline-flex shrink-0 items-center self-center rounded px-1.5 py-[3px] font-mono text-[10px] leading-none font-semibold tabular-nums",
        isPrivate
          ? "bg-icon-blocked text-background"
          : "bg-muted text-muted-foreground",
      )}
    >
      {ordinal}
    </span>
  );
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "pane-leaf") {
    // Private tabs replace the leaf icon with a red lock so the AI-can't-read
    // signal reads at a glance, regardless of terminal vs editor or ssh.
    if (entry.isPrivate) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1">
          <HugeiconsIcon
            icon={LockedIcon}
            size={14}
            strokeWidth={2}
            className="shrink-0 text-destructive"
          />
          {entry.leafKind === "terminal" && entry.terminalOrdinal ? (
            <TerminalOrdinalBadge ordinal={entry.terminalOrdinal} isPrivate />
          ) : null}
        </span>
      );
    }
    if (entry.leafKind === "editor") {
      const url = fileIconUrl(entry.label);
      // Remote files reuse the file-type icon shape but get recolored sky-blue
      // via `mask-image`. Trade-off: loses per-language color cues.
      if (entry.remoteHost) {
        if (!url) return null;
        return (
          <span
            aria-hidden
            className="size-3.5 shrink-0 bg-info"
            style={{
              WebkitMaskImage: `url("${url}")`,
              maskImage: `url("${url}")`,
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
              WebkitMaskSize: "contain",
              maskSize: "contain",
            }}
          />
        );
      }
      return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
    }
    // Terminal leaf. Pick the icon, then tint by AI CLI status. SSH status
    // colors the title text; the icon shows AI CLI state on both local and remote.
    const aiTint = entry.aiCliStatus ? aiCliIconClass(entry.aiCliStatus) : null;
    const terminalIcon = entry.sshConnectionId ? (
      <HugeiconsIcon
        icon={CloudServerIcon}
        size={14}
        strokeWidth={2}
        className={cn("shrink-0", aiTint)}
      />
    ) : (
      <HugeiconsIcon
        icon={ComputerTerminal02Icon}
        size={14}
        strokeWidth={2}
        className={cn("shrink-0", aiTint)}
      />
    );
    if (entry.terminalOrdinal) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1">
          {terminalIcon}
          <TerminalOrdinalBadge ordinal={entry.terminalOrdinal} />
        </span>
      );
    }
    return terminalIcon;
  }
  if (entry.kind === "preview") {
    return <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={2} className="shrink-0" />;
  }
  if (entry.kind === "ext") {
    // Extension tab icon: resolve `hugeicon:<Name>` if the extension hinted
    // one, else fall back to a generic database glyph. Tinted with the same
    // sky color the SSH tab uses so workbench-style extensions read as part
    // of the remote-dev cluster.
    const iconRef = entry.icon ?? "";
    const m = iconRef.match(/^hugeicon:(.+)$/);
    const found = m ? tryGetHugeIcon(m[1]) : null;
    const iconValue: Parameters<typeof HugeiconsIcon>[0]["icon"] = found ?? Database01Icon;
    return (
      <HugeiconsIcon
        icon={iconValue}
        size={14}
        strokeWidth={2}
        className="shrink-0 text-info"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={GitCompareIcon}
      size={14}
      strokeWidth={2}
      className="shrink-0 text-icon-working"
    />
  );
}
