import { PanelSearchInput } from "@/components/PanelSearchInput";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION, HEADER_TOGGLE_ACTIVE, HEADER_TOGGLE_IDLE } from "@/lib/toolbarButton";
import { AgentSessionsPanel } from "@/modules/agentSessions/AgentSessionsPanel";
import { mostUrgent, type AgentRow } from "@/modules/agentSessions/api";
import { type Tab } from "@/modules/tabs";
import { buildEntries, entryMatches } from "@/modules/tabs/lib/entries";
import { localOps } from "@/modules/scm/api";
import { WorktreeDialog } from "@/modules/scm/components/WorktreeDialog";
import { openWorktree } from "@/modules/scm/worktreeBridge";
import { createWorktreeAndOpen } from "@/modules/scm/worktreeCreate";
import { localWorktreeOps, mainWorktreePath, type Worktree } from "@/modules/scm/worktrees";
import { toForwardSlash } from "@/lib/path";
import { useSshHosts, type SshConnection } from "@/modules/ssh/connections";
import { type SshStatus } from "@/modules/ssh/status";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { coldIdAllocator, countSavedTabEntries, restoreTabs } from "./serialize";
import {
  SortableWorkspaceRow,
  WorkspaceAvatar,
  type EntryRow,
  type LeafRef,
  type WorkspaceAddition,
} from "./WorkspaceRow";
import { useWorkspacesStore, type SavedPaneNode, type SavedTab, type Workspace } from "./store";
import { LayoutDashboard, PanelLeft, PanelRight, Pin, Plus, Search, X } from "lucide-react";

type Props = {
  /** Pick a workspace. Caller must snapshot current tabs and rehydrate the new one. */
  onSwitch: (workspaceId: string) => void;
  /** Plus button. Caller seeds a new tab strip. */
  onCreate: () => void;
  /** Open something new inside a workspace, going to it first if need be. */
  onAddToWorkspace: (workspaceId: string, what: WorkspaceAddition, leaf?: LeafRef) => void;
  /** Close a workspace. Caller discards its live tabs and rehydrates the neighbor. */
  onClose: (workspaceId: string) => void;
  /**
   * Live tab-strip entry count per workspace id (one per pane leaf, so a split
   * group tab counts its panes; plus every standalone/session-only diff / scm /
   * extension tab the persisted snapshot drops). Covers every workspace visited
   * this session. Workspaces not present here (restored from disk, not yet
   * opened) fall back to `countSavedTabEntries` over their persisted tabs.
   */
  tabCounts?: Record<string, number>;
  /**
   * Live tabs of the ACTIVE workspace (the runtime tab strip). Used to list the
   * active workspace's open terminals with live status when its row is
   * expanded. Inactive workspaces read their persisted `tabs` instead.
   */
  liveTabs?: Tab[];
  /**
   * Live tab trees of every workspace visited this session, keyed by workspace
   * id (the App-owned cache). Lets an inactive-but-cached workspace list its
   * terminals with live AI CLI status, since its leaf ids still match running
   * sessions. A cold (never-opened) workspace is absent here and falls back to
   * its persisted snapshot, which carries no live status.
   */
  cachedTabsByWorkspace?: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
  /** Focus a live entry: activates its tab, and the pane inside it for a leaf.
   *  Standalone tabs (SCM, diffs, extension tabs) pass a leaf id no tree holds,
   *  which the tab side already ignores, so they just activate. */
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  /** Rename a live pane leaf, or reset it to the derived name with `null`. Same
   *  handler the tab strip's right-click Rename uses, so both write one field. */
  onRenameLeaf?: (leafId: number, title: string | null) => void;
  /** Snooze or wake a live tab. Same handler as the tab strip right-click. */
  onSetTabSnoozed?: (tabId: number, snoozed: boolean) => void;
  /**
   * Close one listed tab / pane. `leafId` is null for a standalone tab (SCM, a
   * diff, an extension tab) - the same signature and the same handler the tab
   * strip's X uses, so a close from here also gets the busy-terminal and
   * unsaved-editor confirms rather than a second, weaker code path.
   */
  onCloseEntry?: (tabId: number, leafId: number | null) => void;
  /** Currently focused leaf id; highlights its row like the file tree. */
  activeLeafId?: number | null;
  /** Live SSH status per leaf. Colors a connected host's label green here
   *  exactly as it does in the tab strip. */
  sshStatuses?: Map<number, SshStatus>;
  /** Drag handle for sidebar-section reordering, injected by the sidebar. */
  dragHandle?: ReactNode;
  /** Collapsed to its header: its Agents and History lists read nothing. */
  collapsed?: boolean;
  /** Left-sidebar instance: move Workspaces to the shared right panel. */
  onMoveToRight?: () => void;
  /** Right-panel instance: dock Workspaces back into the left sidebar. */
  onMoveToLeft?: () => void;
  /** Right-panel instance: close the docked panel (distinct from `onClose`,
   *  which closes a workspace). */
  onClosePanel?: () => void;
};

