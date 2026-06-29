import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  FilterIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useEffect, useMemo } from "react";
import type { SessionMeta } from "../lib/sessions";
import { getOrCreateChat, useChatStore } from "../store/chatStore";
import { usePlanStore } from "../store/planStore";
import { AiChatView } from "./AiChat";
import { AiInputBar } from "./AiInputBar";
import { PlanDiffReview } from "./PlanDiffReview";
import { TodoStrip } from "./TodoStrip";

const SUGGESTIONS = [
  {
    label: "Explain the last error",
    hint: "Read the terminal buffer",
    icon: AlertCircleIcon,
    text: "Explain the last error in the terminal.",
  },
  {
    label: "Generate a command",
    hint: "Tell me what you want to do",
    icon: TerminalIcon,
    text: "Give me a command to ",
  },
  {
    label: "Summarize buffer",
    hint: "Recap recent activity",
    icon: FilterIcon,
    text: "Summarize what just happened in the terminal.",
  },
];

// Memoised so unrelated parent re-renders (tab open/close, OSC 7 cwd updates,
// ResizeObserver ticks in TabBar) don't re-render the AI sidebar tree.
export const AiSidebarPanel = memo(function AiSidebarPanel() {
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
        "border-border/60 bg-card/60 tedi-glass-panel relative flex h-full min-h-0 flex-col overflow-hidden border-l",
        "text-[12px]",
      )}
    >
      <div
        aria-hidden
        className="from-foreground/[0.03] pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b to-transparent"
      />
      {sessionId ? (
        <Body sessionId={sessionId} onClose={closePanel} />
      ) : (
        <EmptyShell onClose={closePanel} />
      )}
      <PlanDiffReview />
    </div>
  );
});

// Back-compat alias for older imports.
export { AiSidebarPanel as AiMiniWindow };

function Body({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const focusInput = useChatStore((s) => s.focusInput);
  const step = useChatStore((s) => s.agentMeta.step);

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  const isBusy = helpers.status === "submitted" || helpers.status === "streaming";

  return (
    <>
      <Header step={step} isBusy={isBusy} onClose={onClose} />

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
              stop={helpers.stop}
            />
          </div>
        )}
      </div>

      <TodoStrip sessionId={sessionId} />

      <AiInputBar messages={helpers.messages} />
    </>
  );
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

function EmptyShell({ onClose }: { onClose: () => void }) {
  return (
    <>
      <Header step={null} isBusy={false} onClose={onClose} />
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-[11px]">
        Loading sessions…
      </div>
    </>
  );
}

function Header({
  step,
  isBusy,
  onClose,
}: {
  step: string | null;
  isBusy: boolean;
  onClose: () => void;
}) {
  return (
    <div className="border-border/60 relative flex h-11 shrink-0 items-center justify-between gap-1 border-b px-0">
      <div className="flex min-w-0 flex-1 items-center">
        <SessionPicker />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isBusy ? (
          <span className="text-muted-foreground flex min-w-0 items-center gap-1 pr-1 text-[10px]">
            <Spinner className="size-2.5" />
            <span className="max-w-32 truncate">{step ?? "Thinking…"}</span>
          </span>
        ) : null}
        <IconTooltip label="Close (Esc)" side="top">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onClose}
            className="hover:bg-destructive/10 hover:text-destructive size-7 rounded-none"
            aria-label="Close (Esc)"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      </div>
    </div>
  );
}

function SessionPicker() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  if (!active) return null;

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex max-w-48 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1",
                "text-muted-foreground text-[11px] transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
              )}
              aria-label="Switch session"
            >
              <span className="truncate">{active.title || "New chat"}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                strokeWidth={2}
                className="opacity-70"
              />
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
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
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
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
        </button>
      </IconTooltip>
    </DropdownMenuItem>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-10 text-center">
      <img src="/icon.png" alt="TEDI" className="size-14 opacity-90" />
      <div className="space-y-1.5">
        <p className="text-[14px] font-semibold tracking-tight">Ask TEDI anything</p>
        <p className="text-muted-foreground max-w-[18rem] text-[11.5px] leading-relaxed">
          TEDI sees the active terminal: cwd, recent commands, and output.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        {SUGGESTIONS.map((s) => (
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
              <HugeiconsIcon icon={s.icon} size={13} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-foreground text-[12px] font-medium">{s.label}</div>
              <div className="text-muted-foreground text-[10.5px]">{s.hint}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
