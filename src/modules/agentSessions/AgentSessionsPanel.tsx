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
import { toast } from "@/components/ui/toast";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { toForwardSlash } from "@/lib/path";
import { formatBytes } from "@/lib/format";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { openWorktreeTab } from "@/modules/scm/worktreeBridge";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import {
  aiCliIconMotionClass,
  aiCliLabel,
  aiCliStateColorClass,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";
import { ChevronRight, Folder, PanelLeft, PanelRight, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ago,
  canResume,
  deleteSession,
  groupSessions,
  inFolder,
  listAllSessions,
  renameSession,
  resumeCommand,
  resumeHint,
  SESSION_AGENTS,
  type AgentSession,
} from "./api";

type Props = {
  /** Drag handle for sidebar-section reordering, injected by the sidebar. */
  dragHandle?: ReactNode;
  /** Collapsed to its header: skip the disk read / app-server spawn entirely. */
  collapsed?: boolean;
  /** The active workspace's tabs: the focused terminal picks the folder shown,
   *  and the AI CLIs running in them mark which sessions are open. */
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

const keyOf = (path: string) => toForwardSlash(path).replace(/\/+$/, "").toLowerCase();
const sessionKey = (s: AgentSession) => `${s.agent}:${s.id}`;

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
 * Claude Code's and Codex's saved sessions in one folder tree, each row marked
 * with its CLI's icon: one row per project
 * folder, its sessions under it; the focused terminal's folder opens by itself.
 * Double-click (or Enter) resumes in that terminal when it is idle there, else
 * in a split beside it, F2 renames, right-click for everything. Loaded on expand
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
  const [open, setOpen] = useState<Set<string>>(() => new Set());
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

  // Local terminals only: the focused one's folder, and every AI CLI pane.
  const statuses = useAiCliStatuses((s) => s.statuses);
  const { activeCwd, agentPanes } = useMemo(() => {
    let activeCwd: string | null = null;
    const agentPanes: { cwd: string; status: NonNullable<AiCliStatus> }[] = [];
    for (const t of liveTabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "terminal" || l.sshConnectionId) continue;
        if (l.id === activeLeafId) activeCwd = l.cwd ?? null;
        const st = statuses[l.id];
        if (l.cwd && (st?.tool === "claude" || st?.tool === "codex")) {
          agentPanes.push({ cwd: l.cwd, status: st });
        }
      }
    }
    return { activeCwd, agentPanes };
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
  // remote pane, so the list does not blank every time focus leaves a terminal.
  // Opened once per folder change, so a folder the user then collapses stays
  // collapsed until focus moves.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeCwd) setActiveKey(keyOf(activeCwd));
  }, [activeCwd]);
  useEffect(() => {
    if (activeKey) setOpen((prev) => (prev.has(activeKey) ? prev : new Set(prev).add(activeKey)));
  }, [activeKey]);
  const activeRow = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [activeKey, sessions]);

  // Only the focused terminal's folder (and folders under it), not every project.
  const groups = useMemo(
    () =>
      activeKey
        ? groupSessions(sessions ?? [], filter).filter((g) => inFolder(g.key, activeKey))
        : [],
    [sessions, filter, activeKey],
  );
  // A search shows its hits; otherwise only the folders the user opened.
  const isOpen = (key: string) => filter.trim() !== "" || open.has(key);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
    } catch (e) {
      toast(`Delete failed: ${String(e)}`, { variant: "error" });
    }
  };

  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tedi-panel-header">
        {dragHandle}
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">AI Sessions</span>
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
      <div className="px-1.5 pt-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter sessions"
          aria-label="Filter sessions"
          className="border-input bg-background/50 placeholder:text-muted-foreground focus-visible:ring-ring h-6 w-full rounded border px-2 text-xs outline-none focus-visible:ring-1"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="p-1 pr-2.5">
          {sessions === null ? (
            <li className="text-muted-foreground px-2 py-3 text-xs">Loading…</li>
          ) : loadError ? (
            <li className="text-muted-foreground px-2 py-3 text-xs break-words">{loadError}</li>
          ) : !activeKey ? (
            <li className="text-muted-foreground px-2 py-3 text-xs">
              Focus a local terminal to see its folder&apos;s sessions.
            </li>
          ) : groups.length === 0 ? (
            <li className="text-muted-foreground px-2 py-3 text-xs">
              {filter
                ? "No matching sessions."
                : "No Claude Code or Codex sessions in this folder."}
            </li>
          ) : null}
          {groups.map((g) => {
            const shown = isOpen(g.key);
            return (
              <li key={g.key} ref={g.key === activeKey ? activeRow : undefined}>
                <button
                  type="button"
                  onClick={() => toggle(g.key)}
                  aria-expanded={shown}
                  title={g.path}
                  className="text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground flex h-7 w-full items-center gap-1 rounded px-1.5 text-xs"
                >
                  <ChevronRight
                    size={11}
                    strokeWidth={2.25}
                    className={cn("shrink-0 transition-transform", shown && "rotate-90")}
                  />
                  <Folder size={13} strokeWidth={1.75} className="shrink-0" />
                  <span className="flex-1 truncate text-left">{g.label}</span>
                  <span className="text-muted-foreground/70 shrink-0 text-[10px] tabular-nums">
                    {g.sessions.length}
                  </span>
                </button>
                {shown ? (
                  <ul>
                    {g.sessions.map((s) => {
                      const st = openMap.get(sessionKey(s));
                      return renaming === `${s.agent}:${s.id}` ? (
                        <li key={`${s.agent}:${s.id}`} className="py-0.5 pr-1 pl-6">
                          <InlineInput
                            initial={s.title}
                            placeholder="Session name"
                            onCommit={(v) => void commitRename(s, v)}
                            onCancel={() => setRenaming(null)}
                          />
                        </li>
                      ) : (
                        <ContextMenu key={`${s.agent}:${s.id}`}>
                          <ContextMenuTrigger asChild>
                            <li>
                              {/* Double-click opens, like the file tree: a single-click
                                  resume would fire twice under any double-click. Not
                                  `disabled` without a cwd, since a disabled button
                                  gets no contextmenu and Delete would be unreachable. */}
                              <button
                                type="button"
                                onDoubleClick={() => resume(s)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") resume(s);
                                  else if (e.key === "F2") setRenaming(`${s.agent}:${s.id}`);
                                }}
                                aria-disabled={!canResume(s)}
                                title={`${st ? aiCliLabel(st) : agentLabel(s.agent)}: ${s.title}\n${s.id}${s.size !== null ? ` · ${formatBytes(s.size)}` : ""}${s.live ? " · running" : ""}\n${resumeHint(s)}`}
                                className={cn(
                                  "hover:bg-sidebar-accent/40 focus-visible:bg-sidebar-accent/40 flex h-6 w-full items-center gap-1.5 rounded pr-1.5 pl-6 text-[11px] outline-none aria-disabled:opacity-50",
                                  st
                                    ? cn("font-medium", aiCliStateColorClass(st.state))
                                    : "text-sidebar-foreground/80 hover:text-sidebar-foreground",
                                )}
                              >
                                {/* Motion on the wrapper, never the svg (see aiCliIconMotionClass). */}
                                <span
                                  aria-label={st ? aiCliLabel(st) : agentLabel(s.agent)}
                                  className={cn(
                                    "relative flex shrink-0",
                                    st && aiCliIconMotionClass(st),
                                  )}
                                >
                                  <CliAgentIcon agentId={s.agent} size={12} />
                                  {s.live && !st ? (
                                    <span
                                      aria-hidden
                                      className="bg-icon-idle ring-sidebar absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1"
                                    />
                                  ) : null}
                                </span>
                                <span
                                  className={cn(
                                    "flex-1 truncate text-left",
                                    s.custom && "font-medium",
                                  )}
                                >
                                  {s.title}
                                </span>
                                <span className="text-muted-foreground/70 shrink-0 text-[10px] tabular-nums">
                                  {ago(s.modifiedMs, now)}
                                </span>
                              </button>
                            </li>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem disabled={!canResume(s)} onSelect={() => resume(s)}>
                              Resume
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => setRenaming(`${s.agent}:${s.id}`)}>
                              Rename
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() =>
                                void navigator.clipboard.writeText(s.id).catch(() => {})
                              }
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
                ) : null}
              </li>
            );
          })}
        </ul>
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