const EMPTY_TABS: Tab[] = [];

/** Rows for a workspace whose tabs are live (active, or visited this session). */
function liveRows(
  tabs: Tab[],
  sshHosts: Map<string, SshConnection>,
  sshStatuses: Map<number, SshStatus> | undefined,
  aiStatuses: Map<number, AiCliStatus>,
  titles: Record<number, string>,
): EntryRow[] {
  return buildEntries(tabs, sshHosts, sshStatuses, aiStatuses).map((entry) => ({
    entry,
    title: entry.kind === "pane-leaf" ? titles[entry.leafId] : undefined,
    live: true,
  }));
}

/**
 * Rows for a workspace never opened this session: rehydrate the snapshot into
 * throwaway tabs and run them through the same builder, so a cold workspace
 * names its panes exactly like a live one. Its NEGATIVE ids are display-only and
 * never match `activeLeafId`; they are the ones the agent status minted too.
 */
function savedRows(
  tabs: SavedTab[],
  sshHosts: Map<string, SshConnection>,
  index: number,
): EntryRow[] {
  const entries = buildEntries(restoreTabs(tabs, coldIdAllocator(index)), sshHosts);
  const titles = savedTitles(tabs);
  return entries.map((entry, i) => ({ entry, title: titles[i], live: false }));
}

/**
 * Persisted OSC titles in the same depth-first order `buildEntries` emits, to be
 * zipped onto a cold workspace's rows. Live terminals read their title from the
 * store by leaf id; a restored one has no live id yet and restore drops the
 * field (it is live state), so position is what's left to pair them by.
 */
