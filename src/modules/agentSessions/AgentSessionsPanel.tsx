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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { IconSwap } from "@/components/IconMorph";
import { formatBytes } from "@/lib/format";
import { type HostWatch } from "@/lib/hostWatch";
import { basename, toForwardSlash } from "@/lib/path";
import { DESTRUCTIVE_ACTION, HEADER_TOGGLE_ACTIVE, HEADER_TOGGLE_IDLE } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { watchTree } from "@/modules/explorer/lib/treeWatch";
import { openWorktreeTab } from "@/modules/scm/worktreeBridge";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPinnedAgentSessions } from "@/modules/settings/store";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import {
  aiCliLabel,
  aiCliStateColorClass,
  type AiCliState,
} from "@/modules/terminal/lib/aiCliStatus";
import { useSshHosts, type SshConnection } from "@/modules/ssh/connections";
import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
import { restoreTabs } from "@/modules/workspaces/serialize";
import { useWorkspacesStore, type Workspace } from "@/modules/workspaces/store";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  Folder,
  FolderSearch,
  GitBranch,
  Layers,
  Pin,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  agentRows,
  agentSections,
  agentTitle,
  ago,
  canResume,
  coldStatus,
  deleteSession,
  folderKeyOf,
  historySections,
  listAllSessions,
  listRunningSessions,
  listSessions,
  mostUrgent,
  openSessions,
  PINNED_SECTION,
  renameSession,
  resumeCommand,
  resumeHint,
  SESSION_AGENTS,
  sessionKey,
  type AgentPane,
  type AgentRow,
  type AgentSession,
  type RunningSession,
  type SessionAgent,
} from "./api";

type LiveTabsCache = Map<string, { tabs: Tab[]; activeId: number | null }>;

type Props = {
  /** Collapsed to its header: skip the disk read / app-server spawn entirely. */
  collapsed?: boolean;
  /** The Workspaces section's one search box. */
  filter: string;
  liveTabs: Tab[];
  cachedTabsByWorkspace?: RefObject<LiveTabsCache>;
  activeLeafId?: number | null;
  onSwitch: (workspaceId: string) => void;
  onFocusLeaf?: (tabId: number, leafId: number) => void;
};

// Survives a collapse and a move between columns (both remount the panel), so
// reopening paints the last list at once and refreshes underneath.
let cached: AgentSession[] | null = null;
// What the user folded, kept the same way. Idle starts shut: it needs nobody.
let foldedAgents = new Set<string>(["idle"]);
let foldedDays = new Set<string>();
let agentsOpenCache = true;
let historyOpenCache = true;
let onlyFolderCache = false;
const SECTION_PAGE = 50;
const AGENTS_TICK_MS = 30_000;
const LIVENESS_MS = 3_000;
const AGENTS_SORT_KEY = "tedi:agents:sort";

const togglePin = (key: string) => {
  const pins = usePreferencesStore.getState().pinnedAgentSessions;
  void setPinnedAgentSessions(pins.includes(key) ? pins.filter((k) => k !== key) : [key, ...pins]);
};

const agentLabel = (a: SessionAgent) => SESSION_AGENTS.find((x) => x.id === a)?.label ?? a;

/** A pane per terminal in every workspace, live or restored from its snapshot. */
function allPanes(
  workspaces: Workspace[],
  activeWorkspace: string | null,
  liveTabs: Tab[],
  cache: LiveTabsCache | undefined,
  statuses: ReturnType<typeof useAiCliStatuses.getState>["statuses"],
  hosts: Map<string, SshConnection>,
  alivePtys: string[],
): AgentPane[] {
  // Same throwaway NEGATIVE ids as the panel's cold rows: they must never match a
  // live leaf.
  let next = -1;
  const allocId = () => next--;
  const out: AgentPane[] = [];
  for (const w of workspaces) {
    const isActive = w.id === activeWorkspace;
    const hit = isActive ? undefined : cache?.get(w.id);
    const cold = !isActive && !hit?.tabs.length;
    const tabs = isActive ? liveTabs : cold ? restoreTabs(w.tabs, allocId) : (hit?.tabs ?? []);
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal") continue;
        // A remote pane's path is on another machine, so it matches no local session.
        const remote = !!l.sshConnectionId;
        const ptyId = remote ? null : (l.ptyId ?? l.savedPtyId ?? null);
        out.push({
          leafId: l.id,
          tabId: t.id,
          workspaceId: w.id,
          cold,
          ptyId,
          cwd: remote ? null : (l.cwd ?? null),
          customTitle: l.customTitle ?? null,
          host: l.sshConnectionId ? (hosts.get(l.sshConnectionId)?.name ?? null) : null,
          status: statuses[l.id] ?? (cold ? coldStatus(l.activeTool, ptyId, alivePtys) : null),
        });
      }
    }
  }
  return out;
}

