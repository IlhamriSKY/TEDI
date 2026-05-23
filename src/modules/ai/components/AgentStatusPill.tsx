import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { AlertCircleIcon, ShieldUserIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore, type AgentRunStatus } from "../store/chatStore";

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

  // Surface only approval-pending and error in the status bar; thinking/streaming
  // already shows in the chat panel.
  const isCritical = meta.status === "awaiting-approval" || meta.status === "error";
  if (!isCritical) return null;

  const { tone, icon, label } = describe(meta);

  return (
    <AnimatePresence mode="wait">
      <IconTooltip label="Open AI log" side="top">
        <motion.button
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
      tone: "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/15",
      icon: <HugeiconsIcon icon={ShieldUserIcon} size={12} strokeWidth={1.75} />,
      label:
        meta.approvalsPending > 1 ? `${meta.approvalsPending} approvals needed` : "Approval needed",
    };
  }
  // Only "error" reaches here; caller filters out thinking/streaming/idle.
  return {
    tone: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
    icon: <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.75} />,
    label: meta.error ?? "Error",
  };
}
