import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { formatElapsed, useElapsedSince } from "../lib/elapsed";
import { useChatStore, type AgentRunStatus } from "../store/chatStore";
import { CircleAlert, ShieldUser } from "lucide-react";

type Props = {
  onClick: () => void;
};

export function AgentStatusPill({ onClick }: Props) {
  const meta = useChatStore(
    useShallow((s) => ({
      status: s.agentMeta.status,
      approvalsPending: s.agentMeta.approvalsPending,
      error: s.agentMeta.error,
    })),
  );
  const panelOpen = useChatStore((s) => s.panelOpen);
  const isRunning = meta.status === "thinking" || meta.status === "streaming";
  const elapsed = useElapsedSince(isRunning);

  // Approval-pending and error always surface here. A plain run surfaces only
  // while the AI panel is CLOSED - with it open the chat's own indicator says
  // the same thing, but with it closed the app was silent about a turn that
  // could run for minutes.
  const isCritical = meta.status === "awaiting-approval" || meta.status === "error";
  if (!isCritical && !(isRunning && !panelOpen)) return null;

  const { tone, icon, label } = isCritical
    ? describe(meta)
    : {
        tone: "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60",
        icon: <Spinner className="size-3" />,
        label: "AI running",
      };

  return (
    <AnimatePresence mode="wait">
      <IconTooltip label="Open AI log" side="top">
        <motion.button
          // Elapsed is deliberately NOT in the key: it changes every second and
          // would re-mount (and re-animate) the pill on every tick.
          key={`${meta.status}:${label}`}
          type="button"
          onClick={onClick}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          aria-label="Open AI log"
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[11px] transition-colors",
            tone,
          )}
        >
          {icon}
          <span className="max-w-[180px] truncate">{label}</span>
          {isRunning && elapsed >= 1000 ? (
            <span className="font-mono tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
          ) : null}
        </motion.button>
      </IconTooltip>
    </AnimatePresence>
  );
}

function describe(meta: {
  status: AgentRunStatus;
  approvalsPending: number;
  error: string | null;
}): {
  tone: string;
  icon: React.ReactNode;
  label: string;
} {
  if (meta.status === "awaiting-approval") {
    return {
      tone: "border-icon-working/40 bg-icon-working/10 text-icon-working hover:bg-icon-working/15",
      icon: <ShieldUser size={12} strokeWidth={1.75} />,
      label:
        meta.approvalsPending > 1 ? `${meta.approvalsPending} approvals needed` : "Approval needed",
    };
  }
  // Only "error" reaches here; caller filters out thinking/streaming/idle.
  return {
    tone: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
    icon: <CircleAlert size={12} strokeWidth={1.75} />,
    label: meta.error ?? "Error",
  };
}
