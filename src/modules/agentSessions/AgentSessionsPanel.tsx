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
import { cn } from "@/lib/utils";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { openWorktreeTab } from "@/modules/scm/worktreeBridge";
import { ChevronRight, Folder, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ago,
  canResume,
  deleteSession,
  groupSessions,
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
  /** The focused local terminal's cwd: its folder row opens by itself. */
  activeCwd?: string | null;
};

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
export function AgentSessionsPanel({ dragHandle, collapsed, activeCwd }: Props) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
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
    const { sessions: list, errors } = await listAllSessions();
    if (req !== latest.current) return;
    setSessions(list);
    // Inline, not a toast, and only when nothing loaded at all: "Codex is not
    // installed" is a state, and a Claude-only user should not see it forever.
    setLoadError(list.length === 0 && errors.length > 0 ? errors.join(" / ") : null);
  }, []);

  useEffect(() => {
    if (!collapsed) void refresh();
  }, [collapsed, refresh]);

  // Same key shape as `groupSessions`. Opened once per folder change, so a
  // folder the user then collapses stays collapsed until focus moves.
  const activeKey = activeCwd ? toForwardSlash(activeCwd).replace(/\/+$/, "").toLowerCase() : null;
  useEffect(() => {
    if (activeKey) setOpen((prev) => (prev.has(activeKey) ? prev : new Set(prev).add(activeKey)));
  }, [activeKey]);
  const activeRow = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [activeKey, sessions]);

  const groups = useMemo(() => groupSessions(sessions ?? [], filter), [sessions, filter]);
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
          ) : groups.length === 0 ? (
            <li className="text-muted-foreground px-2 py-3 text-xs">
              {filter ? "No matching sessions." : "No Claude Code or Codex sessions found."}
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
                    {g.sessions.map((s) =>
                      renaming === `${s.agent}:${s.id}` ? (
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
                                title={`${agentLabel(s.agent)}: ${s.title}\n${s.id}${s.size !== null ? ` · ${formatBytes(s.size)}` : ""}${s.live ? " · running" : ""}\n${resumeHint(s)}`}
                                className="text-sidebar-foreground/80 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground focus-visible:bg-sidebar-accent/40 flex h-6 w-full items-center gap-1.5 rounded pr-1.5 pl-6 text-[11px] outline-none aria-disabled:opacity-50"
                              >
                                <span
                                  aria-label={agentLabel(s.agent)}
                                  className="relative flex shrink-0"
                                >
                                  <CliAgentIcon agentId={s.agent} size={12} />
                                  {s.live ? (
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
                      ),
                    )}
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
