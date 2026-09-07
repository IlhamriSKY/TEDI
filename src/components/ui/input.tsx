import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "bg-input/50 file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring aria-invalid:border-destructive dark:aria-invalid:border-destructive/60 h-9 w-full min-w-0 rounded-3xl border border-transparent px-3 py-1 text-base transition-[color,background-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Number field with the app's own stepper.
 *
 * The native spin buttons are hidden on purpose. They only appear on hover, they
 * size themselves to the browser rather than to the field, and they draw a
 * square grey column that fights the pill every other control in this app is -
 * so a number row never matched the string row next to it. The replacement is
 * always visible, scales with whatever height the caller sets, and uses the
 * muted/foreground hover pair the rest of the chrome uses.
 *
 * `className` lands on the input, like every other call site expects; the
 * wrapper only positions the buttons over it.
 *
 * ponytail: `type="number"` sanitizes its own value, so mid-typing "10." reads
 * back as "" and only the browser's bad-input buffer keeps it on screen. Fine
 * for the integer settings this has (ports, minutes) and it buys native
 * ArrowUp/ArrowDown for free; move to `type="text"` + `inputMode="decimal"` and
 * hand-rolled arrow keys if a decimal-step caller ever misbehaves.
 */
function NumberInput({
  className,
  value,
  onValueChange,
  step = 1,
  min,
  max,
  disabled,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "value" | "onChange" | "step" | "min" | "max"> & {
  /** `""` is an empty field, not zero. */
  value: number | "";
  onValueChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  // Raw text rather than the number itself, so an emptied field stays empty
  // instead of committing `Number("")` - which is 0, and 0 is a real port.
  //
  // The ref is not redundant with the state: several clicks on the same arrow
  // land in ONE React batch, so a second `nudge` reading `text` would step from
  // the base the first one already used, and five fast clicks would move the
  // field by one. The ref is current the moment it is written.
  const [text, setText] = React.useState(value === "" ? "" : String(value));
  const textRef = React.useRef(text);
  const write = (next: string) => {
    textRef.current = next;
    setText(next);
  };

  // Re-synced from the prop only when the two actually disagree - the
  // render-time pattern rather than an effect.
  const lastValue = React.useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    const shown = textRef.current;
    if ((shown === "" ? "" : Number(shown)) !== value) write(value === "" ? "" : String(value));
  }

  const nudge = (dir: 1 | -1) => {
    const shown = textRef.current;
    const base = shown === "" ? (min ?? 0) : Number(shown);
    if (!Number.isFinite(base)) return;
    // Round to the step's own precision: 0.1 + 0.2 lands on 0.30000000000000004.
    const decimals = (String(step).split(".")[1] ?? "").length;
    const next = Math.min(
      max ?? Number.POSITIVE_INFINITY,
      Math.max(min ?? Number.NEGATIVE_INFINITY, Number((base + dir * step).toFixed(decimals))),
    );
    write(String(next));
    onValueChange(next);
  };

  return (
    // `w-fit` is load-bearing: a column flex parent (every `Field`) stretches
    // its children across, which would leave the buttons pinned to the row's
    // right edge instead of to the field's. An explicit width beats `stretch`.
    <div className="relative inline-flex w-fit">
      <Input
        {...props}
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          write(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) onValueChange(n);
        }}
        className={cn(
          "[appearance:textfield] pr-7 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          className,
        )}
      />
      <div className="absolute inset-y-0.5 right-1.5 flex flex-col justify-center">
        {STEPS.map(({ dir, Icon, label }) => (
          <button
            key={label}
            type="button"
            // Out of the tab order: the field itself already steps on ArrowUp
            // and ArrowDown, so these would only add two stops per number row.
            tabIndex={-1}
            disabled={disabled}
            aria-label={label}
            // Keep the caret where it is - a plain click would move focus to the
            // button and a second click would not repeat against the same field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => nudge(dir)}
            className="text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 flex h-1/2 w-4 cursor-pointer items-center justify-center rounded-sm transition-colors disabled:pointer-events-none disabled:opacity-50"
          >
            <Icon size={11} strokeWidth={2.5} />
          </button>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  { dir: 1 as const, Icon: ChevronUp, label: "Increase" },
  { dir: -1 as const, Icon: ChevronDown, label: "Decrease" },
];

export { Input, NumberInput };
