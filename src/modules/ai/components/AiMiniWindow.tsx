import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { SessionMeta } from "../lib/sessions";
import { getOrCreateChat, useChatStore } from "../store/chatStore";
import { deriveAiState, useAiSessionStatus } from "../lib/sessionStatus";
import { usePlanStore } from "../store/planStore";
import { useSidebarPlacementStore } from "@/modules/extensions";
import { revealColumn } from "@/lib/sectionDrag";
import { AiChatView } from "./AiChat";
import { AiInputBar } from "./AiInputBar";
import { DebugRequestViewer } from "./DebugRequestViewer";
import { ToolsPicker } from "./ToolsPicker";
import { PlanDiffReview } from "./PlanDiffReview";
import { GoalStrip } from "./GoalStrip";
import { TodoStrip } from "./TodoStrip";
import {
  ChevronDown,
  CircleAlert,
  ListFilter,
  PanelLeft,
  PanelRight,
  Sparkles,
  Plus,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

const SUGGESTIONS = [
  {
    label: "Explain the last error",
    hint: "Read the terminal buffer",
    icon: CircleAlert,
    text: "Explain the last error in the terminal.",
  },
  {
    label: "Generate a command",
    hint: "Tell me what you want to do",
    icon: Terminal,
    text: "Give me a command to ",
  },
  {
    label: "Summarize buffer",
    hint: "Recap recent activity",
    icon: ListFilter,
    text: "Summarize what just happened in the terminal.",
  },
];

// Memoised so unrelated parent re-renders (tab open/close, OSC 7 cwd updates,
// ResizeObserver ticks in TabBar) don't re-render the AI sidebar tree.
export const AiSidebarPanel = memo(function AiSidebarPanel({
  dragHandle,
}: {
  /** Grip + collapse controls from the right column's section stack, rendered
   *  in the panel header so the AI panel reorders like any other section. */
  dragHandle?: ReactNode;
}) {
  const closePanel = useChatStore((s) => s.closePanel);
  const sessionId = useChatStore((s) => s.activeSessionId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        closePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePanel]);

  return (
    <div
      data-ai-sidebar
      className={cn(
        "border-border/60 bg-background tedi-glass-panel relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border",
        "text-[12px]",
      )}
    >
      <div
        aria-hidden
        className="from-foreground/[0.03] pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b to-transparent"
      />
      {sessionId ? (
        <Body sessionId={sessionId} onClose={closePanel} dragHandle={dragHandle} />
      ) : (
        <EmptyShell onClose={closePanel} dragHandle={dragHandle} />
      )}
      <PlanDiffReview />
    </div>
  );
});

/**
 * One AI chat as a workspace PANE, bound to an explicit session instead of the
 * globally active one - which is what lets several chats be open at once, in
 * splits and on the canvas. Deduped per session by `openAiPane`.
 *
 * Clicking anywhere in the pane makes its chat the active one, so the composer
 * follows the pane you are working in.
 */
export const AiPanePanel = memo(function AiPanePanel({ sessionId }: { sessionId: string }) {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const known = useChatStore((s) => s.sessions.some((x) => x.id === sessionId));
  const live = sessionId === activeSessionId;

  if (!known) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-[11px]">
        This chat is no longer in your history.
      </div>
    );
  }
  return (
    <div
      data-ai-pane
      onMouseDownCapture={() => {
        if (!live) switchSession(sessionId);
        // Looking at a chat is what clears its `done` badge, exactly as
        // focusing a terminal clears its agent's.
        useAiSessionStatus.getState().acknowledge(sessionId);
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden text-[12px]"
    >
      <Body sessionId={sessionId} surface="pane" live={live} />
    </div>
  );
});

