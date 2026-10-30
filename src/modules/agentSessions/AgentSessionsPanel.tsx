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
import { Folder, GitBranch, PanelLeft, PanelRight, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ago,
  canResume,
  dayBucket,
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
 * Claude Code's and Codex's saved sessions for the focused terminal's folder, as
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
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeCwd) setActiveKey(keyOf(activeCwd));
  }, [activeCwd]);

  // Only the focused terminal's folder (and folders under it), not every project,
  // flattened newest first and cut into day sections. A session from a subfolder
  // keeps that folder's name as a chip on its card.
  const sections = useMemo(() => {
    if (!activeKey) return [];
    const now = Date.now();
    const out: { label: string; cards: { s: AgentSession; folder: string | null }[] }[] = [];
    const cards = groupSessions(sessions ?? [], filter)
      .filter((g) => inFolder(g.key, activeKey))
      .flatMap((g) => g.sessions.map((s) => ({ s, folder: g.key === activeKey ? null : g.label })))
      .sort((a, b) => b.s.modifiedMs - a.s.modifiedMs);
    for (const c of cards) {
      const label = dayBucket(c.s.modifiedMs, now);
      if (out.at(-1)?.label !== label) out.push({ label, cards: [] });
      out.at(-1)!.cards.push(c);
    }
    return out;
  }, [sessions, filter, activeKey]);
  const count = sections.reduce((n, sec) => n + sec.cards.length, 0);

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
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
          AI Sessions
          {count > 0 ? (
            <span className="text-muted-foreground ml-1.5 font-normal tabular-nums">{count}</span>
          ) : null}
        </span>
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
        <div className="p-1.5 pr-2.5">
          {sessions === null ? (
            <p className="text-muted-foreground px-1 py-3 text-xs">Loading…</p>
          ) : loadError ? (
            <p className="text-muted-foreground px-1 py-3 text-xs break-words">{loadError}</p>
          ) : !activeKey ? (
            <p className="text-muted-foreground px-1 py-3 text-xs">
              Focus a local terminal to see its folder&apos;s sessions.
            </p>
          ) : count === 0 ? (
            <p className="text-muted-foreground px-1 py-3 text-xs">
              {filter
                ? "No matching sessions."
                : "No Claude Code or Codex sessions in this folder."}
            </p>
          ) : null}
          {sections.map((sec) => (
            <section key={sec.label} className="mb-2">
              <h3 className="text-muted-foreground/80 px-1 pt-1 pb-1 text-[10px] font-medium tracking-wide uppercase">
                {sec.label}
              </h3>
              <ul className="flex flex-col gap-1">
                {sec.cards.map(({ s, folder }) => {
                  const key = sessionKey(s);
                  const st = openMap.get(key);
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
                        <li>
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
                                      "border-l-2 border-l-current",
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
                                    "text-sidebar-foreground/90 group-hover:text-sidebar-foreground line-clamp-2 flex-1 text-[11.5px] leading-snug break-words",
                                    s.custom && "font-medium",
                                  )}
                                >
                                  {s.title}
                                </span>
                              </span>
                              <span className="flex w-full items-center gap-1.5 pl-[19px] text-[10px] tabular-nums">
                                {st ? (
                                  <span className="shrink-0 font-medium">
                                    {aiCliLabel(st).split(" · ")[1]}
                                  </span>
                                ) : s.live ? (
                                  <span className="shrink-0 font-medium">running</span>
                                ) : null}
                                <span className="text-muted-foreground truncate">
                                  {meta.join(" · ")}
                                </span>
                                {s.branch ? (
                                  <span className="text-muted-foreground inline-flex min-w-0 items-center gap-0.5">
                                    <GitBranch size={9} strokeWidth={2} className="shrink-0" />
                                    <span className="truncate">{s.branch}</span>
                                  </span>
                                ) : null}
                                {folder ? (
                                  <span className="text-muted-foreground ml-auto inline-flex max-w-[45%] shrink-0 items-center gap-0.5 rounded px-1">
                                    <Folder size={9} strokeWidth={2} className="shrink-0" />
                                    <span className="truncate">{folder}</span>
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          </IconTooltip>
                        </li>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem disabled={!canResume(s)} onSelect={() => resume(s)}>
                          Resume
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
