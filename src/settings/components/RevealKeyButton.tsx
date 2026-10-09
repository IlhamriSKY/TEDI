import { IconSlash } from "@/components/IconMorph";
import { Eye } from "lucide-react";

/**
 * Reveal / hide toggle pinned inside the right edge of a secret input. Shared by
 * every provider key form so the copies cannot drift apart. The hidden state is
 * the eye plus a slash drawing in (`IconSlash`), not a jump to `EyeOff`.
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
      <IconSlash icon={Eye} slashed={reveal} size={12} strokeWidth={1.75} />
    </button>
  );
}