function Body({
  sessionId,
  onClose,
  dragHandle,
  surface = "sidebar",
  live = true,
}: {
  sessionId: string;
  onClose?: () => void;
  dragHandle?: ReactNode;
  /** `pane` drops the panel header: a pane frame already draws one, with the
   *  same icon, the chat's name and a close button. */
  surface?: "sidebar" | "pane";
  /**
   * Whether this view owns the composer. The AI runtime has ONE active session -
   * the composer, `agentMeta`, plan mode and tool approvals are all keyed to it
   * (see `chatStore`), and background sessions keep streaming into their own
   * transcript regardless. So every pane renders its own conversation live, but
   * only the active one can be typed into; clicking a pane makes it active.
   */
  live?: boolean;
}) {
  const focusInput = useChatStore((s) => s.focusInput);
  const switchSession = useChatStore((s) => s.switchSession);

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  useReportAiState(sessionId, helpers.status, helpers.messages);

  return (
    <>
      {surface === "sidebar" ? (
        <Header onClose={onClose ?? (() => {})} dragHandle={dragHandle} />
      ) : null}

      <PlanModeStrip />

      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
            <AiChatView
              messages={helpers.messages}
              status={helpers.status}
              error={helpers.error}
              clearError={helpers.clearError}
              addToolApprovalResponse={helpers.addToolApprovalResponse}
            />
          </div>
        )}
      </div>

      <GoalStrip sessionId={sessionId} />
      <TodoStrip sessionId={sessionId} />

      {live ? (
        <AiInputBar messages={helpers.messages} />
      ) : (
        // Not the active chat, so the composer belongs to another view. Say so
        // and offer the one click that fixes it, rather than showing an input
        // that would send somewhere else.
        <button
          type="button"
          onClick={() => switchSession(sessionId)}
          className="border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40 shrink-0 border-t px-3 py-2 text-left text-[11px]"
        >
          Click to make this the active chat
        </button>
      )}
    </>
  );
}

/**
 * Publish this chat's run state for the Board, the tab chip and the pane icon.
 *
 * The approval scan is the same one `AgentRunBridge` does, but that bridge is
 * mounted once for the ACTIVE session, so it cannot speak for a chat sitting in
 * another pane - which is the entire reason panes needed their own reporter.
 */
function useReportAiState(sessionId: string, status: string, messages: UIMessage[]): void {
  const report = useAiSessionStatus((s) => s.report);
  const forget = useAiSessionStatus((s) => s.forget);
  const approvals = useMemo(() => {
    let n = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts) {
        if ((part as { state?: string }).state === "approval-requested") n++;
      }
    }
    return n;
  }, [messages]);
  // Remembered across renders so a turn ending can be told from a chat that was
  // already quiet: only the working -> quiet EDGE earns `done`.
  const wasWorking = useRef(false);
  useEffect(() => {
    const busy = status === "submitted" || status === "streaming";
    const next = deriveAiState(
      status as "submitted" | "streaming" | "ready" | "error",
      approvals,
      wasWorking.current,
    );
    wasWorking.current = busy;
    report(sessionId, next);
  }, [sessionId, status, approvals, report]);
  useEffect(() => () => forget(sessionId), [sessionId, forget]);
}

function PlanModeStrip() {
  const active = usePlanStore((s) => s.active);
  const queueLen = usePlanStore((s) => s.queue.length);
  const disable = usePlanStore((s) => s.disable);
  if (!active) return null;
  return (
    <div className="border-border/40 bg-muted/40 flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
      <span className="bg-icon-working size-1.5 shrink-0 rounded-full" />
      <span className="text-foreground text-[11px] font-medium">Plan mode</span>
      <span className="text-muted-foreground text-[11px]">
        {queueLen > 0 ? `· ${queueLen} queued` : "· no edits queued"}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => disable()}
        className="text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
      >
        Exit
      </button>
    </div>
  );
}

function EmptyShell({ onClose, dragHandle }: { onClose: () => void; dragHandle?: ReactNode }) {
  return (
    <>
      <Header onClose={onClose} dragHandle={dragHandle} />
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-[11px]">
        Loading sessions…
      </div>
    </>
  );
}

function Header({ onClose, dragHandle }: { onClose: () => void; dragHandle?: ReactNode }) {
  return (
    // Flat, like every other panel header: grip, icon, title, divider, actions.
    // It used to be a `justify-between` pair of nested divs with `px-0` and its
    // own pl-1/pr-2 patches, which made it the one header in either column that
    // did not line up with its neighbours - and buried the actions two levels
    // deep, where the shared "minimized = label row" rule could not reach them.
    // The named ai-header container it also carried had no consumers; the shared
    // header class is a container in its own right now. (Spelled out rather than
    // written as the class: Tailwind scans comments too, and the literal was
    // enough to keep emitting the dead utility after the class itself was gone.)
    <div className="tedi-panel-header relative">
      {dragHandle}
      <Sparkles size={13} strokeWidth={2} className="text-muted-foreground shrink-0" />
      <SessionPicker />
      <span className="tedi-header-divider" aria-hidden />
      <ToolsPicker />
      <span className="tedi-header-optional flex items-center">
        <DebugRequestViewer />
      </span>
      <AiDockButton />
      <IconTooltip label="Close (Esc)" side="bottom">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onClose}
          className={cn(DESTRUCTIVE_ACTION, "size-6")}
          aria-label="Close (Esc)"
        >
          <X size={13} strokeWidth={2} />
        </Button>
      </IconTooltip>
    </div>
  );
}

