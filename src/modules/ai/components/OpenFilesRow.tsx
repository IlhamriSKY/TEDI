import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import type { OpenEditorFile } from "../store/chatStore";

export function OpenFilesRow({
  files,
  onAttach,
}: {
  files: OpenEditorFile[];
  onAttach: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <AnimatePresence initial={false}>
        {files.map((f) => (
          <Tooltip key={`open-${f.path}`}>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                onClick={() => onAttach(f.path)}
                aria-label={`Attach ${f.name}`}
                className={cn(
                  "group border-border/60 text-muted-foreground flex cursor-pointer items-center gap-1 rounded-md border border-dashed bg-transparent px-1.5 py-0.5 text-[11px]",
                  "hover:border-foreground/40 hover:bg-card hover:text-foreground transition-colors",
                )}
              >
                <HugeiconsIcon
                  icon={PlusSignIcon}
                  size={10}
                  strokeWidth={2}
                  className="opacity-70 transition-opacity group-hover:opacity-100"
                />
                <span className="max-w-35 truncate">{f.name}</span>
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">{`Click to attach ${f.path}`}</TooltipContent>
          </Tooltip>
        ))}
      </AnimatePresence>
    </div>
  );
}
