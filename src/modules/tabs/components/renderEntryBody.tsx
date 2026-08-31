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
import { hopDotClass, sshHopDetail, statusLabel } from "@/modules/ssh/status";
import { aiCliLabel } from "@/modules/terminal/lib/aiCliStatus";
import { Pin, X } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { Fragment } from "react";
import type { ReactNode } from "react";
import { type Entry, type PaneEntry, entryLabelClass, tabAccentClass } from "../lib/entries";
import { InlineInput } from "@/modules/explorer/InlineInput";
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
  /**
   * Pin or unpin the whole owning TAB. Deliberately not a per-leaf action -
   * see the note on the Tab type in tabTypes.ts for why pinning cannot mean
   * anything at leaf level.
   */
  onSetTabPinned?: (tabId: number, pinned: boolean) => void;
  paneGroupsForMove: PaneGroupForMove[];
  /** Leaf currently being renamed inline, or null. Owned by the caller because
   *  this is a plain render function, not a component, so it holds no state. */
  renamingLeafId?: number | null;
  /** Enter (leafId) or leave (null) inline rename. */
  onSetRenaming?: (leafId: number | null) => void;
  /** Commit a new tab name, or `null` to drop back to the derived one. */
  onRename?: (leafId: number, title: string | null) => void;
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
    onSetTabPinned,
    paneGroupsForMove,
    renamingLeafId,
    onSetRenaming,
    onRename,
  } = args;
  const sshHost =
    e.kind === "pane-leaf" && e.sshConnectionId ? sshHosts.get(e.sshConnectionId) : undefined;
  const isPaneLeaf = e.kind === "pane-leaf";
  // Declared before the trigger JSX below, which reads `renaming` to swap the
  // label for an edit field. Keeping them with the other right-click flags
  // further down would be a use-before-init at render time.
  const canRename = isPaneLeaf && !!onRename && !!onSetRenaming;
  const renaming = isPaneLeaf && e.kind === "pane-leaf" && renamingLeafId === e.leafId;
  const isPinned = e.pinned === true;
  /**
   * A pinned tab shows a pin where its title would be. The tab keeps its normal
   * padding and sizing: it ends up narrower simply because a glyph is narrower
   * than a name, not because a special compact rule is applied. Suspended while
   * renaming, since the rename field needs the title's place back.
   */
  const pinInsteadOfTitle = isPinned && !renaming;
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
        // A pinned tab has no label and no close button, so it only needs
        // room for its icon: even padding, and no space reserved for a
        // trailing control that is not there.
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
            "pointer-events-none absolute top-1/2 left-1 h-4 w-px -translate-y-1/2",
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
          // huge; the inner label truncates with an ellipsis past this. A
          // pinned tab has no label to cap.
          compact ? "max-w-32" : "max-w-44",
        )}
      >
        <EntryIcon entry={e} />
        {/* The pin marker. Sits NEXT TO the identity icon rather than replacing
            it: which tab this is matters more than the fact that it is pinned,
            and swapping the icon out would make a row of pinned tabs
            indistinguishable from one another.

            Only on the first entry, because a split group is several chips but
            ONE pinned tab - repeating the glyph on all six panes of a split
            would be noise that also implies each pane is pinned separately. */}

        {renaming && e.kind === "pane-leaf" ? (
          // `stopPropagation` on pointerdown so a drag-to-reorder gesture cannot
          // start from inside the field: the drag listeners live on the trigger
          // this input sits in, and text selection would otherwise reorder tabs.
          // InlineInput is the explorer's rename field, reused here because it
          // already survives the hazard this flow creates - the context menu's
          // Radix portal steals focus as it unmounts, and it re-focuses through
          // that instead of committing an empty name.
          <span className="flex min-w-0 flex-1" onPointerDown={(ev) => ev.stopPropagation()}>
            <InlineInput
              // The kind tag ("ssh", "SQL", "API") is core's, not the user's;
              // it is re-applied around whatever they type.
              initial={e.renameSeed}
              placeholder="Tab name"
              onCommit={(value) => {
                onSetRenaming?.(null);
                // Blank means "back to the derived name", not an empty tab.
                onRename?.(e.leafId, value.trim() ? value : null);
              }}
              onCancel={() => onSetRenaming?.(null)}
            />
          </span>
        ) : pinInsteadOfTitle ? (
          // Where the title used to be. TabsTrigger forces `size-4` on any svg
          // without a size- CLASS, so the class is what sets this, not a size
          // attribute.
          <Pin aria-label="Pinned" strokeWidth={2.25} className="size-3 shrink-0 opacity-80" />
        ) : (
          <span
            className={cn(
              "truncate",
              e.italic && "italic",
              // SSH / extension lifecycle / private tone. Shared with the
              // Workspaces panel so the same entry is the same colour in both.
              entryLabelClass(e),
            )}
          >
            {e.label}
          </span>
        )}
        {e.dirty ? (
          <span
            aria-label="Unsaved changes"
            className="bg-foreground/60 size-1.5 shrink-0 rounded-full"
          />
        ) : null}
      </span>
      {/* Trailing close button. Rotate-split and move-to-group are in the right-click menu.
          Hidden while renaming: it crowds the field, and clicking it mid-rename would
          close the very tab being named. */}
      <span className="ms-1.5 flex shrink-0 items-center gap-0.5">
        {/* Pinned tabs hide the close button, exactly as Chrome does: the
            point of pinning is that the tab survives, and a 1-pixel miss on
            a chip this small should not be able to end it. Close stays
            reachable from the right-click menu after unpinning. */}
        {canClose && !renaming && (
          <TrailingIconButton
            icon={X}
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
  const isPrivate = isPaneLeaf && e.isPrivate === true;
  const moveTargets =
    isPaneLeaf && onMoveLeafToGroup ? paneGroupsForMove.filter((g) => g.id !== e.tabId) : [];
  const canRotate = isPaneLeaf && isSplit && !!onRotateLeafSplit;
  const canLeaveGroup = isPaneLeaf && isSplit && !!onMoveLeafToNewTab;
  const canMove = moveTargets.length > 0;
  const canTogglePrivate = isPaneLeaf && !!onTogglePrivate;
  const canPin = !!onSetTabPinned;
  /**
   * A split group is several chips in the strip but ONE tab, so pinning any
   * of its leaves pins all of them. Saying Group rather than Tab here is the
   * whole disambiguation: without it, right-clicking one pane of a split and
   * choosing Pin Tab reads like a promise to pull that single pane out to
   * the front of the strip, which is not a thing a leaf can do.
   */
  const pinLabel = isSplit ? "Group" : "Tab";
  const canCloseToRight = lastEntryKey !== null && e.key !== lastEntryKey;
  const hasContextActions =
    canRename ||
    canRotate ||
    canLeaveGroup ||
    canMove ||
    canTogglePrivate ||
    canPin ||
    canCloseToRight;
  const hasLeafActions = canRename || canRotate || canLeaveGroup || canMove || canTogglePrivate;
  // Private tabs always get a tooltip explaining the AI-visibility implication;
  // SSH / AI-CLI tooltips win the slot when both apply and append the private
  // note as an extra line.
  const tooltipMode: "ssh" | "ai" | "private" | "pinned" | null = sshHost
    ? "ssh"
    : isPaneLeaf && e.aiCliStatus
      ? "ai"
      : isPrivate
        ? "private"
        : // A compact pinned tab shows no label at all, so the hover is the
          // only way left to tell two pinned terminals apart. This is not a
          // nicety: without it, compaction destroys information.
          pinInsteadOfTitle
          ? "pinned"
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
          {canRename && (
            <ContextMenuItem
              onSelect={() => {
                if (e.kind === "pane-leaf") onSetRenaming!(e.leafId);
              }}
            >
              Rename
            </ContextMenuItem>
          )}
          {canRename && e.kind === "pane-leaf" && e.renamed && (
            <ContextMenuItem
              onSelect={() => {
                if (e.kind === "pane-leaf") onRename!(e.leafId, null);
              }}
            >
              Reset Name
            </ContextMenuItem>
          )}
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
          {canPin && (
            <ContextMenuItem onSelect={() => onSetTabPinned!(e.tabId, !isPinned)}>
              <span className="flex-1">{`${isPinned ? "Unpin" : "Pin"} ${pinLabel}`}</span>
            </ContextMenuItem>
          )}
          {canCloseToRight && (hasLeafActions || canPin) && <ContextMenuSeparator />}
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
            {pinInsteadOfTitle ? <span>{e.label}</span> : null}
            <span>
              SSH · {sshHost!.user}@{sshHost!.host}:{sshHost!.port}
            </span>
            {sshStatus ? (
              <span className="text-muted-foreground">{statusLabel(sshStatus)}</span>
            ) : null}
            {/* The jump chain, when there is one. A tab labelled "prod-db"
                otherwise gives no hint that it is reached through a bastion,
                and the status bar only ever shows the ACTIVE pane's route. */}
            {sshStatus?.route?.length ? (
              <span className="text-muted-foreground flex flex-col gap-0.5 pt-0.5">
                {sshStatus.route.map((hop, i) => (
                  <span key={`${hop.host}-${i}`} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", hopDotClass(hop.state))}
                    />
                    <span className="font-mono">{sshHopDetail(hop)}</span>
                    <span>{hop.isTarget ? "· target" : "· jump"}</span>
                  </span>
                ))}
              </span>
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
            {pinInsteadOfTitle ? <span>{e.label}</span> : null}
            <span>{aiCliLabel(ai)}</span>
            {isPrivate ? <span className="text-destructive">{PRIVATE_HINT}</span> : null}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  } else if (tooltipMode === "pinned") {
    wrapped = (
      <Tooltip>
        {wrapped}
        <TooltipContent side="bottom">
          <div className="flex items-center gap-1.5 text-[11px]">
            <Pin aria-hidden size={10} strokeWidth={2} />
            <span>{e.label}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  } else if (tooltipMode === "private") {
    wrapped = (
      <Tooltip>
        {wrapped}
        <TooltipContent side="bottom">
          <div className="text-destructive text-[11px]">{PRIVATE_HINT}</div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <Fragment key={e.key}>{wrapped}</Fragment>;
}
