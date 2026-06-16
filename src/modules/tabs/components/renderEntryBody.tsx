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
import { TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MAX_PANES_PER_TAB } from "../lib/useTabs";
import { type SshConnection } from "@/modules/ssh/connections";
import { statusLabel, statusLabelClass } from "@/modules/ssh/status";
import { aiCliLabel } from "@/modules/terminal/lib/aiCliStatus";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useSortable } from "@dnd-kit/sortable";
import { Fragment } from "react";
import type { ReactNode } from "react";
import {
  type Entry,
  type PaneEntry,
  extensionStateLabelClass,
  tabAccentClass,
} from "../lib/entries";
import { EntryIcon } from "./EntryIcon";
import { TrailingIconButton } from "./TrailingIconButton";

export type PaneGroupForMove = {
  id: number;
  title: string;
  count: number;
  full: boolean;
};

/** Shared render args. Kept as one object to avoid 15-arg signatures. */
export type RenderEntryArgs = {
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
export function renderEntryBody(args: RenderEntryArgs): ReactNode {
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
          // Cap tab width so long page titles (browser panes) don't make tabs
          // huge; the inner label `truncate`s with an ellipsis past this.
          compact ? "max-w-32" : "max-w-44",
        )}
      >
        <EntryIcon entry={e} />
        <span
          className={cn(
            "truncate",
            e.italic && "italic",
            // SSH status colors the label text: pulse yellow while connecting,
            // emerald when connected, red on disconnect/error. Icon stays sky.
            e.kind === "pane-leaf" && e.sshConnectionId ? statusLabelClass(e.sshStatus) : null,
            // Extension-driven lifecycle tone (e.g. SQL Explorer signalling
            // its DB connection state). Same palette as the SSH label — for
            // both the standalone ext tab and an extension-panel pane leaf.
            e.kind === "ext" ? extensionStateLabelClass(e.state) : null,
            e.kind === "pane-leaf" && e.leafKind === "extension-panel"
              ? extensionStateLabelClass(e.extState)
              : null,
            // Private leaves carry the red on the label (not the icon) so the
            // icon colour stays free to show AI CLI status. Last = wins.
            e.kind === "pane-leaf" && e.isPrivate === true && "text-destructive",
          )}
        >
          {e.label}
        </span>
        {e.dirty ? (
          <span
            aria-label="Unsaved changes"
            className="bg-icon-working size-1.5 shrink-0 rounded-full"
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
              <ContextMenuSubContent className="max-w-52">
                {moveTargets.map((g) => (
                  <ContextMenuItem
                    key={g.id}
                    disabled={g.full}
                    onSelect={() => {
                      if (e.kind === "pane-leaf") onMoveLeafToGroup!(e.leafId, g.id);
                    }}
                  >
                    {/* min-w-0 lets the long page title ellipsize instead of
                        stretching the menu; the count stays pinned. */}
                    <span className="min-w-0 flex-1 truncate">{g.title}</span>
                    <span className="text-muted-foreground ml-2 shrink-0 text-xs">
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
              <span className="flex-1">{isPrivate ? "Mark as Public" : "Mark as Private"}</span>
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
            {isPrivate ? <span className="text-destructive">{PRIVATE_HINT}</span> : null}
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
            {isPrivate ? <span className="text-destructive">{PRIVATE_HINT}</span> : null}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  } else if (tooltipMode === "private") {
    wrapped = (
      <Tooltip>
        {wrapped}
        <TooltipContent side="bottom">
          <div className="text-destructive text-destructive text-[11px]">{PRIVATE_HINT}</div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <Fragment key={e.key}>{wrapped}</Fragment>;
}