/**
 * Sends the AI panel to the other column. The placement store IS the answer to
 * "which side am I on" (the panel is only ever mounted in one), so this needs no
 * prop drilled down from the column that rendered it. Same pair of calls the
 * section stack's cross-column drag makes, via `app/lib/sectionDock`.
 */
function AiDockButton() {
  const column = useSidebarPlacementStore((s) => s.placement.ai) ?? "right";
  const toRight = column === "left";
  return (
    <IconTooltip label={toRight ? "Move to right panel" : "Move to left sidebar"} side="bottom">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={() => {
          // Ask the destination to show itself first: it may be minimized shut,
          // and the panel would otherwise move somewhere invisible.
          revealColumn(toRight ? "right" : "left");
          if (toRight) useSidebarPlacementStore.getState().moveRight("ai");
          else useSidebarPlacementStore.getState().moveLeft("ai");
        }}
        className="text-muted-foreground hover:text-foreground size-6 rounded"
        aria-label={toRight ? "Move AI to the right panel" : "Move AI to the left sidebar"}
      >
        {toRight ? (
          <PanelRight size={13} strokeWidth={2} />
        ) : (
          <PanelLeft size={13} strokeWidth={2} />
        )}
      </Button>
    </IconTooltip>
  );
}

function SessionPicker() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  // Sessions are still loading. Returning null used to leave the header with no
  // title AND no flex-1 slot, so the whole action cluster slid left for a beat.
  if (!active)
    return (
      <span className="text-foreground/80 min-w-0 flex-1 truncate text-xs font-medium">AI</span>
    );

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // The AI panel's session name IS its title, so it wears the same
              // type as every other header's (`text-xs`, `text-foreground/80`)
              // rather than the smaller muted style it had, and takes the same
              // `flex-1` slot. It stays a button: switching session is what you
              // click the title for.
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-1 px-1 py-1",
                "text-foreground/80 text-xs font-medium transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
              )}
              aria-label="Switch session"
            >
              <span className="truncate">{active.title || "New chat"}</span>
              <ChevronDown size={10} strokeWidth={2} className="shrink-0 opacity-70" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Switch session</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        alignOffset={0}
        collisionPadding={8}
        className="max-w-[calc(var(--radix-popper-available-width)-8px)] min-w-56"
      >
        <DropdownMenuItem onSelect={() => newSession()} className="gap-2 text-xs">
          <Plus size={12} strokeWidth={2} />
          New session
        </DropdownMenuItem>
        {sorted.length > 0 ? <DropdownMenuSeparator /> : null}
        {sorted.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={() => switchSession(s.id)}
            onDelete={() => deleteSession(s.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Skip dismiss if the trash icon was clicked; handled below.
        const target = e.target as HTMLElement | null;
        if (target?.closest("[data-session-delete]")) {
          e.preventDefault();
          return;
        }
        onSelect();
      }}
      className={cn(
        "group flex items-center justify-between gap-2 text-xs",
        active && "bg-accent/40",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{session.title || "New chat"}</span>
      <IconTooltip label="Delete session" side="right">
        <button
          type="button"
          data-session-delete
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete session"
          className={cn(
            DESTRUCTIVE_ACTION,
            "cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100",
          )}
        >
          <Trash2 size={11} strokeWidth={2} />
        </button>
      </IconTooltip>
    </DropdownMenuItem>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    // Scrolls instead of bleeding: the AI panel now shares the right column
    // with other sections, so it is routinely shorter than this content. The
    // inner `min-h-full` is what keeps `justify-center` from pushing the top of
    // an overflowing column out of reach.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center gap-6 px-8 py-10 text-center">
        <img src="/icon.png" alt="TEDI" className="size-14 opacity-90" />
        <div className="space-y-1.5">
          <p className="text-[14px] font-semibold tracking-tight">Ask TEDI anything</p>
          <p className="text-muted-foreground max-w-[18rem] text-[11.5px] leading-relaxed">
            TEDI sees the active terminal: cwd, recent commands, and output.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2.5">
          {SUGGESTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => onPick(s.text)}
                className={cn(
                  "group bg-card/70 border-border flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left",
                  "hover:bg-muted/50 hover:text-foreground transition-colors",
                )}
              >
                <div className="bg-muted/70 text-muted-foreground group-hover:bg-foreground/5 group-hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors">
                  <Icon size={13} strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-[12px] font-medium">{s.label}</div>
                  <div className="text-muted-foreground text-[10.5px]">{s.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
