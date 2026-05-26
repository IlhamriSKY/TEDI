import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { AiMagicIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useEffect } from "react";

type Props = {
  x: number;
  y: number;
  onAsk: () => void;
  onDismiss: () => void;
};

const W = 168;
const H = 34;
const GAP = 10;

export function SelectionAskAi({ x, y, onAsk, onDismiss }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const top = Math.max(8, y - H - GAP);
  const left = Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8));

  return (
    <motion.div
      data-selection-ask-ai
      initial={{ opacity: 0, y: 6, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.94 }}
      transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
      style={{ top, left, width: W, height: H }}
      className="fixed z-50"
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary/45 relative flex h-full w-full cursor-pointer items-center justify-between gap-2 rounded-full px-3 text-xs font-medium shadow-md ring-1 ring-foreground/10 transition-colors duration-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="flex items-center gap-1.5">
          <HugeiconsIcon icon={AiMagicIcon} size={14} strokeWidth={2} className="shrink-0" />
          <span className="truncate font-semibold tracking-tight whitespace-nowrap">Ask TEDI</span>
        </span>
        <KbdGroup>
          <Kbd className="bg-primary-foreground/15 text-primary-foreground h-5 min-w-fit rounded-md px-1.5 text-[10px] font-semibold">
            {fmtShortcut(MOD_KEY, "L")}
          </Kbd>
        </KbdGroup>
      </button>
    </motion.div>
  );
}
