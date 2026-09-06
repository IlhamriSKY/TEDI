import { IconTooltip } from "@/components/ui/icon-tooltip";
import { PixelActivity } from "@/components/ui/pixel-activity";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { formatElapsed, useElapsedSince } from "../lib/elapsed";
import { useIsMaxEffort } from "../lib/useMaxEffort";
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
  const isMax = useIsMaxEffort();

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
        // The pixel strip, not a spinner: this pill sits inches from the AI
        // usage meters and the memory chart, which are the same 4px cells. A
        // spinning circle beside them was the odd material out.
        //
        // Two rows, not the chat indicator's four: a 4x4 block is 22px and this
        // pill is 24px tall including its border, so the square would have
        // touched both edges. Two rows is 10px, which is the height the 12px
        // glyphs in the other pill states occupy.
        icon: (
          <PixelActivity rows={2} cols={4} variant={isMax ? "max" : "default"} label="AI running" />
        ),
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
      icon: <ShieldUser size={12} strokeWidth={2} />,
      label:
        meta.approvalsPending > 1 ? `${meta.approvalsPending} approvals needed` : "Approval needed",
    };
  }
  // Only "error" reaches here; caller filters out thinking/streaming/idle.
  return {
    tone: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
    icon: <CircleAlert size={12} strokeWidth={2} />,
    label: meta.error ?? "Error",
  };
}
