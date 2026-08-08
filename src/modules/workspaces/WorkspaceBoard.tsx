import { cn } from "@/lib/utils";
import { EntryIcon } from "@/modules/tabs/components/EntryIcon";
import { buildEntries, type PaneEntry } from "@/modules/tabs/lib/entries";
import type { Tab } from "@/modules/tabs";
import { useGitBranch } from "@/modules/scm/branch";
import { useSshHosts } from "@/modules/ssh/connections";
import type { SshStatus } from "@/modules/ssh/status";
import {
  aiCliStateColorClass,
  toolDisplayName,
  type AiCliState,
  type AiCliStatus,
} from "@/modules/terminal/lib/aiCliStatus";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
import { todoProgress, useAgentTodos } from "@/modules/terminal/lib/agentTodos";
import { ChevronRight, Folder, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Kanban of the workspace's terminals, grouped by what their AI CLI is doing.
 * The body of a `board` PANE LEAF, so it wears the ordinary pane header - drag
 * handle, close, split, the same one every terminal and editor has - rather
 * than a second hand-rolled copy of it. Mounted from `PaneTreeView`.
 *
 * Not a new data source: it runs the LIVE tab tree through `buildEntries`, the
 * same builder the tab strip and the Workspaces list use, so a pane's icon,
 * name, ordinal and status colour here cannot drift from those two. That also
 * means it needs no props about which workspace it belongs to - a board leaf
 * only ever exists inside the workspace it was opened in, and switching
 * workspaces takes the whole tab strip with it.
 *
 * It draws no chrome of its own: the pane frame already supplies the border and
 * the header, so a second border here would read as a box inside a box.
 */

/** Left to right is the arc of one agent turn: waiting for work, doing it,
 *  stopped for approval, finished and wanting attention. So the two columns
 *  that actually want the user are the two nearest the end. */
const COLUMNS: { state: AiCliState; label: string }[] = [
  { state: "idle", label: "Idle" },
  { state: "working", label: "Working" },
  { state: "blocking", label: "Blocked" },
  { state: "done", label: "Done" },
];

export function WorkspaceBoard({
  tabs,
  sshStatuses,
  aiCliStatuses,
  onFocusLeaf,
  mirrorToFloat,
}: {
  tabs: Tab[];
  sshStatuses?: Map<number, SshStatus>;
  aiCliStatuses?: Map<number, AiCliStatus>;
  /** Focus a terminal pane. Same handler the Workspaces list rows use. */
  onFocusLeaf?: (tabId: number, leafId: number) => void;
  /** Called with the current cards whenever they change. The float window has
   *  no tab tree of its own, so the mounted main-window board IS the data
   *  source that feeds it. */
  mirrorToFloat?: (cards: PaneEntry[], titles: Record<number, string>) => void;
}) {
  const sshHosts = useSshHosts();
  const titles = useTerminalTitles((s) => s.titles);

  const cards = useMemo(
    () =>
      buildEntries(tabs, sshHosts, sshStatuses, aiCliStatuses).filter(
        (e): e is PaneEntry => e.kind === "pane-leaf" && e.leafKind === "terminal",
      ),
    [tabs, sshHosts, sshStatuses, aiCliStatuses],
  );

  // Push every change to the float window. Keyed on the computed cards, so a
  // status flip or a new terminal reaches the float on the same render it
  // reaches this one.
  useEffect(() => {
    mirrorToFloat?.(cards, titles);
  }, [cards, titles, mirrorToFloat]);

  return <BoardColumns cards={cards} titles={titles} onOpen={onFocusLeaf} />;
}

/**
 * The board itself, given its cards. Split out from the data half so the float
 * window renders THIS, not a lookalike: the float has no tab tree, so it
 * receives the same `PaneEntry` objects over an event and hands them here.
 */
export function BoardColumns({
  cards,
  titles,
  onOpen,
}: {
  cards: PaneEntry[];
  titles: Record<number, string>;
  onOpen?: (tabId: number, leafId: number) => void;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {cards.length === 0 ? (
        <p className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          No terminals open in this workspace.
        </p>
      ) : (
        // Columns scroll as one block on a narrow pane rather than crushing to
        // unreadable widths; the whole board scrolls vertically when a single
        // state collects more terminals than fit.
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="grid min-w-[34rem] grid-cols-4 items-start gap-2">
            {COLUMNS.map((col) => {
              // A terminal with no AI CLI running is idle in the only sense the
              // board has.
              const inCol = cards.filter((c) => (c.aiCliStatus?.state ?? "idle") === col.state);
              return (
                <section key={col.state} className="flex min-w-0 flex-col gap-1.5">
                  <header className="flex items-center gap-1.5 px-0.5">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full bg-current",
                        aiCliStateColorClass(col.state),
                      )}
                    />
                    <span className="text-foreground/80 truncate text-[11px] font-medium">
                      {col.label}
                    </span>
                    <span className="bg-muted/50 text-muted-foreground ml-auto shrink-0 rounded px-1 text-[10px] tabular-nums">
                      {inCol.length}
                    </span>
                  </header>
                  {inCol.length === 0 ? (
                    <p className="border-border/60 text-muted-foreground/50 rounded-md border border-dashed px-2 py-3 text-center text-[10px]">
                      empty
                    </p>
                  ) : (
                    inCol.map((e) => (
                      <BoardCardItem
                        key={e.key}
                        entry={e}
                        title={titles[e.leafId]}
                        onOpen={onOpen}
                      />
                    ))
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCardItem({
  entry: e,
  title,
  onOpen,
}: {
  entry: PaneEntry;
  /** Program-set terminal title (OSC 2), e.g. the agent's current task. */
  title?: string;
  onOpen?: (tabId: number, leafId: number) => void;
}) {
  const ai = e.aiCliStatus;
  // The OSC title repeats the label often enough (a shell that titles itself
  // after its folder) that showing both would just read as a stutter. Same test
  // the Workspaces list row applies.
  const showTitle = !!title && title !== e.label && title !== e.cwd;
  // A remote pane reads its branch over its OWN session, so the answer is the
  // branch on that box rather than on this one; an SSH pane is skipped until
  // its session is up, since asking the local git about a remote path would
  // answer about the wrong machine. Verbatim from the Workspaces list row, and
  // `useGitBranch` de-dupes per (transport, path) so N cards in one repo cost
  // one git call, not N.
  const sshSessionId = e.sshStatus?.kind === "connected" ? e.sshStatus.sessionId : undefined;
  const branch = useGitBranch(
    !e.sshConnectionId || sshSessionId !== undefined ? e.cwd : undefined,
    sshSessionId,
  );
  // The agent's own todo list, read from its store. Only asked for when an AI
  // CLI is actually detected here, so a plain shell never touches the disk.
  const todos = useAgentTodos(e.cwd, !!ai);
  const [todosOpen, setTodosOpen] = useState(false);
  const progress = todoProgress(todos);

  return (
    // A DIV, not a button: the todo disclosure below has to be a real button,
    // and a button inside a button is invalid HTML - React says so at runtime
    // and the inner one swallows the outer's click. So the card is a plain box
    // holding two SIBLING buttons, with the hover lit from the box via `group`.
    <div
      className="border-border bg-card hover:bg-accent hover:text-accent-foreground group/card flex w-full flex-col rounded-md border transition-colors"
      title={e.cwd}
    >
      <button
        type="button"
        onClick={() => onOpen?.(e.tabId, e.leafId)}
        className="focus-visible:ring-ring flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left focus-visible:ring-1 focus-visible:outline-none"
      >
        {/* `EntryIcon` already carries the FIFO ordinal badge and tints itself by
          AI status, so the card adds neither. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <EntryIcon entry={e} />
          <span className="min-w-0 flex-1 truncate text-xs">{e.label}</span>
        </span>
        {ai && (
          <span className="text-muted-foreground truncate text-[10px]">
            {toolDisplayName(ai.tool)}
          </span>
        )}
        {showTitle && (
          <span className="text-muted-foreground/70 truncate text-[10px]">{title}</span>
        )}
        {/* Where it is and what it is on. The label is only the folder's
          basename, so the path is the part that actually disambiguates two
          panes called "src". Absent entirely outside a repository rather than a
          line saying nothing, same as the Workspaces list. */}
        {e.cwd && (
          <span className="text-muted-foreground/70 flex min-w-0 items-center gap-1 text-[10px]">
            <Folder size={9} strokeWidth={2} className="shrink-0" />
            <span className="min-w-0 truncate" dir="rtl">
              {e.cwd}
            </span>
          </span>
        )}
        {branch && (
          <span className="text-muted-foreground/70 flex min-w-0 items-center gap-1 text-[10px]">
            <GitBranch size={9} strokeWidth={2} className="text-icon-branch shrink-0" />
            <span className="min-w-0 truncate">{branch}</span>
          </span>
        )}
      </button>

      {/* The agent's own todo list. Absent entirely when nothing was read - an
          unrecognised CLI, or a Claude Code session that never made one - so a
          card only grows this row when it has something to say. */}
      {progress.total > 0 && (
        <>
          <button
            type="button"
            aria-expanded={todosOpen}
            onClick={() => setTodosOpen((v) => !v)}
            className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring flex w-full items-center gap-1 rounded-b-md px-2 pb-1.5 text-left text-[10px] focus-visible:ring-1 focus-visible:outline-none"
          >
            <ChevronRight
              size={9}
              strokeWidth={2.5}
              className={cn("shrink-0 transition-transform", todosOpen && "rotate-90")}
            />
            <span className="tabular-nums">
              todo {progress.done}/{progress.total}
            </span>
          </button>
          {todosOpen && (
            <ul className="flex flex-col gap-0.5 px-2 pb-1.5">
              {todos.map((t) => (
                <li
                  key={t.id}
                  className={cn(
                    "flex min-w-0 items-start gap-1 text-[10px]",
                    t.status === "completed" && "text-muted-foreground/50 line-through",
                    t.status === "in_progress" && "text-[color:var(--tedi-icon-working)]",
                    t.status === "pending" && "text-muted-foreground/70",
                  )}
                >
                  <span aria-hidden className="shrink-0 leading-4">
                    {t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : "☐"}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{t.subject}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
