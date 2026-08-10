import { cn } from "@/lib/utils";
import { Eye } from "lucide-react";

/**
 * Reveal / hide toggle pinned inside the right edge of a secret input. Shared by
 * every provider key form so the copies cannot drift apart.
 *
 * The hidden state is a constant `Eye` plus a slash that draws itself in from
 * the top-left corner, rather than a swap to `EyeOff`: lucide redraws the eye
 * shape in `EyeOff`, so swapping jumps, while a slash over an unchanged eye is
 * one continuous motion and reads as the same "hidden" picture. Geometry is
 * lucide's own at size 12 / strokeWidth 1.75 - the slash spans (2,2) to (22,22)
 * of the 24 viewBox, so 14.14px long and 0.875px thick at this size, and
 * `origin-left` puts both the rotation and the draw-in at its top-left end.
 */
export function RevealKeyButton({ reveal, onToggle }: { reveal: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer transition-colors"
      aria-label={reveal ? "Hide key" : "Show key"}
    >
      <span className="relative flex size-3 items-center justify-center">
        <Eye size={12} strokeWidth={1.75} />
        <span
          aria-hidden
          className={cn(
            "absolute top-[0.56px] left-[1px] h-[0.875px] w-[14.14px] origin-left rotate-45 rounded-full bg-current transition-[scale] duration-200 ease-out motion-reduce:transition-none",
            !reveal && "scale-x-0",
          )}
        />
      </span>
    </button>
  );
}
