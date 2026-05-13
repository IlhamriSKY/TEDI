import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { motion } from "motion/react";
import { useEffect } from "react";

type Props = {
  x: number;
  y: number;
  onAsk: () => void;
  onDismiss: () => void;
};

const W = 156;
const OFFSET = 32;

export function SelectionAskAi({ x, y, onAsk, onDismiss }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const top = Math.max(8, y - OFFSET);
  const left = Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8));

  return (
    <motion.div
      data-selection-ask-ai
      initial={{ opacity: 0, y: 4, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.95 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      style={{ top, left, width: W }}
      className="fixed z-50"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
        className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xl ring-1 ring-black/10 backdrop-blur-md transition-[transform,background-color,box-shadow] hover:-translate-y-px hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        <span className="truncate whitespace-nowrap">Ask TEDI</span>
        <KbdGroup>
          <Kbd className="h-5 min-w-fit rounded-md bg-primary-foreground/14 px-1.5 text-[10px] font-semibold text-primary-foreground">
            {fmtShortcut(MOD_KEY, "L")}
          </Kbd>
        </KbdGroup>
      </button>
    </motion.div>
  );
}
