import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  APPROVAL_MODE_META,
  setApprovalMode,
  setChatMode,
  type ApprovalMode,
} from "@/modules/settings/store";
import type { AgentIconId } from "../lib/agents";
import { APPROVAL_MODE_TONE } from "../lib/approvalModeStyle";
import { useAgentsStore } from "../store/agentsStore";
import {
  Check,
  ChevronDown,
  Code,
  DraftingCompass,
  MessageCircle,
  Paintbrush,
  Settings,
  ShieldUser,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from "lucide-react";

const APPROVAL_MODE_ORDER: ApprovalMode[] = ["ask", "semi", "yolo"];

const ICONS: Record<AgentIconId, LucideIcon> = {
  coder: Code,
  architect: DraftingCompass,
  reviewer: SquarePen,
  security: ShieldUser,
  designer: Paintbrush,
  spark: Sparkles,
};

export function AgentSwitcher({ isMiniWindow }: { isMiniWindow?: boolean }) {
  // Subscribe to customAgents and activeId so the trigger updates live.
  const customAgents = useAgentsStore((s) => s.customAgents);
  const activeId = useAgentsStore((s) => s.activeId);
  const setActiveId = useAgentsStore((s) => s.setActiveId);
  const approvalMode = usePreferencesStore((s) => s.approvalMode);
  const chatMode = usePreferencesStore((s) => s.chatMode);

  const list = useAgentsStore.getState().all();
  void customAgents; // keep the store subscription alive

  const active = list.find((a) => a.id === activeId) ?? list[0];
  const builtIn = list.filter((a) => a.builtIn);
  const custom = list.filter((a) => !a.builtIn);
  // Chat mode takes over the trigger rather than adding a second chip: it turns
  // off the tools AND the agent prompt, so showing the agent name would name
  // something that is not running this turn.
  const ActiveIcon = chatMode ? MessageCircle : (ICONS[active.icon] ?? Sparkles);

  const agentTooltip = chatMode
    ? `Chat mode: no tools, no project context · Agent: ${active.name}`
    : `Agent: ${active.name} · Approval: ${APPROVAL_MODE_META[approvalMode].label}`;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              variant="outline"
              aria-label={agentTooltip}
              className={cn(
                !isMiniWindow
                  ? "border-border/60 bg-card text-muted-foreground hover:border-border flex h-6 max-w-28 min-w-0 items-center gap-1 rounded-md border px-1.5 text-[10.5px] transition-colors"
                  : "mr-1 text-xs",
                !isMiniWindow && TOOLBAR_HOVER,
              )}
            >
              <ActiveIcon size={11} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{chatMode ? "Chat" : active.name}</span>
              <ChevronDown size={10} strokeWidth={2} className="shrink-0 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{agentTooltip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-60">
        <div className="text-muted-foreground px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide uppercase">
          Built-in
        </div>
        {builtIn.map((a) => {
          const Icon = ICONS[a.icon] ?? Sparkles;
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => setActiveId(a.id)}
              className={cn(
                "flex items-start gap-2 pr-2 text-[12px]",
                a.id === activeId && "bg-accent/40",
              )}
            >
              <Icon
                size={13}
                strokeWidth={2}
                className={cn(
                  "mt-0.5",
                  a.id === activeId ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{a.name}</span>
                <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                  {a.description}
                </span>
              </span>
              {a.id === activeId ? (
                <Check size={12} strokeWidth={2} className="text-foreground mt-0.5 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {custom.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="text-muted-foreground px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide uppercase">
              Custom
            </div>
            {custom.map((a) => {
              const Icon = ICONS[a.icon] ?? Sparkles;
              return (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => setActiveId(a.id)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    a.id === activeId && "bg-accent/40",
                  )}
                >
                  <Icon size={13} strokeWidth={2} className="text-muted-foreground mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{a.name}</span>
                    {a.description ? (
                      <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                        {a.description}
                      </span>
                    ) : null}
                  </span>
                  {a.id === activeId ? (
                    <Check size={12} strokeWidth={2} className="text-foreground mt-0.5 shrink-0" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void setChatMode(!chatMode)}
          className={cn("flex items-start gap-2 text-[12px]", chatMode && "bg-accent/40")}
        >
          <MessageCircle
            size={13}
            strokeWidth={2}
            className={cn("mt-0.5", chatMode ? "text-foreground" : "text-muted-foreground")}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>Chat mode</span>
            <span className="text-muted-foreground text-[10.5px]">
              No tools, no project context, no agent prompt
            </span>
          </span>
          {chatMode ? (
            <Check size={12} strokeWidth={2} className="text-foreground mt-0.5 shrink-0" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="text-muted-foreground px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide uppercase">
          Approval mode
        </div>
        {APPROVAL_MODE_ORDER.map((m) => {
          const meta = APPROVAL_MODE_META[m];
          return (
            <DropdownMenuItem
              key={`approval-${m}`}
              onSelect={() => void setApprovalMode(m)}
              className={cn(
                "flex items-start gap-2 text-[12px]",
                m === approvalMode && "bg-accent/40",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("font-medium", APPROVAL_MODE_TONE[m])}>{meta.label}</span>
                <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                  {meta.description}
                </span>
              </span>
              {m === approvalMode ? (
                <Check
                  size={12}
                  strokeWidth={2}
                  className={cn("mt-0.5 shrink-0", APPROVAL_MODE_TONE[m])}
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("agents")}
          className="text-muted-foreground gap-2 text-[12px]"
        >
          <Settings size={12} strokeWidth={2} />
          Manage agents…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ICONS as AGENT_ICONS };
