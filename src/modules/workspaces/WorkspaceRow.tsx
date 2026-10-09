import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { entryLabelClass, type Entry } from "@/modules/tabs/lib/entries";
import { EntryIcon } from "@/modules/tabs/components/EntryIcon";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { useGitBranch } from "@/modules/scm/branch";
import { type Worktree } from "@/modules/scm/worktrees";
import { basename, toForwardSlash } from "@/lib/path";
import { statusLabel, statusLabelClass } from "@/modules/ssh/status";
import { aiCliLabel } from "@/modules/terminal/lib/aiCliStatus";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useEffect, useState } from "react";
import { type Workspace } from "./store";
import {
  AlarmClock,
  AlarmClockOff,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  Pencil,
  Pin,
  PinOff,
  X,
} from "lucide-react";

/**
 * One row under an expanded workspace: a tab-strip entry, verbatim. The panel
 * deliberately carries `Entry` rather than a shape of its own, so a pane's name,
 * icon, ordinal badge and status colour down here are literally the ones the
 * strip shows for it. This list used to derive its own label from the cwd
 * basename, which is how a renamed tab and an `ssh:<host>` pane both read wrong
 * in the panel while reading right in the strip.
 */
export type EntryRow = {
  entry: Entry;
  /** Program-set terminal title (OSC 2), e.g. a running agent's task. */
  title?: string;
  /** Live rows can be focused and renamed; a cold workspace's cannot (its ids
   *  are display-only, minted while rehydrating the snapshot). */
  live: boolean;
};

/**
 * A row's own LOCAL working directory, or undefined.
 *
 * Per ROW, never per workspace: one workspace routinely holds panes in two
 * different projects, so "the workspace's repository" has no single answer and
 * anything keyed to it would name the wrong folder half the time. A terminal's
 * cwd is the only thing in a workspace that names one. SSH panes are skipped -
 * their path exists on another machine, so local git would answer about the
 * wrong one.
 */
function localTerminalCwd(e: Entry): string | undefined {
  if (e.kind !== "pane-leaf" || e.leafKind !== "terminal") return undefined;
  if (!e.cwd || e.sshConnectionId) return undefined;
  return toForwardSlash(e.cwd);
}

/**
 * One linked worktree of a workspace's project, listed under it.
 *
 * Styled as an `EntryRowItem` without the actions, deliberately: a worktree sits
 * in the same list as the tabs and reads as a sibling of them, which is what it
 * is - another checkout you can be working in. The fork glyph is what separates
 * the two, and it is the same one Source Control uses for worktrees.
 *
 * No remove button. Removing one deletes a folder and needs the
 * uncommitted-work confirmation, which Source Control's worktree menu already
 * owns; a second copy of that flow here would be a second thing to keep right.
 */
