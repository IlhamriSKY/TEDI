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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { IconSwap } from "@/components/IconMorph";
import { PanelSearchInput } from "@/components/PanelSearchInput";
import { toForwardSlash } from "@/lib/path";
import { formatBytes } from "@/lib/format";
import { DESTRUCTIVE_ACTION, HEADER_TOGGLE_ACTIVE, HEADER_TOGGLE_IDLE } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { openWorktreeTab } from "@/modules/scm/worktreeBridge";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPinnedAgentSessions } from "@/modules/settings/store";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import {
  aiCliIconMotionClass,
  aiCliLabel,
  aiCliStateColorClass,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  GitBranch,
  PanelLeft,
  PanelRight,
  Pin,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ago,
  canResume,
  deleteSession,
  listAllSessions,
  renameSession,
  resumeCommand,
  resumeHint,
  SESSION_AGENTS,
  sessionKey,
  sessionSections,
  TERMINAL_SECTION,
  type AgentSession,
} from "./api";

type Props = {
  /** Drag handle for sidebar-section reordering, injected by the sidebar. */
  dragHandle?: ReactNode;
  /** Collapsed to its header: skip the disk read / app-server spawn entirely. */
  collapsed?: boolean;
  /** The active workspace's tabs: their terminals' folders sort to the top, the
   *  focused one first, and the AI CLIs running in them mark which sessions are open. */
  liveTabs: Tab[];
  activeLeafId: number | null;
  /** Left sidebar instance: dock into the right column. */
  onMoveToRight?: () => void;
  /** Right column instance: dock back into the left sidebar. */
  onMoveToLeft?: () => void;
  /** Right column instance: close the docked panel. */
  onClose?: () => void;
};

// Survives a collapse and a move between columns (both remount the panel), so
// reopening paints the last list at once and refreshes underneath.
let cached: AgentSession[] | null = null;
// Day headings the user folded, kept the same way.
let foldedCache = new Set<string>();
let modeCache: "working" | "all" = "all";
const SECTION_PAGE = 50;

const keyOf = (path: string) => toForwardSlash(path).replace(/\/+$/, "").toLowerCase();

/**
 * Which listed sessions an AI CLI pane is running, and that pane's status. No
 * pane records the session id it resumed, so per folder and CLI the N panes
 * claim N sessions: Claude's `live` ones first (its own process registry),
 * then the most recently written.
 * shortcut: a heuristic, wrong when two panes run the same CLI in one folder
 * and one is a fresh session not yet listed; tag the leaf with the resumed id
 * if that matters.
 */
function openStatuses(
  sessions: AgentSession[],
  panes: { cwd: string; status: NonNullable<AiCliStatus> }[],
): Map<string, NonNullable<AiCliStatus>> {
  const out = new Map<string, NonNullable<AiCliStatus>>();
  for (const p of panes) {
    const folder = keyOf(p.cwd);
    const pick = sessions
      .filter(
        (s) =>
          s.agent === p.status.tool &&
          s.cwd !== null &&
          keyOf(s.cwd) === folder &&
          !out.has(sessionKey(s)),
      )
      .sort((a, b) => Number(b.live) - Number(a.live) || b.modifiedMs - a.modifiedMs)[0];
    if (pick) out.set(sessionKey(pick), p.status);
  }
  return out;
}

const agentLabel = (a: AgentSession["agent"]) => SESSION_AGENTS.find((x) => x.id === a)?.label ?? a;

/**
 * Claude Code's and Codex's saved sessions, either all of them (All) or whatever
 * is running now (Working), the folders terminals have open on top, as
 * cards under day headings (the Codex app / Orca history layout), each marked
 * with its CLI's icon and, when a pane runs it, that pane's status. One click
 * (or Enter) moves an idle terminal into the session's folder and resumes
 * there, else resumes in a split beside it, F2 renames, right-click for everything. Loaded on expand
 * and on refresh, never polled: the list only changes when a
 * session is run or acted on here.
 */
