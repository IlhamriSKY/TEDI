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
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { APPROVAL_MODE_META, setApprovalMode, type ApprovalMode } from "@/modules/settings/store";
import {
  AbsoluteIcon,
  ArrowDown01Icon,
  CodeIcon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  Settings01Icon,
  ShieldUserIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentIconId } from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";

const APPROVAL_MODE_ORDER: ApprovalMode[] = ["ask", "semi", "yolo"];
const APPROVAL_MODE_DOT: Record<ApprovalMode, string> = {
  ask: "bg-amber-500",
  semi: "bg-sky-500",
  yolo: "bg-emerald-500",
};

const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  spark: SparklesIcon,
};

export function AgentSwitcher({ isMiniWindow }: { isMiniWindow?: boolean }) {
  // Subscribe to customAgents + activeId so the trigger updates live.
  const customAgents = useAgentsStore((s) => s.customAgents);
  const activeId = useAgentsStore((s) => s.activeId);
  const setActiveId = useAgentsStore((s) => s.setActiveId);
  const approvalMode = usePreferencesStore((s) => s.approvalMode);

  const list = useAgentsStore.getState().all();
  void customAgents; // keeps the store subscription alive

  const active = list.find((a) => a.id === activeId) ?? list[0];
  const builtIn = list.filter((a) => a.builtIn);
  const custom = list.filter((a) => !a.builtIn);
  const ActiveIcon = ICONS[active.icon] ?? SparklesIcon;

  const agentTooltip = `Agent: ${active.name} · Approval: ${APPROVAL_MODE_META[approvalMode].label}`;

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
                  ? "border-border/60 bg-card text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10.5px] transition-colors"
                  : "mr-1 text-xs",
              )}
            >
              <HugeiconsIcon icon={ActiveIcon} size={11} strokeWidth={1.75} />
              <span className="max-w-[7rem] truncate">{active.name}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                strokeWidth={2}
                className="opacity-70"
              />
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
          const Icon = ICONS[a.icon] ?? SparklesIcon;
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => setActiveId(a.id)}
              className={cn(
                "flex items-start gap-2 pr-2 text-[12px]",
                a.id === activeId && "bg-accent/40",
              )}
            >
              <HugeiconsIcon
                icon={Icon}
                size={13}
                strokeWidth={1.75}
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
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className="text-foreground mt-0.5 shrink-0"
                />
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
              const Icon = ICONS[a.icon] ?? SparklesIcon;
              return (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => setActiveId(a.id)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    a.id === activeId && "bg-accent/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={Icon}
                    size={13}
                    strokeWidth={1.75}
                    className="text-muted-foreground mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{a.name}</span>
                    {a.description ? (
                      <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                        {a.description}
                      </span>
                    ) : null}
                  </span>
                  {a.id === activeId ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={12}
                      strokeWidth={2}
                      className="text-foreground mt-0.5 shrink-0"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
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
              <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", APPROVAL_MODE_DOT[m])} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{meta.label}</span>
                <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                  {meta.description}
                </span>
              </span>
              {m === approvalMode ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className="text-foreground mt-0.5 shrink-0"
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
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Manage agents…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ICONS as AGENT_ICONS };