function savedTitles(tabs: SavedTab[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  const walk = (node: SavedPaneNode) => {
    if (node.kind === "split") {
      node.children.forEach(walk);
      return;
    }
    out.push(node.leafKind === "terminal" ? node.title : undefined);
  };
  for (const t of tabs) {
    // A non-pane tab (including the legacy "preview" kind, which restores as
    // nothing) still contributes exactly one slot, so the two lists stay aligned.
    if (t.kind === "pane") walk(t.paneTree);
    else out.push(undefined);
  }
  return out;
}

const LIST_HEIGHT_KEY = "tedi.workspaces.listHeight";

// Memoized. Props are stable callbacks plus the counts map, so shallow equality skips re-renders.
function WorkspacesPanelInner({
  onSwitch,
  onCreate,
  onClose,
  onAddToWorkspace,
  tabCounts,
  liveTabs,
  cachedTabsByWorkspace,
  onFocusLeaf,
  onRenameLeaf,
  onSetTabSnoozed,
  onCloseEntry,
  activeLeafId,
  sshStatuses,
  dragHandle,
  collapsed,
  onMoveToRight,
  onMoveToLeft,
  onClosePanel,
}: Props) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const rename = useWorkspacesStore((s) => s.renameWorkspace);
  const setPinned = useWorkspacesStore((s) => s.setWorkspacePinned);
  const reorder = useWorkspacesStore((s) => s.reorderWorkspaces);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Leaf whose row is currently showing its rename field, or null. Separate from
  // `editingId` above (a WORKSPACE name) - the two edit different things and can
  // never be open at once anyway.
  const [renamingLeafId, setRenamingLeafId] = useState<number | null>(null);
  // dnd-kit active drag id (workspace id), or null when not dragging.
  const [dragId, setDragId] = useState<string | null>(null);
  // Which workspace rows are expanded to reveal their tabs (session-only).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // One box for all three lists: workspaces and their tabs, agents, history. It stays
  // shut until asked for, like the one in Files, and closing it ends the search.
  const [searching, setSearching] = useState(false);
  // Height the user dragged the Workspaces list to, so expanding a row stops moving
  // History up and down. Null until first dragged: the list sizes to its rows.
  const [listHeight, setListHeight] = useState<number | null>(() => {
    const n = Number(localStorage.getItem(LIST_HEIGHT_KEY));
    return n > 0 ? n : null;
  });
  const listRef = useRef<HTMLDivElement>(null);
  const startListResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const box = listRef.current;
    const panel = box?.parentElement;
    if (!box || !panel) return;
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const startY = ev.clientY;
    const startH = box.getBoundingClientRect().height;
    // Leave History its header plus a little list.
    const maxH = panel.getBoundingClientRect().bottom - box.getBoundingClientRect().top - 64;
    let h = startH;
    const move = (e: PointerEvent) => {
      h = Math.round(Math.min(Math.max(startH + e.clientY - startY, 48), Math.max(48, maxH)));
      setListHeight(h);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      // A plain click (or the first half of the double-click reset) moved nothing.
      if (h !== startH) localStorage.setItem(LIST_HEIGHT_KEY, String(h));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const closeSearch = () => {
    setSearching(false);
    setSearch("");
  };

  /**
   * Worktrees per PROJECT FOLDER, loaded when a workspace row is expanded rather
   * than polled. `git worktree list` is a subprocess and the list only changes
   * when someone acts on it, so reading it on each expand is both cheap and
   * enough - one made from Source Control's own menu turns up the next time the
   * row is opened. Keyed by cwd, not by workspace, because a workspace can hold
   * two projects and they have nothing to do with each other.
   */
  const [worktrees, setWorktrees] = useState<Record<string, Worktree[]>>({});
  /**
   * Which project the create dialog is for, with its MAIN worktree already
   * resolved. Resolved BEFORE opening rather than inside: the dialog derives the
   * suggested folder from this path, and a terminal's cwd is routinely a linked
   * worktree once anyone has opened one, which would suggest a folder nested
   * inside it.
   */
  const [newWorktreeFor, setNewWorktreeFor] = useState<{
    wsId: string;
    cwd: string;
    repoRoot: string;
  } | null>(null);

  const loadWorktrees = useCallback(async (cwd: string): Promise<Worktree[]> => {
    let list: Worktree[] = [];
    try {
      list = await localWorktreeOps(cwd).list();
    } catch {
      // Not a repository, or no git. Either way there is nothing to list, and
      // these rows are a decoration on a folder - never an error to report.
    }
    setWorktrees((prev) => ({ ...prev, [cwd]: list }));
    return list;
  }, []);

  /** Open the create dialog for the project a row sits in. */
  const startNewWorktree = useCallback(
    (wsId: string, cwd: string) => {
      void loadWorktrees(cwd).then((fresh) =>
        setNewWorktreeFor({ wsId, cwd, repoRoot: mainWorktreePath(fresh, cwd) }),
      );
    },
    [loadWorktrees],
  );

  /** Branch list for the create dialog, from the project it was opened for. */
  const loadBranchesForNew = useCallback(
    () => (newWorktreeFor ? localOps(newWorktreeFor.repoRoot).branches() : Promise.resolve([])),
    [newWorktreeFor],
  );

  const startEdit = (id: string, current: string) => {
    setEditingId(id);
    setDraft(current);
  };
  const commitEdit = () => {
    if (editingId && draft.trim()) rename(editingId, draft.trim());
    setEditingId(null);
    setDraft("");
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 5px activation distance so a plain click still switches / a double-click
  // still renames; only a real drag starts the reorder. Mirrors the tab strip.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const sortableIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const draggedWorkspace = dragId ? (workspaces.find((w) => w.id === dragId) ?? null) : null;

  // Per-leaf terminal titles (OSC 2), e.g. a running agent's title.
  const titles = useTerminalTitles((s) => s.titles);
  // Live AI CLI status per leaf, written by every running session's detector
  // regardless of attach state - so a hidden workspace's spinner survives.
  const statuses = useAiCliStatuses((s) => s.statuses);
  // Saved hosts, so an SSH pane reads `ssh:<name>` here as it does in the strip.
  const sshHosts = useSshHosts();
  // The strip's entry builder takes a Map; the store keeps a Record so a status
  // push rewrites one key instead of the whole map.
  const aiStatuses = useMemo(
    () => new Map<number, AiCliStatus>(Object.entries(statuses).map(([id, s]) => [Number(id), s])),
    [statuses],
  );
  // Rows for any workspace: the active one reads the freshest live tabs; an
  // inactive-but-cached one reads its cached live tabs (leaf ids still match
  // running sessions, so status resolves); a cold workspace rehydrates its
  // persisted snapshot, which carries no live status.
  const rowsFor = (w: Workspace, index: number): EntryRow[] => {
    if (w.id === activeId && liveTabs)
      return liveRows(liveTabs, sshHosts, sshStatuses, aiStatuses, titles);
    const cached = cachedTabsByWorkspace?.current.get(w.id);
    if (cached && cached.tabs.length > 0)
      return liveRows(cached.tabs, sshHosts, sshStatuses, aiStatuses, titles);
    return savedRows(w.tabs, sshHosts, index);
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    setDragId(null);
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tedi-panel-header">
        {dragHandle}
        <LayoutDashboard size={13} strokeWidth={2} className="text-muted-foreground shrink-0" />
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">Workspaces</span>
        <span className="tedi-header-divider" aria-hidden />
        <IconTooltip label="Search workspaces, agents and history" side="bottom">
          <Button
            onClick={() => (searching ? closeSearch() : setSearching(true))}
            aria-label="Search workspaces, agents and history"
            aria-pressed={searching}
            variant="ghost"
            size="icon"
            className={cn(searching ? HEADER_TOGGLE_ACTIVE : HEADER_TOGGLE_IDLE, "size-6")}
          >
            <Search size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        <IconTooltip label="New workspace" side="bottom">
          <Button
            onClick={onCreate}
            aria-label="New workspace"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
          >
            <Plus size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        {onMoveToRight ? (
          <IconTooltip label="Move to right panel" side="bottom">
            <Button
              onClick={onMoveToRight}
              aria-label="Move Workspaces to the right panel"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <PanelRight size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {onMoveToLeft ? (
          <IconTooltip label="Move to left sidebar" side="bottom">
            <Button
              onClick={onMoveToLeft}
              aria-label="Move Workspaces to the left sidebar"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <PanelLeft size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {onClosePanel ? (
          <IconTooltip label="Close panel" side="bottom">
            <Button
              onClick={onClosePanel}
              aria-label="Close Workspaces panel"
              variant="ghost"
              size="icon"
              className={cn(DESTRUCTIVE_ACTION, "size-6")}
            >
              <X size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      {searching ? (
        <PanelSearchInput
          value={search}
          onChange={setSearch}
          onClose={closeSearch}
          placeholder="Search workspaces, agents, history"
        />
      ) : null}
      {/* One list for workspaces and their agents: each pane row carries its agent's
          state, and a workspace row the most urgent of them. */}
      <AgentSessionsPanel
        collapsed={collapsed}
        filter={search}
        liveTabs={liveTabs ?? EMPTY_TABS}
        cachedTabsByWorkspace={cachedTabsByWorkspace}
        activeLeafId={activeLeafId}
      >
        {(agents: AgentRow[], elsewhere: ReactNode) => (
          <>
            {/* Capped by a wrapper, not on the ScrollArea: its viewport inherits a
              max-height, and a percentage would resolve a second time against it. */}
            <div
              ref={listRef}
              style={listHeight ? { height: listHeight } : undefined}
              className={cn("relative flex min-h-0 flex-col", !listHeight && "max-h-[60%]")}
            >
              <ScrollArea className="min-h-0 flex-1">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={(ev) => setDragId(String(ev.active.id))}
                  onDragEnd={handleDragEnd}
                  onDragCancel={() => setDragId(null)}
                >
                  <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                    {/* pr-2.5 reserves the 10px Radix ScrollArea overlay-thumb width so the
                    row's rename/close buttons and tab-count pill clear the scrollbar. */}
                    <ul className="p-1 pr-2.5">
                      {workspaces.map((w, index) => {
                        // Built once per row: the tab list and the worktree lookups read
                        // the same entries.
                        const rows = rowsFor(w, index);
                        const wsAgents = agents.filter((a) => a.pane.workspaceId === w.id);
                        // A name hit keeps the row as it was. A hit on a tab alone opens
                        // the row and lists just the tabs that hit.
                        const byTab = !!query && !w.name.toLowerCase().includes(query);
                        if (byTab && !rows.some((r) => entryMatches(r.entry, r.title, query)))
                          return null;
                        return (
                          <SortableWorkspaceRow
                            key={w.id}
                            workspace={w}
                            isActive={w.id === activeId}
                            isEditing={editingId === w.id}
                            isExpanded={byTab || expanded.has(w.id)}
                            draft={draft}
                            tabCount={tabCounts?.[w.id] ?? countSavedTabEntries(w.tabs)}
                            rows={rows}
                            agents={new Map(wsAgents.map((a) => [a.pane.leafId, a]))}
                            agentState={mostUrgent(wsAgents)}
                            rowQuery={byTab ? query : ""}
                            canClose={workspaces.length > 1}
                            // Editing a name needs an interactive input, so suspend drag
                            // for the row - whether it is the workspace name or a tab's.
                            // A filtered list has no true neighbours to reorder against.
                            sortable={editingId !== w.id && renamingLeafId === null && !query}
                            onSwitch={onSwitch}
                            onClose={onClose}
                            onAdd={onAddToWorkspace}
                            onStartEdit={startEdit}
                            onSetPinned={setPinned}
                            onDraftChange={setDraft}
                            onCommitEdit={commitEdit}
                            onCancelEdit={cancelEdit}
                            onToggleExpanded={toggleExpanded}
                            onFocusLeaf={onFocusLeaf}
                            onRenameLeaf={onRenameLeaf}
                            onSetTabSnoozed={onSetTabSnoozed}
                            onCloseEntry={onCloseEntry}
                            renamingLeafId={renamingLeafId}
                            onSetRenamingLeaf={setRenamingLeafId}
                            activeLeafId={activeLeafId}
                            worktrees={worktrees}
                            onLoadWorktrees={loadWorktrees}
                            onNewWorktree={(cwd) => {
                              // Creating one opens a tab, and a tab lands in the ACTIVE
                              // workspace - so switch first, which the user has time for
                              // while the dialog is up.
                              if (w.id !== activeId) onSwitch(w.id);
                              startNewWorktree(w.id, cwd);
                            }}
                            onOpenWorktree={(wt, list) => {
                              // Focusing addresses LIVE tabs, which only the active
                              // workspace has; an inactive one switches first, exactly
                              // as its listed tab rows already do.
                              if (w.id !== activeId) {
                                onSwitch(w.id);
                                return;
                              }
                              const open = rows.find(
                                (r) =>
                                  r.entry.kind === "pane-leaf" &&
                                  r.entry.cwd !== undefined &&
                                  toForwardSlash(r.entry.cwd) === wt.path,
                              );
                              if (open?.entry.kind === "pane-leaf" && onFocusLeaf) {
                                onFocusLeaf(open.entry.tabId, open.entry.leafId);
                                return;
                              }
                              openWorktree(wt, list);
                            }}
                          />
                        );
                      })}
                    </ul>
                    {elsewhere}
                  </SortableContext>
                  <DragOverlay dropAnimation={null}>
                    {draggedWorkspace && (
                      <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-7 cursor-grabbing items-center gap-1.5 rounded px-1.5 text-xs shadow-lg ring-1 backdrop-blur-sm">
                        <WorkspaceAvatar workspace={draggedWorkspace} />
                        {draggedWorkspace.pinned && (
                          <Pin
                            aria-hidden
                            size={10}
                            strokeWidth={2.25}
                            className="shrink-0 opacity-70"
                          />
                        )}
                        <span className="truncate">{draggedWorkspace.name}</span>
                      </div>
                    )}
                  </DragOverlay>
                </DndContext>
              </ScrollArea>
              {/* Drag to size the list against History; double-click goes back to auto.
                  Keep the grab area wider than the 1px hover line. */}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize Workspaces list"
                onPointerDown={startListResize}
                onDoubleClick={() => {
                  setListHeight(null);
                  localStorage.removeItem(LIST_HEIGHT_KEY);
                }}
                className="hover:after:bg-ring/60 absolute inset-x-0 -bottom-0.5 z-10 h-1 cursor-row-resize after:pointer-events-none after:absolute after:inset-x-0 after:top-0.5 after:h-px after:transition-colors"
              />
            </div>
          </>
        )}
      </AgentSessionsPanel>

      {/* One dialog for the panel, not one per row: only ever a single create is
          pending, and mounting one per workspace would hydrate the CLI-agent
          roster once per row. Unmounted when closed, so it starts clean. */}
      {newWorktreeFor ? (
        <WorktreeDialog
          open
          onOpenChange={(o) => {
            if (!o) setNewWorktreeFor(null);
          }}
          repoRoot={newWorktreeFor.repoRoot}
          worktrees={worktrees[newWorktreeFor.cwd] ?? []}
          loadBranches={loadBranchesForNew}
          onSubmit={async (input) => {
            const target = newWorktreeFor;
            const fresh = await createWorktreeAndOpen(target.repoRoot, input);
            setWorktrees((prev) => ({ ...prev, [target.cwd]: fresh }));
            // Expand it, or the row the user just added is behind a chevron.
            setExpanded((prev) => new Set(prev).add(target.wsId));
          }}
        />
      ) : null}
    </div>
  );
}

export const WorkspacesPanel = memo(WorkspacesPanelInner);