export function AgentSessionsPanel({
  dragHandle,
  collapsed,
  liveTabs,
  activeLeafId,
  onMoveToRight,
  onMoveToLeft,
  onClose,
}: Props) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mode, setMode] = useState(modeCache);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentSession | null>(null);

  // Only the latest request may land: a Codex list takes about a second, and a
  // second refresh under it must not let the older answer overwrite the newer.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const req = ++latest.current;
    const { sessions: list, errors } = await listAllSessions((agent, part) => {
      if (req !== latest.current) return;
      setSessions((prev) => {
        const next = [...(prev ?? []).filter((s) => s.agent !== agent), ...part];
        next.sort((a, b) => b.modifiedMs - a.modifiedMs);
        return (cached = next);
      });
    });
    if (req !== latest.current) return;
    setSessions((cached = list));
    // Inline, not a toast, and only when nothing loaded at all: "Codex is not
    // installed" is a state, and a Claude-only user should not see it forever.
    setLoadError(list.length === 0 && errors.length > 0 ? errors.join(" / ") : null);
  }, []);

  useEffect(() => {
    if (!collapsed) void refresh();
  }, [collapsed, refresh]);

  // Local terminals only: their folders, and every AI CLI pane.
  const statuses = useAiCliStatuses((s) => s.statuses);
  const { activeCwd, agentPanes, terminalKeys } = useMemo(() => {
    let activeCwd: string | null = null;
    const agentPanes: { cwd: string; status: NonNullable<AiCliStatus> }[] = [];
    const terminalKeys = new Set<string>();
    for (const t of liveTabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal" || l.sshConnectionId) continue;
        if (l.id === activeLeafId) activeCwd = l.cwd ?? null;
        if (l.cwd) terminalKeys.add(keyOf(l.cwd));
        const st = statuses[l.id];
        if (l.cwd && (st?.tool === "claude" || st?.tool === "codex")) {
          agentPanes.push({ cwd: l.cwd, status: st });
        }
      }
    }
    return { activeCwd, agentPanes, terminalKeys };
  }, [liveTabs, activeLeafId, statuses]);

  // A pane starting or quitting a CLI changes which sessions are live and
  // newest, so re-list then; a state change inside a running one does not.
  const paneSig = agentPanes.map((p) => `${p.status.tool}@${keyOf(p.cwd)}`).join("|");
  const lastSig = useRef(paneSig);
  useEffect(() => {
    if (collapsed || lastSig.current === paneSig) return;
    lastSig.current = paneSig;
    void refresh();
  }, [paneSig, collapsed, refresh]);
  const openMap = useMemo(() => openStatuses(sessions ?? [], agentPanes), [sessions, agentPanes]);

  // Same key shape as `groupSessions`. Kept while focus sits on an editor or a
  // remote pane, so the list does not reshuffle every time focus leaves a terminal.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeCwd) setActiveKey(keyOf(activeCwd));
  }, [activeCwd]);

  const pinnedKeys = usePreferencesStore((s) => s.pinnedAgentSessions);
  const togglePin = (key: string) =>
    void setPinnedAgentSessions(
      pinnedKeys.includes(key) ? pinnedKeys.filter((k) => k !== key) : [key, ...pinnedKeys],
    );

  const sections = useMemo(
    () =>
      sessionSections(sessions ?? [], {
        filter,
        mode,
        activeKey,
        terminalKeys,
        openKeys: new Set(openMap.keys()),
        pinnedKeys: new Set(pinnedKeys),
        now: Date.now(),
      }),
    [sessions, filter, activeKey, terminalKeys, mode, openMap, pinnedKeys],
  );
  const count = sections.reduce((n, sec) => n + sec.cards.length, 0);

  const [shown, setShown] = useState<Record<string, number>>({});
  const [folded, setFolded] = useState(foldedCache);
  const setFold = (next: Set<string>) => setFolded((foldedCache = next));
  // A filter searches every section, so it opens them all while it is typed.
  const isFolded = (label: string) => !filter && folded.has(label);
  const allFolded = sections.length > 0 && sections.every((sec) => isFolded(sec.label));
  const toggleSection = (label: string) => {
    const next = new Set(folded);
    if (!next.delete(label)) next.add(label);
    setFold(next);
  };

  // Clears too: a closed box must not keep narrowing the list out of sight.
  const closeSearch = () => {
    setSearchOpen(false);
    setFilter("");
  };

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

  const commitRename = async (s: AgentSession, title: string) => {
    setRenaming(null);
    if (!title.trim() || title.trim() === s.title) return;
    try {
      await renameSession(s, title);
      await refresh();
    } catch (e) {
      toast(`Rename failed: ${String(e)}`, { variant: "error" });
    }
  };

  const confirmDelete = async () => {
    const s = deleting;
    setDeleting(null);
    if (!s) return;
    try {
      await deleteSession(s);
      setSessions((prev) => prev?.filter((x) => x !== s) ?? prev);
      if (pinnedKeys.includes(sessionKey(s))) togglePin(sessionKey(s));
    } catch (e) {
      toast(`Delete failed: ${String(e)}`, { variant: "error" });
    }
  };

  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tedi-panel-header">
        {dragHandle}
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
          AI Sessions
          {count > 0 ? (
            <span className="text-muted-foreground ml-1.5 font-normal tabular-nums">{count}</span>
          ) : null}
        </span>
        {sections.length > 1 ? (
          <IconTooltip label={allFolded ? "Expand all" : "Collapse all"} side="bottom">
            <Button
              onClick={() =>
                setFold(allFolded ? new Set() : new Set(sections.map((sec) => sec.label)))
              }
              aria-label={allFolded ? "Expand all sections" : "Collapse all sections"}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <IconSwap
                active={allFolded ? 0 : 1}
                icons={[
                  <ChevronsUpDown size={13} strokeWidth={2} />,
                  <ChevronsDownUp size={13} strokeWidth={2} />,
                ]}
              />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label="Search sessions" side="bottom">
          <Button
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            aria-label="Search sessions"
            aria-pressed={searchOpen}
            variant="ghost"
            size="icon"
            className={cn("size-6", searchOpen ? HEADER_TOGGLE_ACTIVE : HEADER_TOGGLE_IDLE)}
          >
            <Search size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        <IconTooltip label="Refresh" side="bottom">
          <Button
            onClick={() => void refresh()}
            aria-label="Refresh sessions"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
          >
            <RefreshCw size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        {onMoveToRight ? (
          <IconTooltip label="Move to right panel" side="bottom">
            <Button
              onClick={onMoveToRight}
              aria-label="Move AI Sessions to the right panel"
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
              aria-label="Move AI Sessions to the left sidebar"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <PanelLeft size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {onClose ? (
          <IconTooltip label="Close panel" side="bottom">
            <Button
              onClick={onClose}
              aria-label="Close AI Sessions panel"
              variant="ghost"
              size="icon"
              className={cn(DESTRUCTIVE_ACTION, "size-6")}
            >
              <X size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      <Tabs
        value={mode}
        onValueChange={(v) => {
          const next = v === "working" ? "working" : "all";
          setMode((modeCache = next));
          // `live` is only as fresh as the last list.
          if (next === "working") void refresh();
        }}
        className="shrink-0 px-1.5 pt-1.5"
      >
        <TabsList className="bg-muted/40 h-7 w-full px-1">
          <TabsTrigger value="working" className="h-6 flex-1 px-2.5 text-[11.5px]">
            Working
          </TabsTrigger>
          <TabsTrigger value="all" className="h-6 flex-1 px-2.5 text-[11.5px]">
            All
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {searchOpen ? (
        <PanelSearchInput
          value={filter}
          onChange={setFilter}
          onClose={closeSearch}
          placeholder="Search sessions"
        />
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5 pr-2.5">
          {sessions === null ? (
            <p className="text-muted-foreground px-1 py-3 text-xs">Loading…</p>
          ) : loadError ? (
            <p className="text-muted-foreground px-1 py-3 text-xs break-words">{loadError}</p>
          ) : count === 0 ? (
            <p className="text-muted-foreground px-1 py-3 text-xs">
              {filter
                ? "No matching sessions."
                : mode === "working"
                  ? "No session is running right now."
                  : "No Claude Code or Codex sessions found."}
            </p>
          ) : null}
          {sections.map((sec) => (
            <section key={sec.label} className="mb-2">
              <h3>
                <button
                  type="button"
                  onClick={() => toggleSection(sec.label)}
                  aria-expanded={!isFolded(sec.label)}
                  className="text-muted-foreground/80 hover:text-foreground focus-visible:text-foreground flex w-full items-center gap-1 rounded px-1 pt-1 pb-1 text-[10px] font-medium tracking-wide uppercase outline-none"
                >
                  <ChevronRight
                    size={11}
                    strokeWidth={2}
                    className={cn(
                      "shrink-0 transition-transform",
                      !isFolded(sec.label) && "rotate-90",
                    )}
                  />
                  {sec.label === TERMINAL_SECTION ? (
                    <SquareTerminal size={11} strokeWidth={2} className="text-primary shrink-0" />
                  ) : null}
                  <span className="flex-1 text-left">{sec.label}</span>
                  <span className="font-normal tabular-nums">{sec.cards.length}</span>
                </button>
              </h3>
              {/* Unmounted, not hidden, and paged: a heavy user has thousands of
                  sessions, each card a tooltip and a context menu. */}
              <ul className={cn("flex flex-col gap-1", isFolded(sec.label) && "hidden")}>
                {(isFolded(sec.label)
                  ? []
                  : sec.cards.slice(0, shown[sec.label] ?? SECTION_PAGE)
                ).map(({ s, folder, inTerminal }) => {
                  const key = sessionKey(s);
                  const st = openMap.get(key);
                  const pinned = pinnedKeys.includes(key);
                  const meta = [
                    ago(s.modifiedMs, now),
                    s.size !== null ? formatBytes(s.size) : null,
                  ].filter(Boolean);
                  return renaming === key ? (
                    <li key={key} className="p-1">
                      <InlineInput
                        initial={s.title}
                        placeholder="Session name"
                        onCommit={(v) => void commitRename(s, v)}
                        onCancel={() => setRenaming(null)}
                      />
                    </li>
                  ) : (
                    <ContextMenu key={key}>
                      <ContextMenuTrigger asChild>
                        <li className="group/card relative">
                          {/* One click resumes. `detail > 1` drops the second click of a
                              double-click, so a habit double-click still opens it once.
                              Not `disabled` without a cwd, since a disabled button gets
                              no contextmenu and Delete would be unreachable. */}
                          <IconTooltip
                            side={onMoveToRight ? "right" : "left"}
                            delayDuration={500}
                            contentClassName="max-w-sm"
                            label={
                              <span className="flex flex-col gap-0.5">
                                <span className="font-medium break-words">{s.title}</span>
                                <span className="opacity-70">
                                  {st ? aiCliLabel(st) : agentLabel(s.agent)}
                                  {s.live && !st ? " · running" : ""}
                                </span>
                                {s.cwd ? (
                                  <span className="break-all opacity-70">{s.cwd}</span>
                                ) : null}
                                <span className="font-mono text-[10px] opacity-50">{s.id}</span>
                                <span className="opacity-70">{resumeHint(s)}</span>
                              </span>
                            }
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                if (e.detail <= 1) resume(s);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "F2") {
                                  e.preventDefault();
                                  setRenaming(key);
                                }
                              }}
                              aria-disabled={!canResume(s)}
                              className={cn(
                                "group border-border/50 hover:border-border focus-visible:border-ring flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left outline-none aria-disabled:opacity-50",
                                st
                                  ? cn(
                                      "border-l-2 border-l-current hover:border-l-current focus-visible:border-l-current",
                                      aiCliStateColorClass(st.state),
                                    )
                                  : "text-muted-foreground",
                              )}
                            >
                              <span className="flex w-full items-start gap-1.5">
                                {/* Motion on the wrapper, never the svg (see aiCliIconMotionClass). */}
                                <span
                                  aria-label={st ? aiCliLabel(st) : agentLabel(s.agent)}
                                  className={cn(
                                    "relative mt-px flex shrink-0",
                                    st && aiCliIconMotionClass(st),
                                  )}
                                >
                                  <CliAgentIcon agentId={s.agent} size={13} />
                                  {s.live && !st ? (
                                    <span
                                      aria-hidden
                                      className="bg-icon-idle ring-sidebar absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1"
                                    />
                                  ) : null}
                                </span>
                                <span
                                  className={cn(
                                    "text-sidebar-foreground/90 group-hover:text-sidebar-foreground line-clamp-2 flex-1 pr-4 text-[11.5px] leading-snug break-words",
                                    s.custom && "font-medium",
                                  )}
                                >
                                  {s.title}
                                </span>
                              </span>
                              <span className="flex w-full items-center gap-1.5 pl-[19px] text-[10px] tabular-nums">
                                <span className="text-muted-foreground truncate">
                                  {meta.join(" · ")}
                                </span>
                                {s.branch ? (
                                  <span className="text-muted-foreground inline-flex min-w-0 items-center gap-0.5">
                                    <GitBranch size={9} strokeWidth={2} className="shrink-0" />
                                    <span className="truncate">{s.branch}</span>
                                  </span>
                                ) : null}
                                <span className="text-muted-foreground ml-auto inline-flex max-w-[45%] shrink-0 items-center gap-0.5 rounded px-1">
                                  {inTerminal ? (
                                    <SquareTerminal
                                      aria-label="Open in a terminal"
                                      size={9}
                                      strokeWidth={2}
                                      className="text-primary shrink-0"
                                    />
                                  ) : (
                                    <Folder size={9} strokeWidth={2} className="shrink-0" />
                                  )}
                                  <span className="truncate">{folder}</span>
                                </span>
                              </span>
                            </button>
                          </IconTooltip>
                          {/* Beside the card's button, not in it: buttons cannot nest.
                              Always shown once pinned, a pin nobody can see is no use. */}
                          <IconTooltip label={pinned ? "Unpin session" : "Pin session"}>
                            <button
                              type="button"
                              onClick={() => togglePin(key)}
                              aria-label={pinned ? "Unpin session" : "Pin session"}
                              aria-pressed={pinned}
                              className={cn(
                                "text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1 right-1 cursor-pointer rounded p-0.5 outline-none focus-visible:opacity-100 focus-visible:ring-1",
                                !pinned && "opacity-0 group-hover/card:opacity-100",
                              )}
                            >
                              <Pin size={11} strokeWidth={pinned ? 2.25 : 1.75} />
                            </button>
                          </IconTooltip>
                        </li>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem disabled={!canResume(s)} onSelect={() => resume(s)}>
                          Resume
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => togglePin(key)}>
                          {pinned ? "Unpin Session" : "Pin Session"}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setRenaming(key)}>Rename</ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() => void navigator.clipboard.writeText(s.id).catch(() => {})}
                        >
                          Copy session id
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() =>
                            void navigator.clipboard
                              .writeText(resumeCommand(s.agent, s.id))
                              .catch(() => {})
                          }
                        >
                          Copy resume command
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          disabled={s.live}
                          onSelect={() => setDeleting(s)}
                        >
                          {s.live ? "Delete (exit the session first)" : "Delete"}
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
                  className="text-muted-foreground hover:text-foreground focus-visible:text-foreground mt-1 w-full rounded px-1 py-1 text-[10px] outline-none"
                >
                  Show {sec.cards.length - (shown[sec.label] ?? SECTION_PAGE)} more
                </button>
              ) : null}
            </section>
          ))}
        </div>
      </ScrollArea>

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
    </div>
  );
}
