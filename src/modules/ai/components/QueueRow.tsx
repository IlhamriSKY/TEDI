import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Cancel01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";

export function QueueRow({
  queue,
  onRemove,
}: {
  queue: { id: string; text: string }[];
  onRemove: (id: string) => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <HugeiconsIcon
        icon={Clock01Icon}
        size={10}
        strokeWidth={2}
        className="text-muted-foreground shrink-0"
      />
      <AnimatePresence initial={false}>
        {queue.map((q) => (
          <Tooltip key={q.id}>
            <TooltipTrigger asChild>
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                className="group border-icon-working/30 bg-icon-working/10 flex max-w-60 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
              >
                <span className="text-foreground/90 truncate">{q.text}</span>
                <button
                  type="button"
                  onClick={() => onRemove(q.id)}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive ml-0.5 cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Remove from queue"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                </button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top">{q.text}</TooltipContent>
          </Tooltip>
        ))}
      </AnimatePresence>
    </div>
  );
}
