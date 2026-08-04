import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

export type ToastVariant = "default" | "success" | "info" | "warning" | "error";

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
  icon?: ReactNode;
};

const listeners = new Set<(t: ToastItem) => void>();
let nextId = 1;

/** Errors stay up longer - they carry the text actually worth reading. */
const DEFAULT_MS = 4000;
const ERROR_MS = 6000;
/** Anything past this drops off instead of walling the whole corner. */
const MAX_VISIBLE = 5;
/** Must match the leave animation duration below. */
const LEAVE_MS = 160;

export function toast(
  message: string,
  options?: {
    variant?: ToastVariant;
    durationMs?: number;
    /**
     * Replaces the variant's generic glyph, for a toast whose subject has a
     * mark of its own - an agent's vendor logo on "Claude Code finished" says
     * WHICH of six running agents wants you far faster than the message text
     * does. The variant still owns every colour, so the card reads the same.
     * Build it with `createElement` from a non-JSX caller.
     */
    icon?: ReactNode;
  },
) {
  const variant = options?.variant ?? "default";
  const item: ToastItem = {
    id: nextId++,
    message,
    variant,
    durationMs: options?.durationMs ?? (variant === "error" ? ERROR_MS : DEFAULT_MS),
    icon: options?.icon,
  };
  for (const l of listeners) l(item);
}

/**
 * One shell for every variant - same shape, same spacing, same shadow - so a
 * stack of mixed toasts reads as one thing. The variant is carried by colour
 * across the whole card: a tinted surface, a matching border, the icon and the
 * countdown bar.
 *
 * The surface is a `color-mix` against `--popover` rather than a flat alpha:
 * the tint then sits on the popover surface in both themes (and under glass)
 * instead of letting whatever is behind the toast wash through it. Full class
 * strings, never built from pieces, so Tailwind's scanner still sees them.
 */
const VARIANTS: Record<
  ToastVariant,
  { Icon: LucideIcon; fg: string; surface: string; border: string; bar: string }
> = {
  default: {
    Icon: Bell,
    fg: "text-muted-foreground",
    surface: "bg-popover",
    border: "border-border/70",
    bar: "bg-muted-foreground/60",
  },
  success: {
    Icon: CircleCheck,
    fg: "text-diff-added",
    surface: "bg-[color-mix(in_oklab,var(--tedi-diff-added)_14%,var(--popover))]",
    border: "border-diff-added/35",
    bar: "bg-diff-added",
  },
  info: {
    Icon: Info,
    fg: "text-info",
    surface: "bg-[color-mix(in_oklab,var(--tedi-info)_14%,var(--popover))]",
    border: "border-info/35",
    bar: "bg-info",
  },
  warning: {
    Icon: TriangleAlert,
    fg: "text-icon-working",
    surface: "bg-[color-mix(in_oklab,var(--tedi-icon-working)_14%,var(--popover))]",
    border: "border-icon-working/35",
    bar: "bg-icon-working",
  },
  error: {
    Icon: CircleAlert,
    fg: "text-destructive",
    surface: "bg-[color-mix(in_oklab,var(--destructive)_14%,var(--popover))]",
    border: "border-destructive/35",
    bar: "bg-destructive",
  },
};

function ToastCard({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  const { Icon, fg, surface, border, bar } = VARIANTS[item.variant];
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  // Time left on the auto-dismiss clock. Hovering banks the remainder so a long
  // error can be read (and its X reached) without the toast vanishing mid-move;
  // the countdown bar freezes on the same hover, so the two never drift.
  const left = useRef(item.durationMs);

  useEffect(() => {
    if (leaving || paused) return;
    const startedAt = Date.now();
    const t = window.setTimeout(() => setLeaving(true), left.current);
    return () => {
      window.clearTimeout(t);
      left.current -= Date.now() - startedAt;
    };
  }, [leaving, paused]);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => onDone(item.id), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving, item.id, onDone]);

  return (
    <div
      // Errors interrupt (role=alert); everything else waits its turn.
      role={item.variant === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        "group text-popover-foreground pointer-events-auto relative flex items-start gap-2.5",
        "overflow-hidden border py-2.5 pr-1.5 pl-2.5 text-[12px] shadow-lg",
        surface,
        border,
        leaving
          ? "animate-out fade-out slide-out-to-right-2 duration-150 ease-in"
          : "animate-in fade-in slide-in-from-right-3 duration-200 ease-out",
      )}
    >
      {/* A caller-supplied mark keeps the variant's colour, so a Claude toast is
          still the green "success" card - just with Anthropic's glyph on it. */}
      {item.icon ? (
        <span className={cn("mt-px flex shrink-0 items-center", fg)}>{item.icon}</span>
      ) : (
        <Icon size={14} strokeWidth={2} className={cn("mt-px shrink-0", fg)} />
      )}
      <span className="min-w-0 flex-1 leading-snug break-words">{item.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setLeaving(true)}
        className="text-muted-foreground hover:text-foreground -mt-0.5 shrink-0 cursor-pointer p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X size={12} strokeWidth={2} />
      </button>
      {/* Countdown to auto-dismiss: says how long is left instead of making the
          toast look like it vanished at random. */}
      <span
        aria-hidden
        className={cn("absolute inset-x-0 bottom-0 h-0.5 origin-left", bar)}
        style={{
          animation: `tedi-toast-drain ${item.durationMs}ms linear forwards`,
          animationPlayState: paused || leaving ? "paused" : "running",
        }}
      />
    </div>
  );
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    // Newest on top, so the one expiring is always at the BOTTOM of the stack
    // and the toasts still on screen don't jump up under the pointer.
    const onPush = (t: ToastItem) => setItems((curr) => [t, ...curr].slice(0, MAX_VISIBLE));
    listeners.add(onPush);
    return () => {
      listeners.delete(onPush);
    };
  }, []);

  const remove = useCallback(
    (id: number) => setItems((curr) => curr.filter((x) => x.id !== id)),
    [],
  );

  return (
    <div
      // Top-right stack, above panes/modals. Pointer-events on the container
      // are off so the toast strip never blocks clicks under it; individual
      // toasts re-enable them.
      className="pointer-events-none fixed top-12 right-3 z-[60] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2"
      aria-live="polite"
      // Per-toast, not per-stack: atomic would re-read every toast on screen
      // each time one arrives.
      aria-atomic="false"
    >
      {items.map((t) => (
        <ToastCard key={t.id} item={t} onDone={remove} />
      ))}
    </div>
  );
}