/**
 * Round, as svgs: globals.css squares every element's border-radius, and a square
 * ring reads as a checkbox. A row shows its state as this and the colour of its
 * agent's icon, with no word on screen; the word is for a screen reader and the
 * tooltip.
 */
function StatusGlyph({ state }: { state: AiCliState }) {
  const box = cn("flex w-3.5 shrink-0 justify-center", aiCliStateColorClass(state));
  const word = STATE_WORD[state];
  switch (state) {
    case "working":
      return (
        <span role="img" aria-label={word} className={box}>
          <Spinner aria-hidden role="presentation" className="size-3" />
        </span>
      );
    case "blocking":
      return (
        <span role="img" aria-label={word} className={box}>
          <CircleAlert size={13} strokeWidth={2.25} />
        </span>
      );
    case "done":
      return (
        <span role="img" aria-label={word} className={box}>
          <Circle size={10} fill="currentColor" strokeWidth={0} />
        </span>
      );
    case "idle":
      return (
        <span role="img" aria-label={word} className={box}>
          <Circle size={10} strokeWidth={2.5} />
        </span>
      );
  }
}

const STATE_WORD: Record<AiCliState, string> = {
  blocking: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

/** The second line of a row: where it ran. */
function PlaceLine({ place, branch }: { place: string | null; branch: string | null }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {place ? (
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <Folder size={9} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{place}</span>
        </span>
      ) : null}
      {branch ? (
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <GitBranch size={9} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
    </span>
  );
}

const SECTION_LABEL_COLOR: Record<AiCliState, string> = {
  blocking: "text-icon-blocked",
  done: "text-icon-done",
  working: "text-icon-working",
  idle: "text-muted-foreground",
};

function BlockHeader({
  label,
  hint,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  /** What this list is, for someone seeing it the first time. */
  hint: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    // A band, so Agents and History read as their own lists and not as more rows of
    // the one above. Their group headings stay plain text one level below it.
    // pr-4 keeps its chevron in one column with those of the rows and groups around it.
    <div className="border-border/60 bg-muted/40 flex h-7 shrink-0 items-center gap-0.5 border-y pr-4 pl-1.5">
      <IconTooltip label={hint} side="bottom" delayDuration={500} contentClassName="max-w-xs">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="text-foreground/85 hover:text-foreground focus-visible:text-foreground flex h-full min-w-0 flex-1 items-center gap-1 px-1 text-[11px] font-semibold outline-none"
        >
          <span className="truncate">{label}</span>
          <span className="font-normal tabular-nums opacity-70">{count}</span>
        </button>
      </IconTooltip>
      {children}
      {/* Its own button, since the actions above sit between it and the label. */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
        className="text-foreground/60 hover:text-foreground focus-visible:text-foreground flex size-4 shrink-0 items-center justify-center outline-none"
      >
        <ChevronRight
          size={11}
          strokeWidth={2.25}
          className={cn("transition-transform", open && "rotate-90")}
        />
      </button>
    </div>
  );
}

function SectionHeading({
  label,
  count,
  open,
  onToggle,
  className,
  trailing,
  action,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  className: string;
  /** Beside the count. */
  trailing?: ReactNode;
  /** Revealed on hover over the count, outside the toggle since buttons cannot nest. */
  action?: ReactNode;
}) {
  return (
    <h3 className="group/heading relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "hover:text-foreground focus-visible:text-foreground flex h-6 w-full items-center gap-1 px-1.5 text-[11px] font-normal outline-none",
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {trailing}
        <span
          className={cn(
            "font-normal tabular-nums opacity-70",
            action && "group-hover/heading:invisible",
          )}
        >
          {count}
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center opacity-60">
          <ChevronRight
            size={11}
            strokeWidth={2.25}
            className={cn("transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      {action}
    </h3>
  );
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * The Agents list: one entry per pane running an AI CLI, most urgent first or
 * by workspace. A click goes to that pane and never starts anything. Idle starts
 * folded, but the focused pane stays on screen whatever its state, so the terminal
 * in front of you can always be found here.
 */
function AgentsBlock({
  rows,
  filter,
  activeLeafId,
  workspaces,
  folderNames,
  renaming,
  onRename,
  onStartRename,
  onCancelRename,
  onGo,
}: {
  rows: AgentRow[];
  filter: string;
  activeLeafId: number | null;
  workspaces: Workspace[];
  folderNames: (r: AgentRow) => string | null;
  renaming: string | null;
  onRename: (s: AgentSession, title: string) => void;
  onStartRename: (key: string) => void;
  onCancelRename: () => void;
  onGo: (pane: AgentPane) => void;
}) {
  const [open, setOpen] = useState(agentsOpenCache);
  const [folded, setFolded] = useState(foldedAgents);
  const [byWorkspace, setByWorkspace] = useState(
    () => localStorage.getItem(AGENTS_SORT_KEY) === "workspace",
  );
  const titles = useTerminalTitles((s) => s.titles);
  const pinnedKeys = usePreferencesStore((s) => s.pinnedAgentSessions);

  // Its "4m" goes stale with nothing else to re-render it.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const anyRows = rows.length > 0;
  useEffect(() => {
    if (!anyRows || !open) return;
    const timer = setInterval(tick, AGENTS_TICK_MS);
    return () => clearInterval(timer);
  }, [anyRows, open]);

  // Looking at a finished agent turns it idle, which would drop the row out from
  // under the click that opened it. See `agentSections`.
  const [heldDone, setHeldDone] = useState<number | null>(null);
  const focusedState = rows.find((r) => r.pane.leafId === activeLeafId)?.status.state;
  useEffect(() => {
    setHeldDone((prev) =>
      focusedState === "done" ? (activeLeafId ?? null) : prev === activeLeafId ? prev : null,
    );
  }, [focusedState, activeLeafId]);

  const q = filter.trim().toLowerCase();
  const titleOf = (r: AgentRow) => agentTitle(r, titles[r.pane.leafId]);
  const shown = q
    ? rows.filter((r) => `${titleOf(r)} ${r.pane.cwd ?? ""}`.toLowerCase().includes(q))
    : rows;
  const sections = agentSections(shown, {
    heldDone,
    pinnedKeys: new Set(pinnedKeys),
    workspaces: byWorkspace ? workspaces : null,
  });
  const now = Date.now();

  return (
    // Never squeezed below what it lists, short of its cap: this is the list that asks for attention.
    <div className="flex max-h-[40%] shrink-0 flex-col">
      <BlockHeader
        label="Agents"
        hint="Every AI CLI running right now, in any folder, most urgent first. Click one to go to its pane."
        count={shown.length}
        open={open}
        onToggle={() => setOpen((agentsOpenCache = !open))}
      >
        <IconTooltip
          label={
            byWorkspace
              ? "Grouped by workspace. Click to sort by urgency"
              : "Sorted by urgency. Click to group by workspace"
          }
          side="bottom"
        >
          <Button
            onClick={() => {
              localStorage.setItem(AGENTS_SORT_KEY, byWorkspace ? "urgency" : "workspace");
              setByWorkspace(!byWorkspace);
            }}
            aria-label="Group agents by workspace"
            aria-pressed={byWorkspace}
            variant="ghost"
            size="icon"
            className={cn("size-5", byWorkspace ? HEADER_TOGGLE_ACTIVE : HEADER_TOGGLE_IDLE)}
          >
            <Layers size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </BlockHeader>
      {open ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-1 pr-2.5 pb-1">
            {shown.length === 0 ? (
              <p className="text-muted-foreground px-1 py-1 text-[11px]">
                {q
                  ? "No matching agents."
                  : "No AI CLI is running. Start one in a terminal, or resume a session below."}
              </p>
            ) : null}
            {sections.map((sec) => {
              const isShut = !q && folded.has(sec.id);
              const hiddenTop = isShut && !sec.state ? mostUrgent(sec.rows) : null;
              return (
                <section key={sec.id}>
                  <SectionHeading
                    label={sec.label}
                    count={sec.rows.length}
                    open={!isShut}
                    className={sec.state ? SECTION_LABEL_COLOR[sec.state] : "text-muted-foreground"}
                    trailing={
                      hiddenTop && hiddenTop !== "idle" ? <StatusGlyph state={hiddenTop} /> : null
                    }
                    onToggle={() => {
                      const next = new Set(folded);
                      if (!next.delete(sec.id)) next.add(sec.id);
                      setFolded((foldedAgents = next));
                    }}
                  />
                  <ul className="flex flex-col gap-px">
                    {sec.rows
                      .filter((r) => !isShut || r.pane.leafId === activeLeafId)
                      .map((r) => {
                        const key = r.session ? sessionKey(r.session) : null;
                        const title = titleOf(r);
                        const folder = folderNames(r);
                        const isActive = r.pane.leafId === activeLeafId;
                        if (r.session && renaming === key) {
                          const s = r.session;
                          return (
                            <li key={r.pane.leafId} className="p-0.5">
                              <InlineInput
                                initial={s.title}
                                placeholder="Session name"
                                onCommit={(v) => onRename(s, v)}
                                onCancel={onCancelRename}
                              />
                            </li>
                          );
                        }
                        const pinned = key !== null && pinnedKeys.includes(key);
                        const workspace = workspaces.find((w) => w.id === r.pane.workspaceId);
                        const since = r.status.since > 0 ? ago(r.status.since, now) : null;
                        const outside = r.pane.workspaceId === null;
                        const row = (
                          <li key={r.pane.leafId} className="group/row relative">
                            <IconTooltip
                              side="right"
                              delayDuration={500}
                              contentClassName="max-w-sm"
                              label={
                                <span className="flex flex-col gap-0.5">
                                  <span className="font-medium break-words">{title}</span>
                                  <span className="opacity-70">
                                    {aiCliLabel(r.status)}
                                    {since ? ` for ${since}` : ""}
                                  </span>
                                  {r.session?.cwd || r.pane.cwd ? (
                                    <span className="break-all opacity-70">
                                      {r.session?.cwd ?? r.pane.cwd}
                                    </span>
                                  ) : null}
                                  {workspace ? (
                                    <span className="opacity-70">In {workspace.name}</span>
                                  ) : null}
                                  {r.session ? (
                                    <span className="font-mono text-[10px] opacity-50">
                                      {r.session.id}
                                    </span>
                                  ) : null}
                                  <span className="opacity-70">
                                    {outside
                                      ? "Running outside any pane here"
                                      : isActive
                                        ? "This is the focused pane"
                                        : "Click to go to its pane"}
                                  </span>
                                </span>
                              }
                            >
                              <button
                                type="button"
                                onClick={() => onGo(r.pane)}
                                onKeyDown={(e) => {
                                  if (e.key === "F2" && key) {
                                    e.preventDefault();
                                    onStartRename(key);
                                  }
                                }}
                                aria-current={isActive ? "true" : undefined}
                                aria-disabled={outside || undefined}
                                className={cn(
                                  "flex w-full flex-col gap-0.5 px-1.5 py-1 text-left outline-none",
                                  isActive
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_var(--ring)]"
                                    : "hover:bg-sidebar-accent/40 focus-visible:bg-sidebar-accent/40",
                                )}
                              >
                                <span className="flex w-full items-center gap-2 text-xs">
                                  <CliAgentIcon
                                    agentId={r.status.tool}
                                    size={13}
                                    className={cn("shrink-0", aiCliStateColorClass(r.status.state))}
                                  />
                                  <span
                                    className={cn(
                                      "min-w-0 flex-1 truncate",
                                      !isActive &&
                                        (r.status.state === "idle"
                                          ? "text-muted-foreground"
                                          : "text-sidebar-foreground/90"),
                                    )}
                                  >
                                    {title}
                                  </span>
                                  <StatusGlyph state={r.status.state} />
                                </span>
                                <span className="text-muted-foreground flex w-full items-center gap-2 pl-[21px] text-[10px] tabular-nums">
                                  <PlaceLine place={folder} branch={r.session?.branch ?? null} />
                                  {since ? <span className="shrink-0">{since}</span> : null}
                                </span>
                              </button>
                            </IconTooltip>
                          </li>
                        );
                        if (!r.session) return row;
                        const s = r.session;
                        return (
                          <ContextMenu key={r.pane.leafId}>
                            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem disabled={outside} onSelect={() => onGo(r.pane)}>
                                Go to pane
                              </ContextMenuItem>
                              <ContextMenuItem onSelect={() => togglePin(sessionKey(s))}>
                                {pinned ? "Unpin" : "Pin to the top"}
                              </ContextMenuItem>
                              <ContextMenuItem onSelect={() => onStartRename(sessionKey(s))}>
                                Rename session
                              </ContextMenuItem>
                              <ContextMenuItem onSelect={() => copy(s.id)}>
                                Copy session id
                              </ContextMenuItem>
                              <ContextMenuItem onSelect={() => copy(resumeCommand(s.agent, s.id))}>
                                Copy resume command
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        );
                      })}
                  </ul>
                </section>
              );
            })}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
}

const resume = (s: AgentSession) => {
  if (!canResume(s)) return;
  openWorktreeTab({
    path: toForwardSlash(s.cwd),
    title: s.title,
    command: resumeCommand(s.agent, s.id),
    tool: s.agent,
    inActivePane: true,
  });
};

/**
 * Every saved session a pane is not running, under day headings. One click (or
 * Enter) moves an idle terminal into the session's folder and resumes there, else
 * resumes in a split beside it. Hovering offers pin, rename and delete, F2 and
 * Delete do the same from the keyboard, right-click has the rest, and a day heading
 * can clear what it lists. Memoized, since a terminal title changing must not
 * re-render hundreds of rows.
 */
const HistoryBlock = memo(function HistoryBlock({
  sessions,
  loadError,
  filter,
  folderKey,
  openKeys,
  registryLoaded,
  renaming,
  onRename,
  onStartRename,
  onCancelRename,
  onDelete,
  onDeleteMany,
  onRefresh,
}: {
  sessions: AgentSession[] | null;
  loadError: string | null;
  filter: string;
  /** The focused terminal's folder, for "only this folder". */
  folderKey: string | null;
  openKeys: Set<string>;
  /** Once it has answered, whatever runs is in `openKeys` and not listed here. */
  registryLoaded: boolean;
  renaming: string | null;
  onRename: (s: AgentSession, title: string) => void;
  onStartRename: (key: string) => void;
  onCancelRename: () => void;
  onDelete: (s: AgentSession) => void;
  onDeleteMany: (batch: { label: string; list: AgentSession[] }) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(historyOpenCache);
  const [onlyFolder, setOnlyFolder] = useState(onlyFolderCache);
  const [folded, setFolded] = useState(foldedDays);
  const [shown, setShown] = useState<Record<string, number>>({});
  const setFold = (next: Set<string>) => setFolded((foldedDays = next));

  const pinnedKeys = usePreferencesStore((s) => s.pinnedAgentSessions);

  const scope = onlyFolder ? folderKey : null;
  const sections = useMemo(
    () =>
      historySections(sessions ?? [], {
        filter,
        folderKey: scope,
        openKeys,
        pinnedKeys: new Set(pinnedKeys),
        now: Date.now(),
      }),
    [sessions, filter, scope, openKeys, pinnedKeys],
  );
  const count = sections.reduce((n, sec) => n + sec.cards.length, 0);

  // A filter searches every section, so it opens them all while it is typed.
  const isFolded = (label: string) => !filter && folded.has(label);
  const allFolded = sections.length > 0 && sections.every((sec) => isFolded(sec.label));
  const now = Date.now();

  return (
    <div className={cn("flex min-h-0 flex-col", open && "min-h-16 flex-1")}>
      <BlockHeader
        label={scope ? `History · ${basename(scope) || scope}` : "History"}
        hint="Saved Claude Code and Codex sessions nothing is running. Click one to resume it."
        count={count}
        open={open}
        onToggle={() => setOpen((historyOpenCache = !open))}
      >
        <IconTooltip
          label={
            folderKey
              ? `Only sessions from ${basename(folderKey) || folderKey}`
              : "Only sessions from the focused terminal's folder"
          }
          side="bottom"
        >
          <Button
            onClick={() => setOnlyFolder((onlyFolderCache = !onlyFolder))}
            aria-label="Only the focused terminal's folder"
            aria-pressed={onlyFolder}
            variant="ghost"
            size="icon"
            className={cn("size-5", onlyFolder ? HEADER_TOGGLE_ACTIVE : HEADER_TOGGLE_IDLE)}
          >
            <FolderSearch size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
        {sections.length > 1 ? (
          <IconTooltip label={allFolded ? "Expand all" : "Collapse all"} side="bottom">
            <Button
              onClick={() =>
                setFold(allFolded ? new Set() : new Set(sections.map((sec) => sec.label)))
              }
              aria-label={allFolded ? "Expand all sections" : "Collapse all sections"}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-5"
            >
              <IconSwap
                active={allFolded ? 0 : 1}
                icons={[
                  <ChevronsUpDown size={12} strokeWidth={2} />,
                  <ChevronsDownUp size={12} strokeWidth={2} />,
                ]}
              />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label="Refresh" side="bottom">
          <Button
            onClick={onRefresh}
            aria-label="Refresh sessions"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-5"
          >
            <RefreshCw size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </BlockHeader>
      {open ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-1 pr-2.5 pb-1">
            {sessions === null ? (
              <p className="text-muted-foreground px-1 py-1 text-[11px]">Loading…</p>
            ) : loadError ? (
              <p className="text-muted-foreground px-1 py-1 text-[11px] break-words">{loadError}</p>
            ) : count === 0 ? (
              <p className="text-muted-foreground px-1 py-1 text-[11px]">
                {filter
                  ? "No session matches this search."
                  : scope
                    ? "No saved session from this folder."
                    : "No saved Claude Code or Codex sessions yet."}
              </p>
            ) : null}
            {sections.map((sec) => {
              // Pins were kept on purpose and a running session cannot go, so only
              // a day heading can clear what it lists.
              const clearable =
                sec.label === PINNED_SECTION
                  ? []
                  : sec.cards.map((c) => c.s).filter((s) => !s.live);
              return (
                <section key={sec.label}>
                  <SectionHeading
                    label={sec.label}
                    count={sec.cards.length}
                    open={!isFolded(sec.label)}
                    className="text-muted-foreground"
                    onToggle={() => {
                      const next = new Set(folded);
                      if (!next.delete(sec.label)) next.add(sec.label);
                      setFold(next);
                    }}
                    action={
                      clearable.length > 0 ? (
                        <IconTooltip label={`Delete these ${clearable.length}`} side="right">
                          <Button
                            onClick={() => onDeleteMany({ label: sec.label, list: clearable })}
                            aria-label={`Delete the ${clearable.length} sessions in ${sec.label}`}
                            variant="ghost"
                            size="icon-sm"
                            className={cn(
                              DESTRUCTIVE_ACTION,
                              "pointer-events-none absolute top-0.5 right-6 size-5 rounded opacity-0 group-hover/heading:pointer-events-auto group-hover/heading:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
                            )}
                          >
                            <Trash2 size={11} strokeWidth={1.75} />
                          </Button>
                        </IconTooltip>
                      ) : null
                    }
                  />
                  {/* Unmounted, not hidden, and paged: a heavy user has thousands of
                    sessions, each row a tooltip and a context menu. */}
                  <ul className="flex flex-col gap-px">
                    {(isFolded(sec.label)
                      ? []
                      : sec.cards.slice(0, shown[sec.label] ?? SECTION_PAGE)
                    ).map(({ s, folder }) => {
                      const key = sessionKey(s);
                      const live = !registryLoaded && s.live;
                      // A second process on one transcript would corrupt it.
                      const resumable = canResume(s) && !live;
                      const pinned = pinnedKeys.includes(key);
                      return renaming === key ? (
                        <li key={key} className="p-0.5">
                          <InlineInput
                            initial={s.title}
                            placeholder="Session name"
                            onCommit={(v) => onRename(s, v)}
                            onCancel={onCancelRename}
                          />
                        </li>
                      ) : (
                        <ContextMenu key={key}>
                          <ContextMenuTrigger asChild>
                            <li className="group/row relative">
                              {/* `detail > 1` drops the second click of a double-click, so
                                a habit double-click still opens it once. Not `disabled`
                                without a cwd, since a disabled button gets no contextmenu
                                and Delete would be unreachable. */}
                              <IconTooltip
                                side="right"
                                delayDuration={500}
                                contentClassName="max-w-sm"
                                label={
                                  <span className="flex flex-col gap-0.5">
                                    <span className="font-medium break-words">{s.title}</span>
                                    <span className="opacity-70">{agentLabel(s.agent)}</span>
                                    {s.cwd ? (
                                      <span className="break-all opacity-70">{s.cwd}</span>
                                    ) : null}
                                    <span className="opacity-70">
                                      Last active {ago(s.modifiedMs, now)} ago
                                      {s.size !== null ? ` · ${formatBytes(s.size)}` : ""}
                                    </span>
                                    <span className="font-mono text-[10px] opacity-50">{s.id}</span>
                                    <span className="opacity-70">
                                      {live ? "Running in another terminal" : resumeHint(s)}
                                    </span>
                                  </span>
                                }
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    if (e.detail <= 1 && resumable) resume(s);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "F2") {
                                      e.preventDefault();
                                      onStartRename(key);
                                    } else if (e.key === "Delete" && !live) {
                                      e.preventDefault();
                                      onDelete(s);
                                    }
                                  }}
                                  aria-disabled={!resumable}
                                  className={cn(
                                    "hover:bg-sidebar-accent/40 focus-visible:bg-sidebar-accent/40 flex w-full flex-col gap-0.5 px-1.5 py-1 text-left outline-none",
                                    !canResume(s) && "opacity-50",
                                  )}
                                >
                                  <span className="flex w-full items-center gap-2 text-xs">
                                    <CliAgentIcon
                                      agentId={s.agent}
                                      size={13}
                                      className="shrink-0"
                                    />
                                    <span
                                      className={cn(
                                        "text-sidebar-foreground/85 min-w-0 flex-1 truncate",
                                        s.custom && "font-medium",
                                      )}
                                    >
                                      {s.title}
                                    </span>
                                    {pinned ? (
                                      <Pin
                                        aria-label="Pinned"
                                        size={10}
                                        strokeWidth={2.25}
                                        className="text-muted-foreground shrink-0"
                                      />
                                    ) : null}
                                  </span>
                                  <span className="text-muted-foreground flex w-full items-center gap-2 pl-[21px] text-[10px] tabular-nums">
                                    <PlaceLine place={folder} branch={s.branch} />
                                    <span className="shrink-0">{ago(s.modifiedMs, now)} ago</span>
                                  </span>
                                </button>
                              </IconTooltip>
                            </li>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem disabled={!resumable} onSelect={() => resume(s)}>
                              Resume
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => togglePin(key)}>
                              {pinned ? "Unpin Session" : "Pin Session"}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => onStartRename(key)}>
                              Rename
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => copy(s.id)}>
                              Copy session id
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => copy(resumeCommand(s.agent, s.id))}>
                              Copy resume command
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              variant="destructive"
                              disabled={live}
                              onSelect={() => onDelete(s)}
                            >
                              {live ? "Delete (exit the session first)" : "Delete"}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </ul>
                  {!isFolded(sec.label) && sec.cards.length > (shown[sec.label] ?? SECTION_PAGE) ? (
                    <button
                      type="button"
                      onClick={() =>
                        setShown((prev) => ({
                          ...prev,
                          [sec.label]: (prev[sec.label] ?? SECTION_PAGE) + SECTION_PAGE,
                        }))
                      }
                      className="text-muted-foreground hover:text-foreground focus-visible:text-foreground w-full px-1 py-1 text-[10px] outline-none"
                    >
                      Show {sec.cards.length - (shown[sec.label] ?? SECTION_PAGE)} more
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
});

/**
 * The lower two thirds of the Workspaces section: Agents,
 * what is running now in any workspace, and History, everything that could be
 * resumed. Claude Code's and Codex's sessions alike. Never polled: Claude's
 * process registry is watched, and Codex's list, which spawns an app-server, is
 * only read on expand, on refresh, or when a pane starts or quits a CLI.
 */
export const AgentSessionsPanel = memo(function AgentSessionsPanel({
  collapsed,
  filter,
  liveTabs,
  cachedTabsByWorkspace,
  activeLeafId = null,
  onSwitch,
  onFocusLeaf,
}: Props) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningSession[] | null>(null);
  const [alivePtys, setAlivePtys] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentSession | null>(null);
  const [deletingMany, setDeletingMany] = useState<{
    label: string;
    list: AgentSession[];
  } | null>(null);

  const merge = useCallback((agent: SessionAgent, part: AgentSession[]) => {
    setSessions((prev) => {
      const next = [...(prev ?? []).filter((s) => s.agent !== agent), ...part];
      next.sort((a, b) => b.modifiedMs - a.modifiedMs);
      return (cached = next);
    });
  }, []);

  // Only the latest request may land: a Codex list takes about a second, and a
  // second refresh under it must not let the older answer overwrite the newer.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const req = ++latest.current;
    const { sessions: list, errors } = await listAllSessions((agent, part) => {
      if (req === latest.current) merge(agent, part);
    });
    if (req !== latest.current) return;
    setSessions((cached = list));
    // Inline, not a toast, and only when nothing loaded at all: "Codex is not
    // installed" is a state, and a Claude-only user should not see it forever.
    setLoadError(list.length === 0 && errors.length > 0 ? errors.join(" / ") : null);
  }, [merge]);

  // Claude rewrites its registry whenever a session changes state, which is also
  // when its title and time are likely to have moved. Its list is a cached disk
  // read, so it follows; Codex's would be a process per turn, so it does not.
  const loadRunning = useCallback(async () => {
    const live = await listRunningSessions().catch(() => null);
    // Unchanged is the common answer, and it must not re-render the lists.
    if (live) {
      setRunning((prev) =>
        JSON.stringify(prev) === JSON.stringify(live.running) ? prev : live.running,
      );
      setAlivePtys((prev) => (prev.join() === live.alivePtys.join() ? prev : live.alivePtys));
    }
    return live;
  }, []);
  const loadLive = useCallback(async () => {
    const [live, claude] = await Promise.all([
      loadRunning(),
      listSessions("claude").catch(() => null),
    ]);
    if (claude) merge("claude", claude);
    return live;
  }, [loadRunning, merge]);

  useEffect(() => {
    if (collapsed) return;
    void refresh();
    let gone = false;
    let watch: HostWatch | undefined;
    void loadLive().then((live) => {
      if (!gone && live) watch = watchTree(live.dir, () => void loadLive());
    });
    return () => {
      gone = true;
      watch?.dispose();
    };
  }, [collapsed, refresh, loadLive]);

  // A process that is killed or crashes writes nothing, so the watcher above never
  // hears it die and its row would stay until something else changed. Only while
  // something is running and the window is on screen.
  const anyRunning = (running?.length ?? 0) > 0;
  useEffect(() => {
    if (collapsed || !anyRunning) return;
    const timer = setInterval(() => {
      if (!document.hidden) void loadRunning();
    }, LIVENESS_MS);
    return () => clearInterval(timer);
  }, [collapsed, anyRunning, loadRunning]);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = useWorkspacesStore((s) => s.activeId);
  const statuses = useAiCliStatuses((s) => s.statuses);
  const sshHosts = useSshHosts();
  const panes = useMemo(
    () =>
      allPanes(
        workspaces,
        activeWorkspace,
        liveTabs,
        cachedTabsByWorkspace?.current,
        statuses,
        sshHosts,
        alivePtys,
      ),
    [workspaces, activeWorkspace, liveTabs, cachedTabsByWorkspace, statuses, sshHosts, alivePtys],
  );

  // A pane starting or quitting a CLI changes which sessions are newest, and Codex
  // says so nowhere else; a state change inside a running one does not.
  const paneSig = panes
    .filter((p) => p.status?.tool === "claude" || p.status?.tool === "codex")
    .map((p) => `${p.status?.tool}@${p.leafId}`)
    .join("|");
  const lastSig = useRef(paneSig);
  useEffect(() => {
    if (collapsed || lastSig.current === paneSig) return;
    lastSig.current = paneSig;
    void refresh();
  }, [paneSig, collapsed, refresh]);

  // A pane closing ends its process a moment later, so look now and once more,
  // rather than show it as running elsewhere until the next check.
  const ptySig = panes.map((p) => p.ptyId).join();
  useEffect(() => {
    if (collapsed) return;
    void loadRunning();
    const again = setTimeout(() => void loadRunning(), 800);
    return () => clearTimeout(again);
  }, [ptySig, collapsed, loadRunning]);

  const openMap = useMemo(
    () => openSessions(sessions ?? [], panes, running ?? []),
    [sessions, panes, running],
  );
  const rows = useMemo(
    () => agentRows(panes, openMap, sessions ?? [], running ?? []),
    [panes, openMap, sessions, running],
  );

  // History only cares which sessions are running, not what state they are in, so it
  // must not re-render for every state change.
  const openSig = [...openMap.keys(), ...(running ?? []).map((r) => `claude:${r.id}`)]
    .sort()
    .join("\n");
  const openKeys = useMemo(() => new Set(openSig.split("\n")), [openSig]);

  // Kept while focus sits on an editor or a remote pane, so "only this folder"
  // does not flip every time focus leaves a terminal.
  const activeCwd = panes.find((p) => p.leafId === activeLeafId)?.cwd ?? null;
  const [folderKey, setFolderKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeCwd) setFolderKey(folderKeyOf(activeCwd));
  }, [activeCwd]);

  const go = (pane: AgentPane) => {
    if (pane.workspaceId === null) return;
    if (pane.workspaceId !== activeWorkspace) onSwitch(pane.workspaceId);
    if (!pane.cold) onFocusLeaf?.(pane.tabId, pane.leafId);
  };

  const commitRename = useCallback(
    async (s: AgentSession, title: string) => {
      setRenaming(null);
      if (!title.trim() || title.trim() === s.title) return;
      try {
        await renameSession(s, title);
        await refresh();
      } catch (e) {
        toast(`Rename failed: ${String(e)}`, { variant: "error" });
      }
    },
    [refresh],
  );
  const rename = useCallback(
    (s: AgentSession, title: string) => void commitRename(s, title),
    [commitRename],
  );
  const cancelRename = useCallback(() => setRenaming(null), []);
  const refreshAll = useCallback(() => {
    void refresh();
    void loadLive();
  }, [refresh, loadLive]);

  // By key: a watcher refresh may have replaced the objects meanwhile.
  const forget = (keys: Set<string>) =>
    setSessions((prev) => (cached = prev?.filter((x) => !keys.has(sessionKey(x))) ?? null));

  const pinnedKeys = usePreferencesStore((s) => s.pinnedAgentSessions);
  const confirmDeleteMany = async () => {
    const batch = deletingMany;
    setDeletingMany(null);
    if (!batch) return;
    const gone = new Set<string>();
    // One at a time: Codex's delete is a process each.
    for (const s of batch.list) {
      try {
        await deleteSession(s);
        gone.add(sessionKey(s));
      } catch {
        // Counted below. One that fails must not stop the rest.
      }
    }
    forget(gone);
    const failed = batch.list.length - gone.size;
    if (failed > 0)
      toast(`${failed} of ${batch.list.length} could not be deleted`, { variant: "error" });
    else toast(`Deleted ${gone.size} sessions`);
  };
  const confirmDelete = async () => {
    const s = deleting;
    setDeleting(null);
    if (!s) return;
    try {
      await deleteSession(s);
      forget(new Set([sessionKey(s)]));
      const key = sessionKey(s);
      if (pinnedKeys.includes(key))
        void setPinnedAgentSessions(pinnedKeys.filter((k) => k !== key));
    } catch (e) {
      toast(`Delete failed: ${String(e)}`, { variant: "error" });
    }
  };

  return (
    <>
      <AgentsBlock
        rows={rows}
        filter={filter}
        activeLeafId={activeLeafId}
        workspaces={workspaces}
        folderNames={(r) => {
          const cwd = r.session?.cwd ?? r.pane.cwd;
          return r.pane.host ?? (cwd ? basename(toForwardSlash(cwd)) || null : null);
        }}
        renaming={renaming}
        onRename={rename}
        onStartRename={setRenaming}
        onCancelRename={cancelRename}
        onGo={go}
      />
      <HistoryBlock
        sessions={sessions}
        loadError={loadError}
        filter={filter}
        folderKey={folderKey}
        openKeys={openKeys}
        registryLoaded={running !== null}
        renaming={renaming}
        onRename={rename}
        onStartRename={setRenaming}
        onCancelRename={cancelRename}
        onDelete={setDeleting}
        onDeleteMany={setDeletingMany}
        onRefresh={refreshAll}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleting?.title}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.agent === "claude"
                ? `The transcript${deleting?.size != null ? ` (${formatBytes(deleting.size)})` : ""} and its tool results are removed from ~/.claude/projects.`
                : "Codex permanently deletes the session and its history."}{" "}
              It can no longer be resumed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              Delete session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deletingMany !== null}
        onOpenChange={(o) => {
          if (!o) setDeletingMany(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deletingMany?.list.length} sessions from &quot;{deletingMany?.label}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their transcripts go for good and they can no longer be resumed. Pinned and running
              sessions are kept. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDeleteMany()}>
              Delete {deletingMany?.list.length} sessions
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});
