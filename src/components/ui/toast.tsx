import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export type ToastVariant = "default" | "warning" | "error";

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
};

const listeners = new Set<(t: ToastItem) => void>();
let nextId = 1;

export function toast(
  message: string,
  options?: { variant?: ToastVariant; durationMs?: number },
) {
  const item: ToastItem = {
    id: nextId++,
    message,
    variant: options?.variant ?? "default",
    durationMs: options?.durationMs ?? 3200,
  };
  for (const l of listeners) l(item);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onPush = (t: ToastItem) => {
      setItems((curr) => [...curr, t]);
      window.setTimeout(() => {
        setItems((curr) => curr.filter((x) => x.id !== t.id));
      }, t.durationMs);
    };
    listeners.add(onPush);
    return () => {
      listeners.delete(onPush);
    };
  }, []);

  const dismiss = (id: number) =>
    setItems((curr) => curr.filter((x) => x.id !== id));

  return (
    <div
      // Top-right stack, above panes/modals. Pointer-events on the container
      // are off so the toast strip never blocks clicks under it; individual
      // toasts re-enable them.
      className="pointer-events-none fixed top-12 right-3 z-[60] flex w-72 flex-col gap-1.5"
      aria-live="polite"
      aria-atomic="true"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            // Square/boxy minimal — `rounded-md` matches the tab strip's
            // existing button/group radii. Subtle border + popover bg keeps
            // it visually quiet against any underlying pane.
            "pointer-events-auto flex items-start gap-2 rounded-md border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-md ring-1 ring-foreground/5 animate-in fade-in slide-in-from-top-1 duration-150 dark:ring-foreground/10",
            t.variant === "warning" &&
              "border-amber-500/50 text-amber-700 dark:text-amber-300",
            t.variant === "error" &&
              "border-destructive/50 text-destructive",
            t.variant === "default" && "border-border/70",
          )}
        >
          <span className="min-w-0 flex-1 leading-snug">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
