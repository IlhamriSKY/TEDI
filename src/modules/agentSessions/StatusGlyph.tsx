import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { aiCliStateColorClass, type AiCliState } from "@/modules/terminal/lib/aiCliStatus";
import { AlarmClock, Circle, CircleAlert } from "lucide-react";

/** An agent's state, or a tab put away off the strip, which is a state of its own. */
export type RowState = AiCliState | "snoozed";

const STATE_WORD: Record<RowState, string> = {
  blocking: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
  snoozed: "Snoozed",
};

/**
 * Round, as svgs: globals.css squares every element's border-radius, and a square
 * ring reads as a checkbox. A row shows its state as this and the colour of its
 * agent's icon, with no word on screen; the word is for a screen reader and the
 * tooltip.
 */
export function StatusGlyph({ state }: { state: RowState }) {
  const box = cn(
    "flex w-3.5 shrink-0 justify-center",
    state === "snoozed" ? "text-muted-foreground" : aiCliStateColorClass(state),
  );
  const glyph =
    state === "working" ? (
      <Spinner aria-hidden role="presentation" className="size-3" />
    ) : state === "blocking" ? (
      <CircleAlert size={13} strokeWidth={2.25} />
    ) : state === "done" ? (
      <Circle size={10} fill="currentColor" strokeWidth={0} />
    ) : state === "snoozed" ? (
      <AlarmClock size={12} strokeWidth={2} />
    ) : (
      <Circle size={10} strokeWidth={2.5} />
    );
  return (
    <span role="img" aria-label={STATE_WORD[state]} className={box}>
      {glyph}
    </span>
  );
}