function WorktreeRowItem({
  worktree: wt,
  base,
  onOpen,
}: {
  worktree: Worktree;
  /** Main worktree path, so the row can print a relative folder. */
  base: string;
  onOpen: () => void;
}) {
  const label = wt.branch ?? `detached ${wt.head.slice(0, 7)}`;
  const rel = wt.path.startsWith(`${base}/`) ? wt.path.slice(base.length + 1) : wt.path;
  return (
    <li className="group/row relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            className="text-sidebar-foreground/85 hover:bg-sidebar-accent/40 flex h-6 w-full items-center gap-1.5 pr-1.5 pl-11 text-[11px] transition-colors"
          >
            <GitFork size={11} strokeWidth={2} className="text-icon-branch shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {wt.prunable ? (
              <span className="text-destructive shrink-0 text-[10px]">missing</span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="font-mono text-[10px]">{rel}</span>
          <br />
          {wt.prunable ? "Its folder is gone. Prune it from Source Control." : "Open in a terminal"}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

type RowProps = {
  workspace: Workspace;
  isActive: boolean;
  isEditing: boolean;
  isExpanded: boolean;
  draft: string;
  tabCount: number;
  rows: EntryRow[];
  canClose: boolean;
  sortable: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onStartEdit: (id: string, current: string) => void;
  /** Pin or unpin this workspace. Distinct from pinning a TAB inside it;
   *  see the note on Workspace.pinned in the store. */
  onSetPinned: (id: string, pinned: boolean) => void;
  onDraftChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onToggleExpanded: (id: string) => void;
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  onRenameLeaf?: (leafId: number, title: string | null) => void;
  onSetTabSnoozed?: (tabId: number, snoozed: boolean) => void;
  onCloseEntry?: (tabId: number, leafId: number | null) => void;
  renamingLeafId: number | null;
  onSetRenamingLeaf: (leafId: number | null) => void;
  activeLeafId?: number | null;
  /** Every project folder's worktrees, keyed by cwd. Owned by the panel so the
   *  create dialog and the rows read one list. */
  worktrees: Record<string, Worktree[]>;
  /** Ask the panel to re-read one folder's list. Called when this row expands. */
  onLoadWorktrees: (cwd: string) => Promise<Worktree[]>;
  /** Open the create dialog for the project a row sits in. */
  onNewWorktree: (cwd: string) => void;
  onOpenWorktree: (worktree: Worktree, list: Worktree[]) => void;
};

/**
 * One workspace row. The header line is the drag handle (like a tab), so a
 * plain click still switches and a double-click still renames thanks to the
 * sensor's activation distance. The trailing action buttons and the (optional)
 * tab sub-list stop pointer propagation so interacting with them never starts a
 * drag.
 */
export function SortableWorkspaceRow({
  workspace: w,
  isActive,
  isEditing,
  isExpanded,
  draft,
  tabCount,
  rows,
  canClose,
  sortable,
  onSwitch,
  onClose,
  onStartEdit,
  onSetPinned,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onToggleExpanded,
  onFocusLeaf,
  onRenameLeaf,
  onSetTabSnoozed,
  onCloseEntry,
  renamingLeafId,
  onSetRenamingLeaf,
  activeLeafId,
  worktrees,
  onLoadWorktrees,
  onNewWorktree,
  onOpenWorktree,
}: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: w.id,
    disabled: !sortable,
    transition: { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const hasRows = rows.length > 0;
  const [confirmingClose, setConfirmingClose] = useState(false);
  /** Project groups the user has folded shut, by main-worktree path. Session
   *  only, and OPEN by default: a workspace is expanded to see what is in it. */
  const [shutGroups, setShutGroups] = useState<Set<string>>(() => new Set());
  // Listed tab/pane awaiting its own close confirmation, or null.
  const [confirmingEntry, setConfirmingEntry] = useState<Entry | null>(null);
  /**
   * Whether the listed tabs get a close button. Two conditions, both load-bearing:
   *  - `isActive`: an entry's ids address the LIVE tab strip, which exists only
   *    for the active workspace. Offering the button on an inactive one would
   *    close nothing (or, worse, whatever shares that id in the live tree).
   *  - `rows.length > 1`: the tab strip's own rule (`canClose = totalEntries > 1`
   *    in SortableTabGroup) - never close the last tab, so the window is never
   *    left empty. Read from the same entry list the strip builds, so the two
   *    cannot disagree.
   */
  const canCloseEntry = isActive && !!onCloseEntry && rows.length > 1;

  /** Distinct project folders in this workspace, in row order. Plural on
   *  purpose: one workspace commonly holds panes in two of them. */
  const cwds: string[] = [];
  for (const r of rows) {
    const c = localTerminalCwd(r.entry);
    if (c && !cwds.includes(c)) cwds.push(c);
  }
  // Read on expand, so a panel full of collapsed workspaces spawns no git. The
  // key is what the effect reads, so there is no stale `rows` closure.
  const cwdKey = cwds.join("|");
  useEffect(() => {
    if (!isExpanded || !cwdKey) return;
    for (const c of cwdKey.split("|")) void onLoadWorktrees(c);
  }, [isExpanded, cwdKey, onLoadWorktrees]);

  /**
   * The rows, grouped by the PROJECT they sit in.
   *
   * One project, however many worktrees: two panes on two different checkouts of
   * `pokehub` are two rows of one group, because they are one codebase and the
   * branch line under each already says which checkout. Grouping by the MAIN
   * worktree path is what makes that true - every checkout of a repository
   * resolves to the same main, so different folders still land together.
   *
   * Rows that belong to no repository (an SSH pane, an editor, a standalone tab)
   * keep their place in an unnamed group rather than being sorted to the end,
   * so the list still reads in the order the tab strip does.
   */
  type RowGroup = {
    /** Main worktree path; "" for the rows that belong to no repository. */
    key: string;
    name: string;
    rows: EntryRow[];
    /** This project's worktrees that are NOT already open as one of `rows`. */
    linked: Worktree[];
    /** The whole list, so opening one can name its tab after the project. */
    list: Worktree[];
    /** Any cwd in the project, to create a new worktree from. */
    cwd: string;
  };
  const groups: RowGroup[] = [];
  {
    const byMain = new Map<string, RowGroup>();
    const open = new Set(cwds);
    for (const r of rows) {
      const cwd = localTerminalCwd(r.entry);
      const list = cwd ? worktrees[cwd] : undefined;
      const main = list?.find((x) => x.main)?.path;
      if (!cwd || !main || !list) {
        const last = groups[groups.length - 1];
        if (last && last.key === "") last.rows.push(r);
        else groups.push({ key: "", name: "", rows: [r], linked: [], list: [], cwd: "" });
        continue;
      }
      let g = byMain.get(main);
      if (!g) {
        g = { key: main, name: basename(main), rows: [], linked: [], list, cwd };
        byMain.set(main, g);
        groups.push(g);
      }
      g.rows.push(r);
    }
    // A worktree ALREADY open as a tab is one of the rows above it, so listing
    // it again put the same checkout on screen twice under two different icons.
    // What is left is exactly "the checkouts you have not opened yet".
    for (const g of byMain.values())
      g.linked = g.list.filter((x) => !x.main && !x.bare && !open.has(x.path));
  }

  return (
    <li
      ref={setNodeRef}
      // dnd-kit drives transform/transition per frame. Must stay inline.
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      {...attributes}
      {...listeners}
      className={cn("flex flex-col", sortable && "cursor-grab active:cursor-grabbing")}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group relative flex h-7 items-center gap-1 rounded px-1.5 text-xs",
              isDragging && "opacity-30",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
            )}
          >
            <button
              type="button"
              // Stop the drag listeners; a click only toggles the tab list.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => hasRows && onToggleExpanded(w.id)}
              aria-label={isExpanded ? "Collapse tabs" : "Expand tabs"}
              aria-expanded={isExpanded}
              disabled={!hasRows}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded transition-colors",
                hasRows ? "hover:bg-foreground/10" : "opacity-0",
              )}
            >
              {/* One chevron that rotates, not two that swap: a ternary between two
              icons replaces the DOM node, so it can never animate. */}
              <ChevronRight
                size={11}
                strokeWidth={2.25}
                className={cn("transition-transform", isExpanded && "rotate-90")}
              />
            </button>
            <Folder size={13} strokeWidth={1.75} className="shrink-0" />
            {/* Always visible, unlike the hover actions: a pin nobody can see
            without hovering does not explain why this workspace sits at the
            top of the list. */}
            {w.pinned && (
              <Pin
                aria-label="Pinned"
                size={10}
                strokeWidth={2.25}
                className="shrink-0 opacity-70"
              />
            )}
            {isEditing ? (
              <input
                autoFocus
                aria-label="Workspace name"
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitEdit();
                  else if (e.key === "Escape") onCancelEdit();
                }}
                onBlur={onCommitEdit}
                className="border-border/60 bg-background focus:border-primary/40 min-w-0 flex-1 rounded border px-1 text-xs outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (!isActive) onSwitch(w.id);
                }}
                onDoubleClick={() => onStartEdit(w.id, w.name)}
                className="min-w-0 flex-1 truncate text-left"
              >
                {w.name}
              </button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "bg-muted/50 shrink-0 rounded px-1 text-[10px] tabular-nums transition-opacity",
                    isActive ? "text-accent-foreground/80" : "text-muted-foreground",
                    "group-hover:opacity-0",
                  )}
                  aria-label={`${tabCount} tabs open`}
                >
                  {tabCount}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">
                {`${tabCount} ${tabCount === 1 ? "tab" : "tabs"} open`}
              </TooltipContent>
            </Tooltip>
            <span className="pointer-events-none absolute right-1.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
              <IconTooltip label={w.pinned ? "Unpin workspace" : "Pin workspace"}>
                <Button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSetPinned(w.id, !w.pinned)}
                  aria-label={w.pinned ? "Unpin workspace" : "Pin workspace"}
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground size-5 rounded"
                >
                  {w.pinned ? (
                    <PinOff size={11} strokeWidth={1.75} />
                  ) : (
                    <Pin size={11} strokeWidth={1.75} />
                  )}
                </Button>
              </IconTooltip>
              <IconTooltip label="Rename">
                <Button
                  // Stop the pointerdown from reaching the row's drag listeners.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onStartEdit(w.id, w.name)}
                  aria-label="Rename workspace"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground size-5 rounded"
                >
                  <Pencil size={11} strokeWidth={1.75} />
                </Button>
              </IconTooltip>
              {canClose && (
                <IconTooltip label="Close workspace">
                  <Button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => (tabCount > 0 ? setConfirmingClose(true) : onClose(w.id))}
                    aria-label="Close workspace"
                    variant="ghost"
                    size="icon-sm"
                    className={cn(DESTRUCTIVE_ACTION, "size-5 rounded")}
                  >
                    <X size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
              )}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => onStartEdit(w.id, w.name)}>Rename</ContextMenuItem>
          {/* Says Workspace, not just Pin. The tab strip has its own Pin Tab
              item, and the two mean different things; naming the subject in
              both places is what keeps them apart. */}
          <ContextMenuItem onSelect={() => onSetPinned(w.id, !w.pinned)}>
            {w.pinned ? "Unpin Workspace" : "Pin Workspace"}
          </ContextMenuItem>
          {canClose && <ContextMenuSeparator />}
          {canClose && (
            <ContextMenuItem
              variant="destructive"
              onSelect={() => (tabCount > 0 ? setConfirmingClose(true) : onClose(w.id))}
            >
              Close Workspace
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmingClose} onOpenChange={setConfirmingClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close workspace &quot;{w.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {tabCount} open {tabCount === 1 ? "tab" : "tabs"} and any running terminals will
              be closed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onClose(w.id)}>
              Close workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* One dialog for the whole row rather than one per listed tab: only ever
          a single close is pending, and the rows can number in the dozens. */}
      <AlertDialog
        open={confirmingEntry !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingEntry(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close &quot;{confirmingEntry?.label}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This tab and anything running in it will be closed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const e = confirmingEntry;
                if (e) onCloseEntry?.(e.tabId, e.kind === "pane-leaf" ? e.leafId : null);
                setConfirmingEntry(null);
              }}
            >
              Close tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isExpanded && hasRows && (
        // Not a drag surface: stop pointerdown so scrolling/clicking the list
        // never starts a workspace reorder.
        <ul onPointerDown={(e) => e.stopPropagation()} className="mt-0.5 mb-1 flex flex-col gap-px">
          {groups.map((g) => {
            const shut = g.name !== "" && shutGroups.has(g.key);
            return (
              <Fragment key={g.key || `loose:${g.rows[0]?.entry.key}`}>
                {/* Project header. Its own accordion, and the unambiguous place
                    to make a worktree: a GROUP is exactly one repository, which
                    the workspace above it is not. */}
                {g.name ? (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <li>
                        <button
                          type="button"
                          onClick={() =>
                            setShutGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(g.key)) next.delete(g.key);
                              else next.add(g.key);
                              return next;
                            })
                          }
                          aria-expanded={!shut}
                          className="text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground flex h-6 w-full items-center gap-1.5 rounded pr-1.5 pl-6 text-[11px] transition-colors"
                        >
                          <ChevronRight
                            size={10}
                            strokeWidth={2.25}
                            className={cn("shrink-0 transition-transform", !shut && "rotate-90")}
                          />
                          <FolderGit2 size={12} strokeWidth={2} className="shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1 truncate text-left font-medium">
                            {g.name}
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums opacity-50">
                            {g.rows.length + g.linked.length}
                          </span>
                        </button>
                      </li>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-44">
                      <ContextMenuItem onSelect={() => onNewWorktree(g.cwd)}>
                        New Worktree
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ) : null}
                {shut
                  ? null
                  : g.rows.map((r) => (
                      <EntryRowItem
                        key={r.entry.key}
                        row={r}
                        nested={g.name !== ""}
                        isActiveLeaf={
                          activeLeafId != null &&
                          r.live &&
                          r.entry.kind === "pane-leaf" &&
                          r.entry.leafId === activeLeafId
                        }
                        renaming={
                          r.live &&
                          r.entry.kind === "pane-leaf" &&
                          renamingLeafId === r.entry.leafId
                        }
                        onOpen={() => {
                          if (r.live && onFocusLeaf) {
                            // Standalone tabs have no leaf; -1 matches none, so
                            // the tab side activates the tab and leaves its
                            // panes alone.
                            onFocusLeaf(
                              r.entry.tabId,
                              r.entry.kind === "pane-leaf" ? r.entry.leafId : -1,
                            );
                          } else if (!isActive) onSwitch(w.id);
                        }}
                        onRename={onRenameLeaf}
                        onSetRenaming={onSetRenamingLeaf}
                        // Live ids only exist for the active workspace. Waking is
                        // always allowed; snoozing needs another awake tab left,
                        // the same rule the tab strip applies.
                        onToggleSnooze={
                          isActive &&
                          r.live &&
                          onSetTabSnoozed &&
                          (r.entry.snoozed ||
                            rows.some((x) => x.entry.tabId !== r.entry.tabId && !x.entry.snoozed))
                            ? () => onSetTabSnoozed(r.entry.tabId, !r.entry.snoozed)
                            : undefined
                        }
                        onRequestClose={
                          canCloseEntry ? () => setConfirmingEntry(r.entry) : undefined
                        }
                        // Also on the row, not only on the group header: this is
                        // where the action was first learned, and a row sits in
                        // exactly one project too.
                        onNewWorktree={g.cwd ? () => onNewWorktree(g.cwd) : undefined}
                        // Inside a named group the row's own label repeats the
                        // project three lines running, so it leads with the
                        // branch instead - the fact that tells checkouts apart.
                        projectName={g.name || undefined}
                      />
                    ))}
                {/* The checkouts of this project nobody has opened yet. */}
                {shut
                  ? null
                  : g.linked.map((x) => (
                      <WorktreeRowItem
                        key={x.path}
                        worktree={x}
                        base={g.key}
                        onOpen={() => onOpenWorktree(x, g.list)}
                      />
                    ))}
              </Fragment>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * One tab/pane row under an expanded workspace. Icon, ordinal badge, label and
 * label colour all come from the tab-strip entry so this list and the strip
 * cannot drift; only the layout is the panel's own.
 */
function EntryRowItem({
  row,
  isActiveLeaf,
  renaming,
  onOpen,
  onRename,
  onSetRenaming,
  onToggleSnooze,
  onRequestClose,
  onNewWorktree,
  projectName,
  nested,
}: {
  row: EntryRow;
  isActiveLeaf: boolean;
  renaming: boolean;
  onOpen: () => void;
  onRename?: (leafId: number, title: string | null) => void;
  onSetRenaming: (leafId: number | null) => void;
  /** Snooze or wake this row's tab. Absent when the row is not live or it is
   *  the last awake tab. */
  onToggleSnooze?: () => void;
  /** Ask the parent row to confirm closing this entry. Absent when closing it
   *  isn't allowed (not the active workspace, or it's the last tab left). */
  onRequestClose?: () => void;
  /** Offer "New Worktree" on this row's right-click. Absent for a row that
   *  names no local folder - a standalone tab, an editor, an SSH pane. */
  onNewWorktree?: () => void;
  /** Indented a level deeper, because a project header sits above it. Without
   *  a project the row is a direct child of the workspace and stays shallow. */
  nested?: boolean;
  /** Name of the project group this row sits under, when it has one. A row
   *  whose label is exactly that repeats it a third time, so it leads with its
   *  branch instead. */
  projectName?: string;
}) {
  const { entry: e, title } = row;
  const isLeaf = e.kind === "pane-leaf";
  // Renaming writes `customTitle` on a LEAF, so a standalone tab (SCM, a diff,
  // an extension tab) has nothing to write to. A cold workspace's ids are
  // display-only, so its rows are read-only too.
  const canRename = row.live && isLeaf && !!onRename;
  const actionCount = (onToggleSnooze ? 1 : 0) + (canRename ? 1 : 0) + (onRequestClose ? 1 : 0);
  const cwd = e.kind === "pane-leaf" ? e.cwd : undefined;
  const sshStatus = e.kind === "pane-leaf" ? e.sshStatus : undefined;
  const ai = e.kind === "pane-leaf" ? e.aiCliStatus : undefined;
  const isPrivate = e.kind === "pane-leaf" && e.isPrivate === true;
  // The OSC title repeats the label often enough (a shell that titles itself
  // after its folder) that showing both would just read as a stutter.
  // A shell titles itself with its own binary (`C:\...\pwsh.exe`, `/bin/bash`),
  // which is the same string on every row and drowned the branch beside it. The
  // useful case is an AGENT naming its task, and a task is not an absolute path.
  const showTitle =
    !!title && title !== e.label && title !== cwd && !/^([A-Za-z]:[\\/]|\/)/.test(title);
  // A remote pane reads its branch over its OWN session, so the answer is the
  // branch on that box rather than on this one. An ad-hoc connection has no
  // saved profile but does have a live session, so it resolves here too.
  const sshSessionId = sshStatus?.kind === "connected" ? sshStatus.sessionId : undefined;
  // Only a terminal has a working directory to be "on a branch" in. A LOCAL one
  // answers from its path alone, so an unopened workspace's panes still show
  // their branch when you expand it - the row is only mounted while expanded, so
  // asking is the user's own doing. A pane bound to an SSH host is skipped until
  // its session is up: without one there is nothing to ask, and asking the local
  // git about a remote path would answer about the wrong machine.
  const isSshLeaf = e.kind === "pane-leaf" && !!e.sshConnectionId;
  const isTerminal = e.kind === "pane-leaf" && e.leafKind === "terminal";
  const branch = useGitBranch(
    isTerminal && (!isSshLeaf || sshSessionId !== undefined) ? cwd : undefined,
    sshSessionId,
  );

  /**
   * A tab opened on a worktree is NAMED after its project, so under a group
   * header of the same name the panel said "pokehub" three lines running while
   * the thing that actually tells the two rows apart - the branch - sat in
   * small grey text underneath. Where they duplicate, the branch is promoted to
   * the row and the second line drops.
   *
   * Only on an exact match, so a renamed tab or a differently-named pane keeps
   * the label the tab strip shows for it.
   */
  const repeatsProject = projectName !== undefined && e.label === projectName && !!branch;

  // While renaming, the field replaces the row's button entirely: an <input>
  // inside a <button> is invalid, and a click on the field would activate the
  // row underneath it.
  if (renaming && e.kind === "pane-leaf") {
    return (
      <li className={cn("flex h-6 items-center gap-1.5 pr-1.5", nested ? "pl-11" : "pl-7")}>
        <EntryIcon entry={e} />
        <InlineInput
          // Same seed as the tab strip: the name without the kind tag.
          initial={e.renameSeed}
          placeholder="Tab name"
          onCommit={(value) => {
            onSetRenaming(null);
            // Blank means "back to the derived name", not an empty tab.
            onRename?.(e.leafId, value.trim() ? value : null);
          }}
          onCancel={() => onSetRenaming(null)}
        />
      </li>
    );
  }

  const rowButton = (
    <button
      type="button"
      onClick={onOpen}
      onDoubleClick={() => {
        if (canRename && e.kind === "pane-leaf") onSetRenaming(e.leafId);
      }}
      className={cn(
        "flex w-full flex-col justify-center text-left text-[11px] transition-colors",
        // Make room for the hover actions so they never sit on top of the label.
        // Each size-5 button reserves 5.
        actionCount === 1 && "group-hover/row:pr-5",
        actionCount === 2 && "group-hover/row:pr-10",
        actionCount === 3 && "group-hover/row:pr-15",
        isActiveLeaf
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_var(--ring)]"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/40",
      )}
    >
      <span
        className={cn("flex h-6 w-full items-center gap-1.5 pr-1.5", nested ? "pl-11" : "pl-7")}
      >
        <EntryIcon entry={e} />
        {repeatsProject ? (
          <GitBranch size={10} strokeWidth={2} className="text-icon-branch shrink-0" />
        ) : null}
        <span className={cn("min-w-0 flex-1 truncate text-left", entryLabelClass(e))}>
          {repeatsProject ? branch : e.label}
          {showTitle ? <span className="opacity-60"> · {title}</span> : null}
        </span>
        {e.dirty ? <span className="bg-foreground/60 size-1.5 shrink-0 rounded-full" /> : null}
        {/* Snoozed tabs are off the strip, so this list is the only place
            they show; the clock says why this row has no chip up top. */}
        {/* Hidden on hover, where the action cluster shows its own clock. */}
        {e.snoozed ? (
          <AlarmClock
            size={11}
            strokeWidth={1.75}
            className={cn(
              "text-muted-foreground shrink-0",
              actionCount > 0 && "group-hover/row:hidden",
            )}
          />
        ) : null}
      </span>
      {/* Branch of this pane's working directory. Absent entirely outside a
          repository, rather than a placeholder row saying nothing. Indented to
          the label, so the branch reads as belonging to the row above it. */}
      {branch && !repeatsProject ? (
        <span
          className={cn(
            "text-muted-foreground flex w-full items-center gap-1 pr-1.5 pb-0.5 text-[10px]",
            nested ? "pl-[2.6rem]" : "pl-[1.6rem]",
          )}
        >
          <GitBranch size={9} strokeWidth={2} className="text-icon-branch shrink-0" />
          <span className="min-w-0 truncate">{branch}</span>
        </span>
      ) : null}
    </button>
  );

  // The action cluster is a SIBLING of the row button, not a child: nesting one
  // button inside another is invalid HTML and the inner one would swallow the
  // row's own click. Same hover-reveal treatment the workspace row above uses.
  //
  // The right-click lives on THIS row rather than on the workspace above it: a
  // workspace can hold panes in two different projects, so only a row knows
  // which repository a new worktree would belong to. Radix triggers compose, so
  // the context trigger and the tooltip trigger can both own the same button.
  const inner = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {onNewWorktree ? <ContextMenuTrigger asChild>{rowButton}</ContextMenuTrigger> : rowButton}
        </TooltipTrigger>
        {/* Styled tooltip, not the native `title` attribute this list used to
            carry: that renders as an unthemed OS box on its own timing, the one
            odd tooltip among all the themed ones in this panel. */}
        <TooltipContent side="right">
          <div className="flex flex-col gap-0.5">
            <span>{e.label}</span>
            {cwd ? <span className="text-muted-foreground">{cwd}</span> : null}
            {sshStatus ? (
              <span className={statusLabelClass(sshStatus) || "text-muted-foreground"}>
                {statusLabel(sshStatus)}
              </span>
            ) : null}
            {ai ? <span className="text-muted-foreground">{aiCliLabel(ai)}</span> : null}
            {isPrivate ? (
              <span className="text-destructive">Not visible to the native AI agent</span>
            ) : null}
            {e.snoozed ? (
              <span className="text-muted-foreground">Snoozed: hidden from the tab strip</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
      {actionCount > 0 && (
        // `top-1` (not a centered translate): a row carrying a branch line is
        // two lines tall, and these belong beside the NAME they act on, not
        // floating between the two.
        // `pointer-events-none` until the row is hovered, like the workspace row
        // above: at opacity-0 these are invisible but still hit-testable, and an
        // invisible close X sitting over a tab name is a click away from a
        // close nobody asked for.
        <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100">
          {onToggleSnooze && (
            <IconTooltip label={e.snoozed ? "Unsnooze" : "Snooze"} side="right">
              <Button
                onClick={onToggleSnooze}
                aria-label={`${e.snoozed ? "Unsnooze" : "Snooze"} ${e.label}`}
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground size-5 rounded"
              >
                {e.snoozed ? (
                  <AlarmClockOff size={11} strokeWidth={1.75} />
                ) : (
                  <AlarmClock size={11} strokeWidth={1.75} />
                )}
              </Button>
            </IconTooltip>
          )}
          {canRename && (
            <IconTooltip label="Rename" side="right">
              <Button
                onClick={() => {
                  if (e.kind === "pane-leaf") onSetRenaming(e.leafId);
                }}
                aria-label={`Rename ${e.label}`}
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground size-5 rounded"
              >
                <Pencil size={11} strokeWidth={1.75} />
              </Button>
            </IconTooltip>
          )}
          {onRequestClose && (
            <IconTooltip label="Close tab" side="right">
              <Button
                onClick={onRequestClose}
                aria-label={`Close ${e.label}`}
                variant="ghost"
                size="icon-sm"
                className={cn(DESTRUCTIVE_ACTION, "size-5 rounded")}
              >
                <X size={11} strokeWidth={2} />
              </Button>
            </IconTooltip>
          )}
        </span>
      )}
    </>
  );

  return (
    <li className="group/row relative">
      {onNewWorktree ? (
        <ContextMenu>
          {inner}
          <ContextMenuContent className="min-w-44">
            <ContextMenuItem onSelect={onNewWorktree}>New Worktree</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        inner
      )}
    </li>
  );
}
